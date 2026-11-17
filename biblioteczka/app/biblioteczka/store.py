"""Operacje na danych biblioteczki (port `LibraryStore.swift` i logiki zapisu z edytorów).

Każda publiczna metoda zmieniająca dane działa w jednej transakcji (`db.transaction`), więc zwiększa
numer rewizji. Wyszukiwanie „pierwszego” wpisu idzie w kolejności id (kolejność wstawiania), a tam,
gdzie iOS korzysta z list posortowanych po nazwie – w kolejności `localized_key`.
"""

from __future__ import annotations

import functools
import logging
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

from . import db, textmatch
from .isbn import ISBN
from .textmatch import cleaned_name, clusters, nfc
from .views import (
    author_is_on_shelf,
    localized_key,
    series_is_on_shelf,
    suggested_volume_number,
)

logger = logging.getLogger(__name__)

# Klucze liczone przy każdym przeszukaniu wszystkich wierszy – z pamięcią podręczną.
name_key = functools.lru_cache(maxsize=32768)(textmatch.name_key)
loose_key = functools.lru_cache(maxsize=16384)(textmatch.loose_key)
words_key = functools.lru_cache(maxsize=16384)(textmatch.words_key)

# Zakresy liczb z formularzy i katalogów; wartość spoza zakresu = brak.
VOLUME_RANGE = (1, 999)
YEAR_RANGE = (1000, 2100)
PAGES_RANGE = (1, 9999)
PLANNED_RANGE = (1, 999)

# Białe znaki i znaki nowej linii jak Swift `.whitespacesAndNewlines` (Unicode White_Space).
_WHITESPACE = "".join(
    chr(c)
    for c in [*range(0x09, 0x0E), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B),
              0x2028, 0x2029, 0x202F, 0x205F, 0x3000]
)

_COVER_ID = re.compile(r"[0-9a-f]{40}")


class LibraryError(Exception):
    """Błąd operacji z polskim komunikatem dla użytkownika i kodem dla klienta."""

    def __init__(self, message_pl: str, code: str, status: int = 400) -> None:
        super().__init__(message_pl)
        self.message_pl = message_pl
        self.code = code
        self.status = status


class NotFoundError(LibraryError):
    """Wpis nie istnieje (np. usunięty na innym urządzeniu)."""

    def __init__(self, message_pl: str, code: str = "not_found") -> None:
        super().__init__(message_pl, code, 404)


class ConflictError(LibraryError):
    """Zapis koliduje z istniejącym wpisem (duplikat serii lub autora)."""

    def __init__(self, message_pl: str, code: str = "conflict") -> None:
        super().__init__(message_pl, code, 409)


# --- Odczyt i walidacja wartości z JSON ---


def strip_text(s: str) -> str:
    """Tekst bez białych znaków i nowych linii na początku i na końcu (środek bez zmian), w NFC."""
    return (nfc(s) or "").strip(_WHITESPACE)


