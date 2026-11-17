"""Eksport biblioteczki do CSV (bajt w bajt jak `CSVFile.makeText` w iOS) i import takiego pliku.

Eksport: UTF-8 z BOM, separator „;”, każde pole w cudzysłowach, wiersze rozdzielone CRLF,
bez końcowego znaku nowej linii, kolejność wg nazw autora, serii, tomu i tytułu (porównanie bajtowe).
"""

from __future__ import annotations

import bisect
import csv
import io
import sqlite3
from dataclasses import dataclass
from typing import Any, Optional

from . import db
from .isbn import ISBN
from .store import (
    PAGES_RANGE,
    VOLUME_RANGE,
    YEAR_RANGE,
    Library,
    LibraryError,
    name_key,
    normalize_isbn,
    strip_text,
)
from .textmatch import cleaned_name, nfc, search_key
from .views import load_library, series_has_owned_books

HEADER = ["Tytuł", "Autor", "Seria", "Tom", "Status", "ISBN", "Wydawnictwo", "Rok wydania", "Liczba stron", "Notatki"]
BOM = "﻿"
FILENAME = "Biblioteczka.csv"

# Ile komunikatów o błędach zwracamy najwyżej (reszta jest tylko liczona).
MAX_ERRORS = 50

# Domyślny limit długości pola w module csv (128 KiB) przerywałby odczyt w środku długiej notatki, a dalsze
# linie notatki stawałyby się osobnymi wierszami. 32 MiB to więcej niż limit treści żądania (20 MB);
# nie `sys.maxsize`, bo ta wartość przepełnia C long w kompilacjach 32-bitowych i w Windows.
csv.field_size_limit(32 * 1024 * 1024)


def _quote(field: str) -> str:
    return '"' + field.replace('"', '""') + '"'


def _line(fields: list[str]) -> str:
    return ";".join(_quote(f) for f in fields)


def _str_or_empty(value: Optional[int]) -> str:
    return "" if value is None else str(value)


def export_csv(conn: sqlite3.Connection) -> str:
    """Tekst CSV z książkami „na półce”: posiadanymi i brakującymi tomami serii, z których coś masz."""
    data = load_library(conn)
    shelf = [
        b
        for b in data.books.values()
        if b["is_owned"] or (b["series_id"] is not None and series_has_owned_books(data.series_books(b["series_id"])))
    ]

    def series_name(b: sqlite3.Row) -> str:
        return data.series[b["series_id"]]["name"] if b["series_id"] is not None else ""

    def sort_key(b: sqlite3.Row) -> tuple:
        return (data.author_name(b["author_id"]) or "", series_name(b), b["volume_number"] or 0, b["title"], b["id"])

    lines = [_line(HEADER)]
    for b in sorted(shelf, key=sort_key):
        lines.append(
            _line(
                [
                    b["title"],
                    data.author_name(b["author_id"]) or "",
                    series_name(b),
                    _str_or_empty(b["volume_number"]),
                    "Mam" if b["is_owned"] else "Brakuje",
                    b["isbn"] or "",
                    b["publisher"] or "",
                    _str_or_empty(b["publication_year"]),
                    _str_or_empty(b["page_count"]),
                    b["notes"],
                ]
            )
        )
    return BOM + "\r\n".join(lines)


def has_exportable_books(conn: sqlite3.Connection) -> bool:
    """Czy eksport ma co zapisać (przycisk „Eksportuj do CSV” jest wtedy aktywny)."""
    row = conn.execute(
        """SELECT 1 FROM book b WHERE b.is_owned = 1 OR EXISTS (
               SELECT 1 FROM book o WHERE o.series_id = b.series_id AND o.is_owned = 1)
           LIMIT 1"""
    ).fetchone()
    return row is not None


# --- Import ---

