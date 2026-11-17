"""Wbudowany katalog książek dla dzieci (`data/KatalogBajek.json`) – port `StarterCatalog.swift`.

Pozycje trafiają do bazy jako „nie mam” z datą 2001-01-01, więc są tylko bazą podpowiedzi.
Katalog zasiewa się raz na wersję pliku (`meta('starter_catalog_seeded_version')`);
„Usuń wszystkie dane” tej wersji nie zeruje.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Union

from . import db, polish
from .store import VOLUME_RANGE, Library, name_key
from .textmatch import cleaned_name, nfc

logger = logging.getLogger(__name__)

DEFAULT_CATALOG_PATH = Path(__file__).resolve().parent / "data" / "KatalogBajek.json"


@dataclass(frozen=True)
class Entry:
    title: str
    author: str
    series: Optional[str]
    volume: Optional[int]
    year: Optional[int]


@dataclass(frozen=True)
class Catalog:
    version: int
    name: str
    books: tuple


class CatalogFormatError(ValueError):
    """Plik katalogu ma zły format (brak wymaganego klucza albo zły typ)."""


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _required(obj: dict, key: str, kind: str) -> Any:
    if key not in obj:
        raise CatalogFormatError(f"brak klucza {key!r}")
    value = obj[key]
    if kind == "int" and not _is_int(value):
        raise CatalogFormatError(f"{key!r} nie jest liczbą całkowitą")
    if kind == "str" and not isinstance(value, str):
        raise CatalogFormatError(f"{key!r} nie jest tekstem")
    if kind == "list" and not isinstance(value, list):
        raise CatalogFormatError(f"{key!r} nie jest listą")
    return value


def _optional(obj: dict, key: str, kind: str) -> Any:
    value = obj.get(key)
    if value is None:
        return None
    if kind == "int" and not _is_int(value):
        raise CatalogFormatError(f"{key!r} nie jest liczbą całkowitą")
    if kind == "str" and not isinstance(value, str):
        raise CatalogFormatError(f"{key!r} nie jest tekstem")
    return value


def parse_catalog(raw: Any) -> Catalog:
    """Ścisłe dekodowanie jak `JSONDecoder` w Swift: brak klucza lub zły typ → błąd całego katalogu."""
    if not isinstance(raw, dict):
        raise CatalogFormatError("katalog nie jest obiektem JSON")
    version = _required(raw, "version", "int")
    name = _required(raw, "name", "str")
    entries = []
    for item in _required(raw, "books", "list"):
        if not isinstance(item, dict):
            raise CatalogFormatError("pozycja katalogu nie jest obiektem")
        series = _optional(item, "series", "str")
        entries.append(
            Entry(
                title=nfc(_required(item, "title", "str")),
                author=nfc(_required(item, "author", "str")),
                series=nfc(series) if series is not None else None,
                volume=_optional(item, "volume", "int"),
                year=_optional(item, "year", "int"),
            )
        )
    return Catalog(version=version, name=nfc(name), books=tuple(entries))


def load_catalog(path: Union[str, Path, None] = None) -> Optional[Catalog]:
    """Wczytuje katalog; przy braku pliku lub złym formacie zwraca None (katalog niedostępny)."""
    target = Path(path) if path is not None else DEFAULT_CATALOG_PATH
    try:
        with open(target, encoding="utf-8") as f:
            return parse_catalog(json.load(f))
    except FileNotFoundError:
        logger.error("Brak pliku katalogu: %s", target)
    except (OSError, ValueError) as error:
        logger.error("Nie udało się wczytać katalogu %s: %s", target, error)
    return None


def catalog_available(path: Union[str, Path, None] = None) -> bool:
    """Czy katalog da się wczytać (od tego zależy pozycja menu „Uzupełnij katalog bajek dla dzieci”)."""
    return load_catalog(path) is not None


def _key(title: str, author: Optional[str]) -> str:
    return name_key(title) + "|" + (name_key(author) if author is not None else "")


def _import(conn: sqlite3.Connection, catalog: Catalog) -> int:
    """Dodaje brakujące pozycje (porównanie: tytuł + autor) – w trwającej transakcji."""
    library = Library(conn)
    authors = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM author")}
    existing_keys = {
        _key(r["title"], authors.get(r["author_id"]) if r["author_id"] is not None else None)
        for r in conn.execute("SELECT title, author_id FROM book")
    }

    # Serie z tomami różnych autorów (np. „Opowiem ci, mamo”) zakładamy raz, bez autora.
    authors_by_series: dict[str, set[str]] = {}
    for entry in catalog.books:
        if entry.series is not None:
            authors_by_series.setdefault(name_key(entry.series), set()).add(name_key(entry.author))

    added = 0
    for entry in catalog.books:
        key = _key(entry.title, entry.author)
        if key in existing_keys:
            continue
        title = cleaned_name(entry.title)
        if not title:
            logger.warning("Pominięto pozycję katalogu bez tytułu")
            continue
        author_id = library._find_or_create_author(entry.author)
        series_id = None
        if entry.series is not None:
            if len(authors_by_series[name_key(entry.series)]) > 1:
                series_id = library._find_or_create_shared_series(entry.series)
            else:
                series_id = library._find_or_create_series(entry.series, author_id)
        volume = None
        if series_id is not None and entry.volume is not None:
            low, high = VOLUME_RANGE
            volume = entry.volume if low <= entry.volume <= high else None
        conn.execute(
            """INSERT INTO book(title, volume_number, is_owned, notes, added_at, author_id, series_id)
               VALUES (?, ?, 0, '', ?, ?, ?)""",
            (title, volume, db.CATALOG_DATE, author_id, series_id),
        )
        existing_keys.add(key)
        added += 1
    return added


def import_missing(conn: sqlite3.Connection, catalog_path: Union[str, Path, None] = None) -> int:
    """Menu „Uzupełnij katalog bajek dla dzieci”: dodaje brakujące pozycje, zwraca ich liczbę.

    Nie zmienia zapisanej wersji katalogu. Niedostępny katalog → 0 (bez zmian w bazie).
    """
    catalog = load_catalog(catalog_path)
    if catalog is None:
        return 0
    with db.transaction(conn):
        added = _import(conn, catalog)
    logger.info("Uzupełniono katalog bajek: %s", polish.count(added, "book"))
    return added


def seeded_version(conn: sqlite3.Connection) -> int:
    """Wersja katalogu, która była już zasiana (0 = jeszcze nigdy)."""
    try:
        return int(db.get_meta(conn, db.META_CATALOG_VERSION, "0") or 0)
    except ValueError:
        return 0


def seed_if_needed(conn: sqlite3.Connection, catalog_path: Union[str, Path, None] = None) -> int:
    """Przy starcie: dodaje pozycje katalogu, jeśli ta wersja pliku nie była jeszcze zasiana."""
    catalog = load_catalog(catalog_path)
    if catalog is None or seeded_version(conn) >= catalog.version:
        return 0
    with db.transaction(conn):
        added = _import(conn, catalog)
        db.set_meta(conn, db.META_CATALOG_VERSION, catalog.version)
    logger.info("Zasiano katalog bajek w wersji %d: %s", catalog.version, polish.count(added, "book"))
    return added