def _text(value: Any, label: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise LibraryError(f"Niepoprawna wartość pola „{label}”.", "invalid_field")
    return nfc(value) or ""


def parse_int(value: Any, bounds: tuple[int, int], label: str) -> Optional[int]:
    """Liczba z JSON lub tekstu (same cyfry ASCII); pusta albo spoza zakresu → None."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise LibraryError(f"Niepoprawna wartość pola „{label}”.", "invalid_field")
    if isinstance(value, float):
        if not value.is_integer():
            raise LibraryError(f"Niepoprawna wartość pola „{label}”.", "invalid_field")
        value = int(value)
    if isinstance(value, str):
        text = value.strip(_WHITESPACE)
        if text == "":
            return None
        if not (text.isascii() and text.isdigit()):
            raise LibraryError(f"Niepoprawna wartość pola „{label}”.", "invalid_field")
        value = int(text)
    if not isinstance(value, int):
        raise LibraryError(f"Niepoprawna wartość pola „{label}”.", "invalid_field")
    low, high = bounds
    return value if low <= value <= high else None


def _bool(value: Any, default: bool, label: str) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in ("1", "0", "true", "false"):
        return value.strip().lower() in ("1", "true")
    raise LibraryError(f"Niepoprawna wartość pola „{label}”.", "invalid_field")


def _cover_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str) and _COVER_ID.fullmatch(value):
        return value
    raise LibraryError("Niepoprawny identyfikator okładki.", "invalid_cover")


def normalize_isbn(raw: str) -> Optional[str]:
    """ISBN do zapisu: 13 cyfr, gdy numer jest poprawny, inaczej oczyszczony tekst (albo None)."""
    parsed = ISBN.parse(raw)
    if parsed is not None:
        return parsed.digits
    return cleaned_name(raw) or None


def _id(value: Any, label: str = "id") -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        if isinstance(value, str) and value.isascii() and value.isdigit():
            return int(value)
        raise LibraryError(f"Niepoprawny identyfikator ({label}).", "invalid_id")
    return value


@dataclass(frozen=True)
class Edition:
    """Dane wydania z formularza (po normalizacji)."""

    isbn: Optional[str] = None
    publisher: Optional[str] = None
    year: Optional[int] = None
    pages: Optional[int] = None
    cover_given: bool = False
    cover_id: Optional[str] = None

    @classmethod
    def parse(cls, raw: dict) -> "Edition":
        return cls(
            isbn=normalize_isbn(_text(raw.get("isbn"), "ISBN")),
            publisher=cleaned_name(_text(raw.get("publisher"), "Wydawnictwo")) or None,
            year=parse_int(raw.get("publicationYear"), YEAR_RANGE, "Rok wydania"),
            pages=parse_int(raw.get("pageCount"), PAGES_RANGE, "Liczba stron"),
            cover_given="coverId" in raw,
            cover_id=_cover_id(raw.get("coverId")),
        )


@dataclass(frozen=True)
class BookDraft:
    """Formularz książki (klucze camelCase jak w API)."""

    title: str
    author_name: str
    series_name: str
    volume: Optional[int]
    is_owned: bool
    notes: str
    edition: Edition

    @classmethod
    def parse(cls, raw: Any) -> "BookDraft":
        if not isinstance(raw, dict):
            raise LibraryError("Niepoprawne dane książki.", "invalid_draft")
        title = cleaned_name(_text(raw.get("title"), "Tytuł"))
        if not title:
            raise LibraryError("Podaj tytuł książki.", "title_required")
        return cls(
            title=title,
            author_name=cleaned_name(_text(raw.get("authorName"), "Autor")),
            series_name=cleaned_name(_text(raw.get("seriesName"), "Seria")),
            volume=parse_int(raw.get("volumeNumber"), VOLUME_RANGE, "Tom"),
            is_owned=_bool(raw.get("isOwned"), True, "Status"),
            notes=strip_text(_text(raw.get("notes"), "Notatki")),
            edition=Edition.parse(raw),
        )


def _first(items: Iterable[sqlite3.Row], predicate: Callable[[sqlite3.Row], bool]) -> Optional[sqlite3.Row]:
    for item in items:
        if predicate(item):
            return item
    return None


_BOOK_GONE = "Nie ma już tej książki – mogła zostać usunięta na innym urządzeniu."
_SERIES_GONE = "Nie ma już tej serii – mogła zostać usunięta na innym urządzeniu."
_AUTHOR_GONE = "Nie ma już tego autora – mógł zostać usunięty na innym urządzeniu."


class Library:
    """Dane biblioteczki na jednym połączeniu SQLite."""

    def __init__(self, conn: sqlite3.Connection, now: Optional[Callable[[], str]] = None) -> None:
        self.conn = conn
        self._now = now or db.utc_now

    # --- Pomocnicze odczyty ---

    def _tx(self):
        return db.transaction(self.conn)

    def _row(self, table: str, row_id: Any) -> Optional[sqlite3.Row]:
        return self.conn.execute(f"SELECT * FROM {table} WHERE id = ?", (_id(row_id),)).fetchone()

    def _require(self, table: str, row_id: Any, message: str, code: str) -> sqlite3.Row:
        row = self._row(table, row_id)
        if row is None:
            raise NotFoundError(message, code)
        return row

    def _require_book(self, book_id: Any) -> sqlite3.Row:
        return self._require("book", book_id, _BOOK_GONE, "book_not_found")

    def _require_series(self, series_id: Any) -> sqlite3.Row:
        return self._require("series", series_id, _SERIES_GONE, "series_not_found")

    def _require_author(self, author_id: Any) -> sqlite3.Row:
        return self._require("author", author_id, _AUTHOR_GONE, "author_not_found")

    def _all(self, table: str) -> list[sqlite3.Row]:
        return self.conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()

    def _books_where(self, column: str, value: int) -> list[sqlite3.Row]:
        return self.conn.execute(f"SELECT * FROM book WHERE {column} = ? ORDER BY id", (value,)).fetchall()

    def _series_of_author(self, author_id: int) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM series WHERE author_id = ? ORDER BY id", (author_id,)).fetchall()

    def _authors_by_name(self) -> list[sqlite3.Row]:
        """Autorzy w kolejności nazw – jak `@Query(sort: \\Author.name)` w edytorze książki."""
        return sorted(self._all("author"), key=lambda a: (localized_key(a["name"]), a["id"]))

    def _series_by_name(self) -> list[sqlite3.Row]:
        return sorted(self._all("series"), key=lambda s: (localized_key(s["name"]), s["id"]))

    def _author_is_on_shelf(self, author_id: int) -> bool:
        return author_is_on_shelf(self._books_where("author_id", author_id), self._series_of_author(author_id))

    def _series_suggested_volume(self, series: sqlite3.Row) -> int:
        return suggested_volume_number(series["planned_volume_count"], self._books_where("series_id", series["id"]))

    # --- Autorzy ---

    def _existing_author(self, name: str, excluding: Optional[int] = None) -> Optional[sqlite3.Row]:
        key = name_key(name)
        if key == "":
            return None
        return _first(self._all("author"), lambda a: a["id"] != excluding and name_key(a["name"]) == key)

    def find_author(self, name: str) -> Optional[sqlite3.Row]:
        """Pierwszy autor o tej samej nazwie (bez wielkości liter i nadmiarowych spacji) albo None."""
        return self._existing_author(_text(name, "Autor"))

    def _find_or_create_author(self, raw: str) -> Optional[int]:
        name = cleaned_name(raw)
        if not name:
            return None
        existing = self._existing_author(name)
        if existing is not None:
            return existing["id"]
        cur = self.conn.execute("INSERT INTO author(name, created_at) VALUES (?, ?)", (name, self._now()))
        return cur.lastrowid

    def find_or_create_author(self, name: str) -> Optional[int]:
        """Istniejący autor o tej nazwie albo nowy; pusta nazwa → None."""
        with self._tx():
            return self._find_or_create_author(_text(name, "Autor"))

    def existing_author_name(self, name: str) -> str:
        """Nazwa autora już zapisanego pod nieco inną postacią („J.K. Rowling” → „J. K. Rowling”)."""
        key = loose_key(name)
        match = _first(self._authors_by_name(), lambda a: loose_key(a["name"]) == key)
        return match["name"] if match is not None else name

    # --- Serie ---

    def _existing_series(
        self, name: str, author_id: Optional[int], excluding: Optional[int] = None
    ) -> Optional[sqlite3.Row]:
        key = name_key(name)
        if key == "":
            return None
        candidates = [s for s in self._all("series") if s["id"] != excluding and name_key(s["name"]) == key]
        if author_id is None:
            return candidates[0] if candidates else None
        return _first(candidates, lambda s: s["author_id"] == author_id) or _first(
            candidates, lambda s: s["author_id"] is None
        )

    def _insert_series(self, name: str, author_id: Optional[int]) -> int:
        cur = self.conn.execute(
            "INSERT INTO series(name, planned_volume_count, notes, created_at, author_id) VALUES (?, NULL, '', ?, ?)",
            (name, self._now(), author_id),
        )
        return cur.lastrowid

    def _find_or_create_series(self, raw: str, author_id: Optional[int]) -> Optional[int]:
        name = cleaned_name(raw)
        if not name:
            return None
        existing = self._existing_series(name, author_id)
        if existing is not None:
            # Serię bez autora przypisujemy autorowi tylko wtedy, gdy nie ma w niej książek innych autorów.
            if existing["author_id"] is None and author_id is not None:
                others = self.conn.execute(
                    "SELECT 1 FROM book WHERE series_id = ? AND author_id IS NOT NULL AND author_id != ? LIMIT 1",
                    (existing["id"], author_id),
                ).fetchone()
                if others is None:
                    self.conn.execute("UPDATE series SET author_id = ? WHERE id = ?", (author_id, existing["id"]))
            return existing["id"]
        return self._insert_series(name, author_id)

    def find_or_create_series(self, name: str, author_id: Optional[int]) -> Optional[int]:
        """Seria tego autora (albo bez autora, którą autor wtedy „przejmuje”) lub nowa; nigdy seria innego autora."""
        with self._tx():
            return self._find_or_create_series(_text(name, "Seria"), None if author_id is None else _id(author_id))

    def _find_or_create_shared_series(self, raw: str) -> Optional[int]:
        name = cleaned_name(raw)
        if not name:
            return None
        existing = self._existing_series(name, None)
        if existing is not None:
            return existing["id"]
        return self._insert_series(name, None)

    def find_or_create_shared_series(self, name: str) -> Optional[int]:
        """Seria wielu autorów: pierwsza o tej nazwie (dowolnego autora) albo nowa bez autora."""
        with self._tx():
            return self._find_or_create_shared_series(_text(name, "Seria"))

    # --- Sprzątanie po przeniesieniu lub usunięciu książek ---

    def _cleanup(self, series_ids: Iterable[Optional[int]] = (), author_ids: Iterable[Optional[int]] = ()) -> None:
        """Usuwa podane serie, jeśli zostały bez książek, i podanych autorów bez książek i serii.

        Wywołujący podaje tylko wpisy, które przed operacją nie były puste – celowo puste zostają.
        """
        authors = {a for a in author_ids if a is not None}
        for series_id in {s for s in series_ids if s is not None}:
            row = self._row("series", series_id)
            if row is None:
                continue
            if self.conn.execute("SELECT 1 FROM book WHERE series_id = ? LIMIT 1", (series_id,)).fetchone() is None:
                self.conn.execute("DELETE FROM series WHERE id = ?", (series_id,))
                if row["author_id"] is not None:
                    authors.add(row["author_id"])
        for author_id in authors:
            has_books = self.conn.execute("SELECT 1 FROM book WHERE author_id = ? LIMIT 1", (author_id,)).fetchone()
            has_series = self.conn.execute("SELECT 1 FROM series WHERE author_id = ? LIMIT 1", (author_id,)).fetchone()
            if has_books is None and has_series is None:
                self.conn.execute("DELETE FROM author WHERE id = ?", (author_id,))

    # --- Książki ---

    def _carried_over_series(
        self, target: Optional[sqlite3.Row], series_name: str, author_id: Optional[int]
    ) -> Optional[int]:
        """Seria, którą książka zabiera ze sobą przy zmianie autora.

        Gdy jedyna książka serii dostaje innego autora, a ten nie ma serii o tej nazwie, iOS założyłby
        nową serię, a stara zostałaby pusta (i po sprzątaniu zniknęłaby razem z liczbą tomów i notatkami).
        Zamiast tego seria przechodzi na nowego autora.
        """
        if target is None or target["series_id"] is None or author_id is None or not series_name:
            return None
        previous = self._row("series", target["series_id"])
        if previous is None or name_key(previous["name"]) != name_key(series_name):
            return None
        if previous["author_id"] is None or previous["author_id"] == author_id:
            return None
        others = self.conn.execute(
            "SELECT 1 FROM book WHERE series_id = ? AND id != ? LIMIT 1", (previous["id"], target["id"])
        ).fetchone()
        if others is not None or self._existing_series(series_name, author_id) is not None:
            return None
        self.conn.execute("UPDATE series SET author_id = ? WHERE id = ?", (author_id, previous["id"]))
        return previous["id"]

    def save_book(self, draft: dict, book_id: Optional[int] = None, adopt_id: Optional[int] = None) -> int:
        """Zapis formularza książki (BookEditorView.save) – zwraca id zapisanej książki.

        `book_id` – edycja istniejącej książki (pełne nadpisanie pól jak w iOS).
        `adopt_id` – zapis do wybranego wpisu „nie mam”/z katalogu zamiast tworzenia duplikatu;
        puste pola formularza zachowują wtedy dane tego wpisu (notatki, wydanie). Okładka – jak
        przy edycji: brak klucza `coverId` zostawia okładkę wpisu, `null` ją usuwa.
        """
        d = BookDraft.parse(draft)
        with self._tx():
            target: Optional[sqlite3.Row] = None
            adopting = False
            if book_id is not None:
                target = self._require_book(book_id)
            elif adopt_id is not None:
                target = self._row("book", adopt_id)
                adopting = target is not None
                if target is None:
                    logger.info("Przejmowany wpis %s już nie istnieje – zapisuję nową książkę", adopt_id)
            previous_series = (
                self._row("series", target["series_id"])
                if target is not None and target["series_id"] is not None
                else None
            )

            author_id = self._find_or_create_author(d.author_name)
            series_id = self._carried_over_series(target, d.series_name, author_id)
            if series_id is None:
                series_id = self._find_or_create_series(d.series_name, author_id)
            if author_id is None and series_id is not None:
                author_id = self._row("series", series_id)["author_id"]
            volume = d.volume if series_id is not None else None
            now = self._now()
            e = d.edition

            if target is None:
                cur = self.conn.execute(
                    """INSERT INTO book(title, volume_number, is_owned, notes, added_at, author_id, series_id,
                                        isbn, publisher, publication_year, page_count, cover_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (d.title, volume, int(d.is_owned), d.notes, now, author_id, series_id,
                     e.isbn, e.publisher, e.year, e.pages, e.cover_id),
                )
                return cur.lastrowid

            added_at = now if d.is_owned and not target["is_owned"] else target["added_at"]
            if adopting:
                notes = d.notes or target["notes"]
                isbn = e.isbn if e.isbn is not None else target["isbn"]
                publisher = e.publisher if e.publisher is not None else target["publisher"]
                year = e.year if e.year is not None else target["publication_year"]
                pages = e.pages if e.pages is not None else target["page_count"]
                # Okładka jak przy edycji: formularz dostaje okładkę wpisu, więc `coverId: null`
                # oznacza „Usuń okładkę”, a brak klucza – bez zmian.
                cover = e.cover_id if e.cover_given else target["cover_id"]
            else:
                notes, isbn, publisher, year, pages = d.notes, e.isbn, e.publisher, e.year, e.pages
                cover = e.cover_id if e.cover_given else target["cover_id"]

            self.conn.execute(
                """UPDATE book SET title = ?, volume_number = ?, is_owned = ?, notes = ?, added_at = ?,
                                   author_id = ?, series_id = ?, isbn = ?, publisher = ?,
                                   publication_year = ?, page_count = ?, cover_id = ?
                   WHERE id = ?""",
                (d.title, volume, int(d.is_owned), notes, added_at, author_id, series_id,
                 isbn, publisher, year, pages, cover, target["id"]),
            )
            previous_authors = [target["author_id"]]
            if previous_series is not None:
                previous_authors.append(previous_series["author_id"])
            self._cleanup(
                series_ids=[target["series_id"]] if target["series_id"] != series_id else [],
                author_ids=[a for a in previous_authors if a != author_id],
            )
            return target["id"]

    def set_owned(self, book_id: int, owned: bool) -> None:
        """„Mam” / „Nie mam”. Gdy książka trafia na półkę, data dodania staje się bieżąca."""
        owned = _bool(owned, True, "Status")
        with self._tx():
            book = self._require_book(book_id)
            added_at = self._now() if owned and not book["is_owned"] else book["added_at"]
            self.conn.execute(
                "UPDATE book SET is_owned = ?, added_at = ? WHERE id = ?", (int(owned), added_at, book["id"])
            )

    def complete_book(self, book_id: int, edition: dict, mark_owned: bool) -> None:
        """Uzupełnia tylko puste dane wydania istniejącej książki; opcjonalnie oznacza ją jako posiadaną.

        Odpowiada przyciskom „Mam ją – oznacz istniejącą jako posiadaną” i
        „Zapisz okładkę i dane wydania w mojej książce” – reszta formularza jest pomijana.
        """
        if not isinstance(edition, dict):
            raise LibraryError("Niepoprawne dane wydania.", "invalid_draft")
        e = Edition.parse(edition)
        mark_owned = _bool(mark_owned, False, "Status")
        with self._tx():
            book = self._require_book(book_id)
            is_owned = bool(book["is_owned"]) or mark_owned
            added_at = self._now() if mark_owned and not book["is_owned"] else book["added_at"]
            self.conn.execute(
                """UPDATE book SET is_owned = ?, added_at = ?, isbn = ?, publisher = ?,
                                   publication_year = ?, page_count = ?, cover_id = ?
                   WHERE id = ?""",
                (
                    int(is_owned),
                    added_at,
                    book["isbn"] if book["isbn"] is not None else e.isbn,
                    book["publisher"] if book["publisher"] is not None else e.publisher,
                    book["publication_year"] if book["publication_year"] is not None else e.year,
                    book["page_count"] if book["page_count"] is not None else e.pages,
                    book["cover_id"] if book["cover_id"] is not None else e.cover_id,
                    book["id"],
                ),
            )

    def delete_book(self, book_id: int) -> None:
        """Usuwa książkę; seria i autor, którzy zostali przez to puści, znikają razem z nią."""
        with self._tx():
            book = self._require_book(book_id)
            self.conn.execute("DELETE FROM book WHERE id = ?", (book["id"],))
            self._cleanup(series_ids=[book["series_id"]], author_ids=[book["author_id"]])

    # --- Serie (edytor) ---

    def save_series(self, draft: dict, series_id: Optional[int] = None) -> int:
        """Zapis formularza serii (SeriesEditorView.save); duplikat blokuje zapis (409)."""
        if not isinstance(draft, dict):
            raise LibraryError("Niepoprawne dane serii.", "invalid_draft")
        name = cleaned_name(_text(draft.get("name"), "Nazwa serii"))
        if not name:
            raise LibraryError("Podaj nazwę serii.", "name_required")
        author_name = cleaned_name(_text(draft.get("authorName"), "Autor"))
        planned = parse_int(draft.get("plannedVolumeCount"), PLANNED_RANGE, "Liczba tomów")
        notes = strip_text(_text(draft.get("notes"), "Notatki"))

        with self._tx():
            target = self._require_series(series_id) if series_id is not None else None
            key, author_key = name_key(name), name_key(author_name)
            authors = {a["id"]: a for a in self._all("author")}
            duplicate = _first(
                self._all("series"),
                lambda s: (target is None or s["id"] != target["id"])
                and name_key(s["name"]) == key
                and (
                    author_key == ""
                    or s["author_id"] is None
                    or name_key(authors[s["author_id"]]["name"]) == author_key
                ),
            )
            if duplicate is not None:
                if series_is_on_shelf(self._books_where("series_id", duplicate["id"])):
                    raise ConflictError("Taka seria jest już w biblioteczce.", "series_exists")
                raise ConflictError(
                    "Ta seria jest już w katalogu podpowiedzi. Dodaj książkę z tej serii, a seria pojawi się na liście.",
                    "series_in_catalog",
                )

            author_id = self._find_or_create_author(author_name)
            if target is None:
                cur = self.conn.execute(
                    "INSERT INTO series(name, planned_volume_count, notes, created_at, author_id) VALUES (?, ?, ?, ?, ?)",
                    (name, planned, notes, self._now(), author_id),
                )
                return cur.lastrowid

            previous = target["author_id"]
            # Książki serii podążają za zmianą autora (także do „brak autora”).
            self.conn.execute(
                "UPDATE book SET author_id = ? WHERE series_id = ? AND (author_id IS NULL OR author_id IS ?)",
                (author_id, target["id"], previous),
            )
            self.conn.execute(
                "UPDATE series SET name = ?, author_id = ?, planned_volume_count = ?, notes = ? WHERE id = ?",
                (name, author_id, planned, notes, target["id"]),
            )
            if previous != author_id:
                self._cleanup(author_ids=[previous])
            return target["id"]

    def delete_series(self, series_id: int, with_books: bool) -> None:
        """Usuwa serię; bez `with_books` jej książki zostają jako pojedyncze tytuły (z numerem tomu)."""
        with_books = _bool(with_books, False, "withBooks")
        with self._tx():
            series = self._require_series(series_id)
            book_authors = [b["author_id"] for b in self._books_where("series_id", series["id"])]
            if with_books:
                self.conn.execute("DELETE FROM book WHERE series_id = ?", (series["id"],))
            self.conn.execute("DELETE FROM series WHERE id = ?", (series["id"],))
            if with_books:
                self._cleanup(author_ids=book_authors)

    # --- Autorzy (edytor) ---

    def save_author(self, name: str, author_id: Optional[int] = None) -> dict:
        """Nowy autor albo zmiana nazwy; w edycji zgodność nazwy z innym autorem łączy oba wpisy."""
        clean = cleaned_name(_text(name, "Imię i nazwisko"))
        if not clean:
            raise LibraryError("Podaj imię i nazwisko autora.", "name_required")
        with self._tx():
            if author_id is None:
                match = self._existing_author(clean)
                if match is not None:
                    if self._author_is_on_shelf(match["id"]):
                        raise ConflictError("Ten autor jest już w biblioteczce.", "author_exists")
                    raise ConflictError(
                        "Ten autor jest już w katalogu podpowiedzi – pojawi się na liście, gdy dodasz jego książkę.",
                        "author_in_catalog",
                    )
                cur = self.conn.execute("INSERT INTO author(name, created_at) VALUES (?, ?)", (clean, self._now()))
                return {"id": cur.lastrowid, "mergedInto": None}

            author = self._require_author(author_id)
            match = self._existing_author(clean, excluding=author["id"])
            if match is not None:
                self._merge(author["id"], match["id"])
                return {"id": match["id"], "mergedInto": match["id"]}
            self.conn.execute("UPDATE author SET name = ? WHERE id = ?", (clean, author["id"]))
            return {"id": author["id"], "mergedInto": None}

    def _merge(self, source_id: int, target_id: int) -> None:
        self.conn.execute("UPDATE book SET author_id = ? WHERE author_id = ?", (target_id, source_id))
        self.conn.execute("UPDATE series SET author_id = ? WHERE author_id = ?", (target_id, source_id))
        self.conn.execute("DELETE FROM author WHERE id = ?", (source_id,))

    def merge_authors(self, source_id: int, target_id: int) -> None:
        """Przenosi książki i serie autora `source_id` do `target_id` i usuwa `source_id` (serie się nie łączą)."""
        with self._tx():
            source = self._require_author(source_id)
            target = self._require_author(target_id)
            if source["id"] == target["id"]:
                raise LibraryError("Nie można połączyć autora z nim samym.", "merge_same")
            self._merge(source["id"], target["id"])

    def delete_author(self, author_id: int, with_books: bool) -> None:
        """Usuwa autora; z `with_books` także wszystkie jego książki (również w cudzych seriach) i jego serie."""
        with_books = _bool(with_books, False, "withBooks")
        with self._tx():
            author = self._require_author(author_id)
            touched_series: list[Optional[int]] = []
            if with_books:
                touched_series = [b["series_id"] for b in self._books_where("author_id", author["id"])]
                self.conn.execute("DELETE FROM book WHERE author_id = ?", (author["id"],))
                self.conn.execute("DELETE FROM series WHERE author_id = ?", (author["id"],))
            self.conn.execute("DELETE FROM author WHERE id = ?", (author["id"],))
            if with_books:
                self._cleanup(series_ids=touched_series)

    def delete_all(self) -> None:
        """Usuwa wszystkie książki, serie i autorów (wersja zasianego katalogu zostaje)."""
        with self._tx():
            self.conn.execute("DELETE FROM book")
            self.conn.execute("DELETE FROM series")
            self.conn.execute("DELETE FROM author")

    def referenced_cover_ids(self) -> set[str]:
        """Identyfikatory okładek używanych przez książki (reszta plików to śmieci do sprzątnięcia)."""
        rows = self.conn.execute("SELECT DISTINCT cover_id FROM book WHERE cover_id IS NOT NULL")
        return {r[0] for r in rows}

    # --- Dane znalezione po ISBN (BookEditorView.apply) ---

    def _library_book(self, title: str, author: str, excluding: Optional[int]) -> Optional[sqlite3.Row]:
        """Książka z bazy o tym tytule i autorze; przy zgodnym autorze wystarczy wspólny początek tytułu
        (co najmniej dwa słowa): „Bon czy ton” ~ „Bon czy ton. Savoir-vivre dla dzieci”."""
        title_key = name_key(title)
        if title_key == "":
            return None
        author_key = loose_key(author)
        authors = {a["id"]: a for a in self._all("author")}
        candidates = [b for b in self._all("book") if b["id"] != excluding]

        def other_author_key(book: sqlite3.Row) -> Optional[str]:
            return None if book["author_id"] is None else loose_key(authors[book["author_id"]]["name"])

        exact = _first(
            candidates,
            lambda b: name_key(b["title"]) == title_key
            and (author_key == "" or b["author_id"] is None or other_author_key(b) == author_key),
        )
        if exact is not None or author_key == "":
            return exact

        words = words_key(title)

        def shares_prefix(b: sqlite3.Row) -> bool:
            if b["author_id"] is None or other_author_key(b) != author_key:
                return False
            other_words = words_key(b["title"])
            shorter = words if len(clusters(words)) < len(clusters(other_words)) else other_words
            if len(shorter.split()) < 2:
                return False
            return other_words.startswith(words + " ") or words.startswith(other_words + " ")

        return _first(candidates, shares_prefix)

    def _suggested_series(self, info: dict, title: str, matching_author: Optional[sqlite3.Row]) -> Optional[str]:
        """Seria dla znalezionej książki: seria autora zawarta w tytule, seria z katalogu już obecna w bazie
        albo nowa – tylko gdy to na pewno cykl, a nie seria wydawnicza."""
        title_words = f" {words_key(title)} "
        if matching_author is not None:
            own = _first(
                self._series_of_author(matching_author["id"]),
                lambda s: words_key(s["name"]) != "" and f" {words_key(s['name'])} " in title_words,
            )
            if own is not None:
                return own["name"]
        name = cleaned_name(_text(info.get("seriesName"), "Seria"))
        if not name:
            return None
        key = loose_key(name)
        existing = _first(self._series_by_name(), lambda s: loose_key(s["name"]) == key)
        if existing is not None:
            return existing["name"]
        return name if info.get("isSeriesCertain") is True else None

    def resolve_lookup(
        self, info: dict, editing_book_id: Optional[int] = None, *, form: Optional[dict] = None
    ) -> dict:
        """Część `apply(info)` zależna od bazy. Klient nakłada wynik na formularz.

        Zwraca `libraryBookId`/`libraryBookOwned` (książka z bazy pasująca tytułem i autorem – tylko dla
        nowej książki; nieposiadaną klient przejmuje), `seriesName`/`volumeNumber` (przy dopasowanej książce –
        jej seria i tom, inaczej podpowiedziana seria albo None = nie zmieniaj), `title` i `authorName`
        (wartości formularza po zastosowaniu danych) oraz `isbnBookIds` (książki z tym samym ISBN).

        `form` (opcjonalnie: `title`, `authorName`, `seriesName`) – bieżący formularz; domyślnie pusty
        dla nowej książki, a dla edytowanej jej zapisane wartości.
        """
        if not isinstance(info, dict):
            raise LibraryError("Niepoprawne dane książki.", "invalid_draft")
        editing = self._require_book(editing_book_id) if editing_book_id is not None else None
        is_new = editing is None

        if editing is not None:
            title = editing["title"]
            author_row = self._row("author", editing["author_id"]) if editing["author_id"] is not None else None
            series_row = self._row("series", editing["series_id"]) if editing["series_id"] is not None else None
            author = author_row["name"] if author_row is not None else ""
            series_name = series_row["name"] if series_row is not None else ""
        else:
            title = author = series_name = ""
        if form is not None:
            title = _text(form.get("title", title), "Tytuł")
            author = _text(form.get("authorName", author), "Autor")
            series_name = _text(form.get("seriesName", series_name), "Seria")

        info_title = cleaned_name(_text(info.get("title"), "Tytuł"))
        info_author = cleaned_name(_text(info.get("authorName"), "Autor"))
        if info_title and (is_new or cleaned_name(title) == ""):
            title = info_title
        # Pusty autor ze źródła nigdy nie czyści tego, co wpisał użytkownik.
        if info_author and (is_new or cleaned_name(author) == ""):
            author = self.existing_author_name(info_author)

        result: dict[str, Any] = {
            "libraryBookId": None,
            "libraryBookOwned": None,
            "seriesName": None,
            "volumeNumber": None,
            "title": title,
            "authorName": author,
            "isbnBookIds": [],
        }

        entry = self._library_book(title, author, None) if is_new else None
        if entry is not None:
            entry_author = self._row("author", entry["author_id"]) if entry["author_id"] is not None else None
            entry_series = self._row("series", entry["series_id"]) if entry["series_id"] is not None else None
            result["libraryBookId"] = entry["id"]
            result["libraryBookOwned"] = bool(entry["is_owned"])
            result["title"] = entry["title"]
            if entry_author is not None:
                result["authorName"] = entry_author["name"]
            result["seriesName"] = entry_series["name"] if entry_series is not None else None
            result["volumeNumber"] = entry["volume_number"] or None
        elif is_new or cleaned_name(series_name) == "":
            author_key = name_key(author)
            matching_author = (
                _first(self._authors_by_name(), lambda a: name_key(a["name"]) == author_key) if author_key else None
            )
            suggested = self._suggested_series(info, title, matching_author)
            if suggested is not None:
                key = name_key(suggested)
                existing = _first(self._series_by_name(), lambda s: name_key(s["name"]) == key)
                volume = parse_int(info.get("volumeNumber"), VOLUME_RANGE, "Tom")
                if volume is None:
                    volume = self._series_suggested_volume(existing) if existing is not None else 0
                result["seriesName"] = suggested
                result["volumeNumber"] = volume or None

        isbn_text = _text(info.get("isbn"), "ISBN")
        parsed = ISBN.parse(isbn_text) if isbn_text else None
        if parsed is not None:
            rows = self.conn.execute("SELECT id FROM book WHERE isbn = ? ORDER BY id", (parsed.digits,))
            result["isbnBookIds"] = [r["id"] for r in rows]
        return result