# Nagłówki kolumn po `search_key` → pole (akceptujemy też zapis bez polskich znaków).
_COLUMNS = {
    "tytul": "title",
    "autor": "author",
    "seria": "series",
    "tom": "volume",
    "status": "status",
    "isbn": "isbn",
    "wydawnictwo": "publisher",
    "rok wydania": "year",
    "rok": "year",
    "liczba stron": "pages",
    "strony": "pages",
    "notatki": "notes",
}

# Opis pola w bierniku – do komunikatu „pominięto …”.
_LABELS = {"volume": "niepoprawny numer tomu", "year": "niepoprawny rok wydania", "pages": "niepoprawną liczbę stron"}


@dataclass
class _Row:
    line: int
    title: str
    author: str
    series: str
    volume: Optional[int]
    is_owned: bool
    isbn: Optional[str]
    publisher: Optional[str]
    year: Optional[int]
    pages: Optional[int]
    notes: str


class _Report:
    def __init__(self) -> None:
        self.added = 0
        self.updated = 0
        self.skipped = 0
        self.errors: list[str] = []
        self._hidden = 0

    def error(self, message: str) -> None:
        if len(self.errors) < MAX_ERRORS:
            self.errors.append(message)
        else:
            self._hidden += 1

    def to_json(self) -> dict[str, Any]:
        # `errors` – najwyżej MAX_ERRORS komunikatów; `errorCount` – liczba wszystkich uwag, także niepokazanych.
        return {
            "added": self.added,
            "updated": self.updated,
            "skipped": self.skipped,
            "errors": list(self.errors),
            "errorCount": len(self.errors) + self._hidden,
        }


def _detect_delimiter(text: str) -> str:
    """Separator z pierwszego wiersza (nagłówka): „;” jak w eksporcie iOS, a także „,” lub tabulator."""
    first = text.split("\n", 1)[0]
    counts = {sep: 0 for sep in (";", ",", "\t")}
    quoted = False
    for c in first:
        if c == '"':
            quoted = not quoted
        elif not quoted and c in counts:
            counts[c] += 1
    best = max(counts, key=lambda sep: counts[sep])
    return best if counts[best] > 0 else ";"


def _number(raw: str, bounds: tuple[int, int], field: str, line: int, report: _Report) -> Optional[int]:
    text = raw.strip()
    if text == "":
        return None
    if text.isascii() and text.isdigit():
        value = int(text)
        low, high = bounds
        if low <= value <= high:
            return value
    report.error(f"Wiersz {line}: pominięto {_LABELS[field]} „{text}”.")
    return None


def _parse_rows(text: str, report: _Report) -> list[_Row]:
    text = nfc(text) or ""
    if text.startswith(BOM):
        text = text[1:]
    if text.strip() == "":
        raise LibraryError("Plik CSV jest pusty.", "csv_empty")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=_detect_delimiter(text), quotechar='"')
    try:
        header = next(reader)
    except csv.Error as error:
        raise LibraryError("Nie udało się odczytać pliku CSV.", "csv_invalid") from error
    columns: dict[str, int] = {}
    for index, name in enumerate(header):
        field = _COLUMNS.get(search_key(name.lstrip(BOM)))
        if field is not None and field not in columns:
            columns[field] = index
    if "title" not in columns:
        raise LibraryError(
            "Nie rozpoznano pliku – pierwszy wiersz powinien zawierać nagłówek z kolumną „Tytuł”.", "csv_no_header"
        )

    rows: list[_Row] = []
    # Numer wiersza jak w arkuszu (nagłówek to wiersz 1): liczymy rekordy CSV, a nie linie pliku,
    # bo notatki z eksportu iOS mogą zawierać znaki nowej linii w cudzysłowie.
    line = 1
    while True:
        line += 1
        try:
            fields = next(reader)
        except StopIteration:
            break
        except csv.Error:
            report.error(f"Wiersz {line}: nie udało się odczytać – pominięto.")
            report.skipped += 1
            continue
        if not any(f.strip() for f in fields):
            continue

        def get(field: str) -> str:
            index = columns.get(field)
            return fields[index] if index is not None and index < len(fields) else ""

        title = cleaned_name(get("title"))
        if not title:
            report.error(f"Wiersz {line}: brak tytułu – pominięto.")
            report.skipped += 1
            continue
        status = cleaned_name(get("status"))
        status_key = search_key(status)
        if status_key in ("", "mam"):
            is_owned = True
        elif status_key == "brakuje":
            is_owned = False
        else:
            report.error(f"Wiersz {line}: nieznany status „{status}” – przyjęto „Mam”.")
            is_owned = True
        rows.append(
            _Row(
                line=line,
                title=title,
                author=cleaned_name(get("author")),
                series=cleaned_name(get("series")),
                volume=_number(get("volume"), VOLUME_RANGE, "volume", line, report),
                is_owned=is_owned,
                isbn=normalize_isbn(get("isbn")),
                publisher=cleaned_name(get("publisher")) or None,
                year=_number(get("year"), YEAR_RANGE, "year", line, report),
                pages=_number(get("pages"), PAGES_RANGE, "pages", line, report),
                notes=strip_text(get("notes")),
            )
        )
    return rows


