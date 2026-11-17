"""Wyliczane właściwości autorów, serii i książek (port rozszerzeń z `Author.swift`, `Series.swift`,
`Book.swift`) oraz pełny stan biblioteczki w JSON dla klienta (`build_state`).

Listy w stanie są nieposortowane (klient sortuje `compareLocalized`); wyjątkiem są `slots` – w kolejności półki.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

from . import db, polish
from .textmatch import nfc

# --- Kolejność „localized standard” (przybliżenie ICU pl z sortowaniem liczbowym) ---

# Polskie litery z ogonkami i kreskami są w alfabecie osobnymi literami tuż po literze bazowej.
_POLISH_LETTERS = {
    "ą": ("a", 1), "ć": ("c", 1), "ę": ("e", 1), "ł": ("l", 1), "ń": ("n", 1),
    "ó": ("o", 1), "ś": ("s", 1), "ź": ("z", 1), "ż": ("z", 2),
}

_TOKEN = re.compile(r"\d+|\D")


def localized_key(text: str) -> tuple:
    """Klucz sortowania jak `localizedStandardCompare`: bez wielkości liter na pierwszym poziomie,
    liczby wg wartości („tom 2” < „tom 10”), polskie litery po bazowych, małe przed wielkimi przy remisie.

    To samo robi `compareLocalized` w JS (Intl.Collator „pl”); po stronie serwera wystarcza do kolejności
    tomów w slocie i do wyboru „pierwszego” wpisu w podpowiedziach.
    """
    s = nfc(text) or ""
    primary: list[tuple[int, int, int]] = []
    secondary: list[int] = []
    tertiary: list[int] = []
    for token in _TOKEN.findall(s):
        if token.isdecimal():
            primary.append((1, int(token), 0))
            secondary.append(0)
            tertiary.append(0)
            continue
        low = token.lower()
        if low in _POLISH_LETTERS:
            base, rank = _POLISH_LETTERS[low]
            accents = 0
        else:
            decomposed = unicodedata.normalize("NFD", low)
            base, rank = decomposed[0], 0
            accents = len(decomposed) - 1
        group = 2 if base.isalnum() else 0
        primary.append((group, ord(base), rank))
        secondary.append(accents)
        tertiary.append(0 if token == low else 1)
    return (primary, secondary, tertiary, s)


# --- Migawka danych ---


@dataclass
class LibraryData:
    """Wszystkie wiersze bazy z indeksami relacji (kolejność id rosnąco, jak kolejność wstawiania)."""

    authors: dict[int, sqlite3.Row]
    series: dict[int, sqlite3.Row]
    books: dict[int, sqlite3.Row]
    books_by_series: dict[int, list[sqlite3.Row]] = field(default_factory=dict)
    books_by_author: dict[int, list[sqlite3.Row]] = field(default_factory=dict)
    series_by_author: dict[int, list[sqlite3.Row]] = field(default_factory=dict)

    def series_books(self, series_id: int) -> list[sqlite3.Row]:
        return self.books_by_series.get(series_id, [])

    def author_books(self, author_id: int) -> list[sqlite3.Row]:
        return self.books_by_author.get(author_id, [])

    def author_series(self, author_id: int) -> list[sqlite3.Row]:
        return self.series_by_author.get(author_id, [])

    def author_name(self, author_id: Optional[int]) -> Optional[str]:
        if author_id is None:
            return None
        row = self.authors.get(author_id)
        return row["name"] if row is not None else None


def load_library(conn: sqlite3.Connection) -> LibraryData:
    """Wczytuje całą bazę do pamięci (biblioteczka domowa to setki, nie miliony wpisów)."""
    authors = {r["id"]: r for r in conn.execute("SELECT * FROM author ORDER BY id")}
    series = {r["id"]: r for r in conn.execute("SELECT * FROM series ORDER BY id")}
    books = {r["id"]: r for r in conn.execute("SELECT * FROM book ORDER BY id")}
    data = LibraryData(authors, series, books)
    for b in books.values():
        if b["series_id"] is not None:
            data.books_by_series.setdefault(b["series_id"], []).append(b)
        if b["author_id"] is not None:
            data.books_by_author.setdefault(b["author_id"], []).append(b)
    for s in series.values():
        if s["author_id"] is not None:
            data.series_by_author.setdefault(s["author_id"], []).append(s)
    return data


# --- Książka ---


def title_order_key(book: sqlite3.Row) -> tuple:
    """`Book.titleOrder` (z id na końcu, żeby kolejność była zawsze ta sama)."""
    return (localized_key(book["title"]), book["id"])


def series_line(series_name: Optional[str], volume: Optional[int]) -> Optional[str]:
    """„Wiedźmin · tom 3”, sama nazwa serii bez numeru albo None poza serią."""
    if series_name is None:
        return None
    if volume is None:
        return series_name
    return f"{series_name} · tom {volume}"


def suggestion_subtitle(author_name: Optional[str], line: Optional[str]) -> str:
    """Podpis podpowiedzi tytułu: „Marta Galewska-Kustra · Pucio” (może być pusty)."""
    return " · ".join(part for part in (author_name, line) if part is not None)


# --- Seria ---


@dataclass(frozen=True)
class Slot:
    """Miejsce na półce serii: numerowany tom (także pusty) albo książka bez numeru."""

    number: Optional[int]
    books: tuple

    @property
    def is_owned(self) -> bool:
        return any(b["is_owned"] for b in self.books)

    @property
    def is_empty(self) -> bool:
        return not self.books


def highest_volume_number(books: Sequence[sqlite3.Row]) -> int:
    numbers = [b["volume_number"] for b in books if b["volume_number"] is not None]
    return max(numbers) if numbers else 0


def numbered_slot_count(planned: Optional[int], books: Sequence[sqlite3.Row]) -> int:
    return max(planned or 0, highest_volume_number(books))


def series_slots(planned: Optional[int], books: Sequence[sqlite3.Row]) -> list[Slot]:
    """Tomy serii po kolei: numery 1…N (puste też), potem książki bez numeru (lub z numerem ≤ 0)."""
    by_number: dict[int, list[sqlite3.Row]] = {}
    unnumbered: list[sqlite3.Row] = []
    for b in books:
        number = b["volume_number"]
        if number is not None and number > 0:
            by_number.setdefault(number, []).append(b)
        else:
            unnumbered.append(b)
    result = [
        Slot(n, tuple(sorted(by_number.get(n, []), key=title_order_key)))
        for n in range(1, numbered_slot_count(planned, books) + 1)
    ]
    result.extend(Slot(None, (b,)) for b in sorted(unnumbered, key=title_order_key))
    return result


@dataclass(frozen=True)
class Progress:
    """`SeriesProgress`: postęp kompletowania serii liczony po slotach, nie po książkach."""

    total: int
    owned: int
    missing_numbers: tuple
    is_total_known: bool

    @property
    def missing(self) -> int:
        return self.total - self.owned

    @property
    def fraction(self) -> float:
        return 0.0 if self.total == 0 else self.owned / self.total

    @property
    def is_complete(self) -> bool:
        return self.is_total_known and self.total > 0 and self.owned == self.total

    @property
    def label(self) -> str:
        if self.total == 0:
            return "brak tomów"
        return f"{self.owned}/{self.total}" if self.is_total_known else f"{self.owned}/?"

    @property
    def missing_description(self) -> Optional[str]:
        """„Brakuje tomu 4” / „Brakuje tomów: 4, 6, 8” / „Brakuje 2 tomów”.

        Poprawka względem iOS: „Brakuje tomu N” tylko wtedy, gdy brakuje dokładnie jednego tomu,
        a lista numerów tylko wtedy, gdy wszystkie brakujące tomy mają numery – inaczej sama liczba.
        """
        missing = self.missing
        if missing <= 0:
            return None
        numbers = self.missing_numbers
        if missing == 1:
            return f"Brakuje tomu {numbers[0]}" if numbers else "Brakuje 1 tomu"
        if len(numbers) == missing:
            return "Brakuje tomów: " + ", ".join(str(n) for n in numbers)
        return f"Brakuje {missing} tomów"

    def to_json(self) -> dict[str, Any]:
        return {
            "owned": self.owned,
            "total": self.total,
            "missing": self.missing,
            "missingNumbers": list(self.missing_numbers),
            "isTotalKnown": self.is_total_known,
            "isComplete": self.is_complete,
            "fraction": self.fraction,
            "label": self.label,
        }


def series_progress(planned: Optional[int], slots: Sequence[Slot]) -> Progress:
    return Progress(
        total=len(slots),
        owned=sum(1 for s in slots if s.is_owned),
        missing_numbers=tuple(s.number for s in slots if not s.is_owned and s.number is not None),
        is_total_known=planned is not None,
    )


def next_volume_number(slots: Sequence[Slot], books: Sequence[sqlite3.Row]) -> int:
    """Numer pierwszego pustego tomu, a gdy takiego nie ma – kolejny po najwyższym."""
    for slot in slots:
        if slot.is_empty and slot.number is not None:
            return slot.number
    return highest_volume_number(books) + 1


def suggested_volume_number(planned: Optional[int], books: Sequence[sqlite3.Row]) -> int:
    """Numer tomu dla nowej książki w serii; 0 = bez numeru (seria z samymi nienumerowanymi tomami)."""
    if numbered_slot_count(planned, books) > 0 or not books:
        return next_volume_number(series_slots(planned, books), books)
    return 0


def series_author_line(data: LibraryData, series: sqlite3.Row) -> str:
    """Autor serii do wyświetlenia – także „Różni autorzy” i „Autor nieznany”."""
    name = data.author_name(series["author_id"])
    if name is not None:
        return name
    names = {data.author_name(b["author_id"]) for b in data.series_books(series["id"])}
    names.discard(None)
    if len(names) > 1:
        return "Różni autorzy"
    return next(iter(names)) if names else "Autor nieznany"


def series_cover_id(books: Sequence[sqlite3.Row]) -> Optional[str]:
    """Okładka serii: pierwszego tomu z okładką (numer rosnąco, bez numeru na końcu, potem tytuł bajtowo)."""
    ordered = sorted(
        books,
        key=lambda b: (
            b["volume_number"] if b["volume_number"] is not None else float("inf"),
            b["title"],
            b["id"],
        ),
    )
    for b in ordered:
        if b["cover_id"]:
            return b["cover_id"]
    return None


def series_has_owned_books(books: Sequence[sqlite3.Row]) -> bool:
    return any(b["is_owned"] for b in books)


def series_is_on_shelf(books: Sequence[sqlite3.Row]) -> bool:
    """Seria widoczna na listach: pusta (świeżo dodana) albo z choć jednym posiadanym tomem."""
    return not books or series_has_owned_books(books)


# --- Autor ---


def author_is_on_shelf(books: Sequence[sqlite3.Row], series: Sequence[sqlite3.Row]) -> bool:
    """Autor widoczny na listach: ma posiadaną książkę albo nie ma jeszcze żadnych wpisów."""
    return any(b["is_owned"] for b in books) or (not books and not series)


def author_summary(book_count: int, series_count: int) -> str:
    """„2 serie · 12 książek” – liczy wszystko, także katalog."""
    parts = []
    if series_count:
        parts.append(polish.count(series_count, "series"))
    parts.append(polish.count(book_count, "book"))
    return " · ".join(parts)


def author_owned_summary(owned_count: int, owned_series_count: int) -> str:
    """„1 seria · 3 książki” albo „Brak książek na półce”."""
    if owned_count == 0:
        return "Brak książek na półce"
    parts = []
    if owned_series_count > 0:
        parts.append(polish.count(owned_series_count, "series"))
    parts.append(polish.count(owned_count, "book"))
    return " · ".join(parts)


# --- Stan dla klienta ---


def _book_json(data: LibraryData, b: sqlite3.Row) -> dict[str, Any]:
    series = data.series.get(b["series_id"]) if b["series_id"] is not None else None
    series_name = series["name"] if series is not None else None
    line = series_line(series_name, b["volume_number"])
    return {
        "id": b["id"],
        "title": b["title"],
        "authorId": b["author_id"],
        "seriesId": b["series_id"],
        "volumeNumber": b["volume_number"],
        "isOwned": bool(b["is_owned"]),
        "notes": b["notes"],
        "addedAt": b["added_at"],
        "isbn": b["isbn"],
        "publisher": b["publisher"],
        "publicationYear": b["publication_year"],
        "pageCount": b["page_count"],
        "coverId": b["cover_id"],
        "coverSeed": series_name if series_name is not None else b["title"],
        "coverLabel": str(b["volume_number"]) if series is not None and b["volume_number"] is not None else None,
        "seriesLine": line,
        "suggestionSubtitle": suggestion_subtitle(data.author_name(b["author_id"]), line),
    }


def _series_json(data: LibraryData, s: sqlite3.Row) -> tuple[dict[str, Any], Progress]:
    books = data.series_books(s["id"])
    planned = s["planned_volume_count"]
    slots = series_slots(planned, books)
    progress = series_progress(planned, slots)
    suggested = (
        next_volume_number(slots, books)
        if numbered_slot_count(planned, books) > 0 or not books
        else 0
    )
    return (
        {
            "id": s["id"],
            "name": s["name"],
            "authorId": s["author_id"],
            "plannedVolumeCount": planned,
            "notes": s["notes"],
            "createdAt": s["created_at"],
            "isOnShelf": series_is_on_shelf(books),
            "hasOwnedBooks": series_has_owned_books(books),
            "bookCount": len(books),
            "progress": progress.to_json(),
            "slots": [
                {"number": slot.number, "bookIds": [b["id"] for b in slot.books], "isOwned": slot.is_owned}
                for slot in slots
            ],
            "missingDescription": progress.missing_description,
            "nextVolumeNumber": next_volume_number(slots, books),
            "suggestedVolumeNumber": suggested,
            "coverId": series_cover_id(books),
            "authorLine": series_author_line(data, s),
        },
        progress,
    )


def _author_json(data: LibraryData, a: sqlite3.Row, progress_by_series: dict[int, Progress]) -> dict[str, Any]:
    books = data.author_books(a["id"])
    series = data.author_series(a["id"])
    owned = [b for b in books if b["is_owned"]]
    owned_series = sum(1 for s in series if series_has_owned_books(data.series_books(s["id"])))
    shelf_series = [s for s in series if series_is_on_shelf(data.series_books(s["id"]))]
    # Poprawka względem iOS: posiadane książki autora z serii wspólnych lub innych autorów
    # (sekcja „W innych seriach”), żeby liczba w nagłówku zgadzała się z treścią.
    own_series_ids = {s["id"] for s in series}
    other_series_books = sorted(
        (b for b in owned if b["series_id"] is not None and b["series_id"] not in own_series_ids),
        key=title_order_key,
    )
    return {
        "id": a["id"],
        "name": a["name"],
        "createdAt": a["created_at"],
        "isOnShelf": author_is_on_shelf(books, series),
        "bookCount": len(books),
        "ownedBookCount": len(owned),
        "seriesIds": [s["id"] for s in sorted(series, key=lambda s: (localized_key(s["name"]), s["id"]))],
        "summary": author_summary(len(books), len(series)),
        "ownedSummary": author_owned_summary(len(owned), owned_series),
        "missingCount": sum(progress_by_series[s["id"]].missing for s in shelf_series),
        "otherSeriesBookIds": [b["id"] for b in other_series_books],
    }


def build_state(
    conn: sqlite3.Connection,
    app_version: str,
    *,
    catalog_available: bool = False,
    dev_mode: bool = False,
    barcode_server_decode: bool = False,
    cover_job: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Pełny stan biblioteczki dla klienta (JSON). Pola `meta` podaje serwer – nie ma ich w bazie."""
    data = load_library(conn)
    series_items = []
    progress_by_series: dict[int, Progress] = {}
    for s in data.series.values():
        item, progress = _series_json(data, s)
        series_items.append(item)
        progress_by_series[s["id"]] = progress
    return {
        "revision": db.revision(conn),
        "appVersion": app_version,
        "meta": {
            "catalogAvailable": catalog_available,
            "devMode": dev_mode,
            "barcodeServerDecode": barcode_server_decode,
            "coverJob": cover_job,
        },
        "authors": [_author_json(data, a, progress_by_series) for a in data.authors.values()],
        "series": series_items,
        "books": [_book_json(data, b) for b in data.books.values()],
    }