def _isbn_key(isbn: Optional[str]) -> Optional[str]:
    """ISBN jako tożsamość książki: 13 cyfr poprawnego numeru. Niepoprawny tekst („brak”, „9,78838E+12”
    z arkusza) nie jest numerem – taka książka jest dopasowywana po tytule i autorze, jak bez ISBN."""
    parsed = ISBN.parse(isbn)
    return parsed.digits if parsed is not None else None


class _Index:
    """Książki z bazy pogrupowane po ISBN oraz po kluczu tytuł + autor, a także autorzy i serie po nazwie
    (wszystko aktualizowane w trakcie importu, w tej samej transakcji).

    Autorów i serie wyszukujemy w pamięci dokładnie tak jak `Library._find_or_create_author`
    i `Library._find_or_create_series`, ale bez czytania całych tabel przy każdym wierszu pliku –
    import kosztuje O(wiersze + autorzy + serie), a nie O(wiersze × (autorzy + serie)).
    """

    def __init__(self, library: Library) -> None:
        self.library = library
        self.conn = conn = library.conn
        self.author_names: dict[int, str] = {}
        # name_key nazwy → pierwszy (najmniejsze id) autor o tym kluczu.
        self.author_by_key: dict[str, int] = {}
        for r in conn.execute("SELECT id, name FROM author ORDER BY id"):
            self.author_names[r["id"]] = r["name"]
            self.author_by_key.setdefault(name_key(r["name"]), r["id"])
        # name_key nazwy → serie o tym kluczu w kolejności id; osobno bieżący autor każdej serii.
        self.series_by_key: dict[str, list[int]] = {}
        self.series_author: dict[int, Optional[int]] = {}
        for r in conn.execute("SELECT id, name, author_id FROM series ORDER BY id"):
            self.series_by_key.setdefault(name_key(r["name"]), []).append(r["id"])
            self.series_author[r["id"]] = r["author_id"]
        self.by_isbn: dict[str, list[int]] = {}
        self.by_key: dict[tuple[str, str], list[int]] = {}
        self.isbn_of: dict[int, Optional[str]] = {}
        self.key_of: dict[int, tuple[str, str]] = {}
        for book in conn.execute("SELECT id, title, author_id, isbn FROM book ORDER BY id"):
            self.put(book["id"], book["title"], book["author_id"], book["isbn"])

    def _author_key(self, author_id: Optional[int]) -> str:
        if author_id is None:
            return ""
        name = self.author_names.get(author_id)
        if name is None:
            row = self.conn.execute("SELECT name FROM author WHERE id = ?", (author_id,)).fetchone()
            name = row["name"] if row is not None else ""
            self.author_names[author_id] = name
        return name_key(name)

    def author(self, raw: str) -> Optional[int]:
        """Istniejący autor o tej nazwie albo nowy; pusta nazwa → None (jak `Library._find_or_create_author`)."""
        name = cleaned_name(raw)
        if not name:
            return None
        key = name_key(name)
        if key != "" and key in self.author_by_key:
            return self.author_by_key[key]
        cur = self.conn.execute("INSERT INTO author(name, created_at) VALUES (?, ?)", (name, self.library._now()))
        author_id = cur.lastrowid
        self.author_names[author_id] = name
        # Nowe id jest większe od wszystkich, więc wcześniejszy autor o tym kluczu (jeśli jest) zostaje pierwszy.
        self.author_by_key.setdefault(key, author_id)
        return author_id

    def series(self, raw: str, author_id: Optional[int]) -> Optional[int]:
        """Seria tego autora, a w drugiej kolejności seria bez autora (którą autor wtedy „przejmuje”, jeśli
        nie ma w niej książek innych autorów), albo nowa; bez autora – pierwsza seria o tej nazwie.
        Jak `Library._find_or_create_series`."""
        name = cleaned_name(raw)
        if not name:
            return None
        key = name_key(name)
        candidates = self.series_by_key.get(key, []) if key != "" else []
        if author_id is None:
            existing = candidates[0] if candidates else None
        else:
            existing = next((s for s in candidates if self.series_author[s] == author_id), None)
            if existing is None:
                existing = next((s for s in candidates if self.series_author[s] is None), None)
        if existing is not None:
            if self.series_author[existing] is None and author_id is not None:
                others = self.conn.execute(
                    "SELECT 1 FROM book WHERE series_id = ? AND author_id IS NOT NULL AND author_id != ? LIMIT 1",
                    (existing, author_id),
                ).fetchone()
                if others is None:
                    self.conn.execute("UPDATE series SET author_id = ? WHERE id = ?", (author_id, existing))
                    self.series_author[existing] = author_id
            return existing
        series_id = self.library._insert_series(name, author_id)
        self.series_author[series_id] = author_id
        self.series_by_key.setdefault(key, []).append(series_id)
        return series_id

    def put(self, book_id: int, title: str, author_id: Optional[int], isbn: Optional[str]) -> None:
        """Dodaje książkę do indeksu albo odświeża jej wpis po zmianie (zapisany tekst ISBN się nie zmienia,
        indeks używa tylko poprawnych numerów)."""
        old_isbn = self.isbn_of.get(book_id)
        if old_isbn is not None:
            self.by_isbn[old_isbn].remove(book_id)
        old_key = self.key_of.get(book_id)
        if old_key is not None:
            self.by_key[old_key].remove(book_id)
        key = (name_key(title), self._author_key(author_id))
        self.key_of[book_id] = key
        bisect.insort(self.by_key.setdefault(key, []), book_id)
        isbn_key = _isbn_key(isbn)
        self.isbn_of[book_id] = isbn_key
        if isbn_key is not None:
            bisect.insort(self.by_isbn.setdefault(isbn_key, []), book_id)

    def inherited_author(self, raw_series: str) -> Optional[int]:
        """Autor, którego dostałaby nowa książka bez autora w serii `raw_series`: autor serii wybranej
        tak jak w `series(raw, None)` (pierwsza seria o tej nazwie). Bez zakładania i przejmowania serii."""
        key = name_key(cleaned_name(raw_series))
        candidates = self.series_by_key.get(key, []) if key != "" else []
        return self.series_author[candidates[0]] if candidates else None

    def match(self, row: _Row) -> Optional[int]:
        """Ta sama książka: ten sam (poprawny) ISBN, a w drugiej kolejności ten sam tytuł i autor
        (z pominięciem książek z innym poprawnym ISBN – to inne wydania).

        Wiersz bez autora, ale z serią, która ma autora: nowa książka dostaje autora serii (`_apply_row`,
        jak `Library.save_book`), więc szukamy jej też pod tym autorem – inaczej każdy ponowny import
        takiego pliku dodawałby duplikat."""
        row_isbn = _isbn_key(row.isbn)
        if row_isbn is not None and self.by_isbn.get(row_isbn):
            return self.by_isbn[row_isbn][0]
        title_key = name_key(row.title)
        author_keys = [name_key(row.author)]
        if not row.author and row.series:
            inherited = self.inherited_author(row.series)
            if inherited is not None:
                author_keys.append(self._author_key(inherited))
        for author_key in author_keys:
            for book_id in self.by_key.get((title_key, author_key), []):
                isbn = self.isbn_of.get(book_id)
                if row_isbn is not None and isbn is not None and isbn != row_isbn:
                    continue
                return book_id
        return None


def _apply_row(index: _Index, row: _Row, now: str, report: _Report) -> None:
    conn = index.conn
    match_id = index.match(row)
    if match_id is None:
        author_id = index.author(row.author)
        series_id = index.series(row.series, author_id)
        if author_id is None and series_id is not None:
            author_id = conn.execute("SELECT author_id FROM series WHERE id = ?", (series_id,)).fetchone()[0]
        cur = conn.execute(
            """INSERT INTO book(title, volume_number, is_owned, notes, added_at, author_id, series_id,
                                isbn, publisher, publication_year, page_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (row.title, row.volume if series_id is not None else None, int(row.is_owned), row.notes, now,
             author_id, series_id, row.isbn, row.publisher, row.year, row.pages),
        )
        index.put(cur.lastrowid, row.title, author_id, row.isbn)
        report.added += 1
        return

    # Istniejąca książka: niczego nie nadpisujemy, uzupełniamy tylko puste pola.
    existing = conn.execute("SELECT * FROM book WHERE id = ?", (match_id,)).fetchone()
    changes: dict[str, Any] = {}
    author_id = existing["author_id"]
    if author_id is None and row.author:
        author_id = index.author(row.author)
        changes["author_id"] = author_id
    series_id = existing["series_id"]
    if series_id is None and row.series:
        series_id = index.series(row.series, author_id)
        changes["series_id"] = series_id
    if series_id is not None and existing["volume_number"] is None and row.volume is not None:
        changes["volume_number"] = row.volume
    for column, value in (
        ("isbn", row.isbn),
        ("publisher", row.publisher),
        ("publication_year", row.year),
        ("page_count", row.pages),
    ):
        if existing[column] is None and value is not None:
            changes[column] = value
    if existing["notes"] == "" and row.notes:
        changes["notes"] = row.notes
    if row.is_owned and not existing["is_owned"]:
        changes["is_owned"] = 1
        changes["added_at"] = now
    if not changes:
        report.skipped += 1
        return
    assignments = ", ".join(f"{column} = ?" for column in changes)
    conn.execute(f"UPDATE book SET {assignments} WHERE id = ?", (*changes.values(), existing["id"]))
    index.put(existing["id"], existing["title"], author_id, changes.get("isbn", existing["isbn"]))
    report.updated += 1


def import_csv(conn: sqlite3.Connection, text: str) -> dict[str, Any]:
    """Wczytuje CSV (eksport z iOS albo podobny) w jednej transakcji i zwraca raport
    `{"added", "updated", "skipped", "errors", "errorCount"}` (`errors` – najwyżej MAX_ERRORS komunikatów,
    `errorCount` – liczba wszystkich uwag). Plik bez nagłówka z kolumną „Tytuł” → LibraryError."""
    if not isinstance(text, str):
        raise LibraryError("Niepoprawny plik CSV.", "csv_invalid")
    report = _Report()
    rows = _parse_rows(text, report)
    library = Library(conn)
    now = db.utc_now()
    with db.transaction(conn):
        index = _Index(library)
        for row in rows:
            _apply_row(index, row, now, report)
    return report.to_json()
