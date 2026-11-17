"""Model wyniku wyszukiwania po ISBN i łączenie odpowiedzi źródeł (port `BookInfo` z iOS).

Kolejność ważności źródeł jest stała: Biblioteka Narodowa > e-ISBN > Open Library,
niezależnie od tego, które odpowie pierwsze.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field, replace
from typing import Any, Iterable

from .catalogtext import clamp_pages, clamp_volume, clamp_year, strip_whitespace_and_newlines

__all__ = [
    "SOURCE_BN",
    "SOURCE_EISBN",
    "SOURCE_OPEN_LIBRARY",
    "FOUND",
    "NOT_FOUND",
    "OFFLINE",
    "FAILED",
    "BookInfo",
    "LookupResult",
    "SourceAnswer",
    "merge_answers",
    "isbn_numbers",
]

# Nazwy źródeł (pokazywane użytkownikowi w „Dane z: …”).
SOURCE_BN = "Biblioteka Narodowa"
SOURCE_EISBN = "e-ISBN"
SOURCE_OPEN_LIBRARY = "Open Library"

# Statusy wyniku końcowego.
FOUND = "found"
NOT_FOUND = "notFound"
OFFLINE = "offline"
# Status odpowiedzi pojedynczego źródła: błąd sieci, przekroczony czas albo kod spoza 2xx.
FAILED = "failed"


def _isbn_digits(isbn: Any) -> str:
    digits = getattr(isbn, "digits", None)
    return digits if isinstance(digits, str) else str(isbn)


def isbn_numbers(isbn: Any) -> list[str]:
    """Postaci numeru do zapytań: ISBN-13, a potem ISBN-10 (tylko gdy istnieje, czyli prefiks 978)."""
    numbers = [_isbn_digits(isbn)]
    isbn10 = getattr(isbn, "isbn10", None)
    if callable(isbn10):
        isbn10 = isbn10()
    if isinstance(isbn10, str) and isbn10 and isbn10 not in numbers:
        numbers.append(isbn10)
    return numbers


def _clean_text(value: Any) -> str | None:
    """NFC, obcięte białe znaki; pusty tekst (albo nie-tekst) liczy się jako brak (poprawka §9.5)."""
    if not isinstance(value, str):
        return None
    text = strip_whitespace_and_newlines(unicodedata.normalize("NFC", value))
    return text or None


@dataclass
class BookInfo:
    """Dane książki znalezione w internecie po numerze ISBN."""

    isbn: Any
    title: str | None = None
    author_name: str | None = None
    series_name: str | None = None
    # True – na pewno cykl (np. „Wiedźmin”); False – może to być tylko seria wydawnicza.
    is_series_certain: bool = False
    volume_number: int | None = None
    publisher: str | None = None
    year: int | None = None
    page_count: int | None = None
    cover: bytes | None = None
    sources: list[str] = field(default_factory=list)

    def normalized(self) -> "BookInfo":
        """Kopia z tekstami w NFC, pustymi napisami zamienionymi na None i liczbami w zakresach."""
        return replace(
            self,
            title=_clean_text(self.title),
            author_name=_clean_text(self.author_name),
            series_name=_clean_text(self.series_name),
            is_series_certain=bool(self.is_series_certain),
            volume_number=clamp_volume(self.volume_number),
            publisher=_clean_text(self.publisher),
            year=clamp_year(self.year),
            page_count=clamp_pages(self.page_count),
            cover=self.cover or None,
            sources=list(self.sources),
        )

    def fill(self, other: "BookInfo") -> None:
        """Uzupełnia puste pola danymi z kolejnego (mniej ważnego) źródła.

        Seria, jej pewność i numer tomu przechodzą razem – jak w iOS.
        """
        if self.title is None:
            self.title = other.title
        if self.author_name is None:
            self.author_name = other.author_name
        if self.series_name is None and other.series_name is not None:
            self.series_name = other.series_name
            self.is_series_certain = other.is_series_certain
            self.volume_number = other.volume_number
        if self.publisher is None:
            self.publisher = other.publisher
        if self.year is None:
            self.year = other.year
        if self.page_count is None:
            self.page_count = other.page_count
        if self.cover is None:
            self.cover = other.cover
        self.sources += [source for source in other.sources if source not in self.sources]

    def to_json(self) -> dict[str, Any]:
        """Słownik camelCase dla API – bez bajtów okładki."""
        return {
            "isbn": _isbn_digits(self.isbn),
            "title": self.title,
            "authorName": self.author_name,
            "seriesName": self.series_name,
            "isSeriesCertain": self.is_series_certain,
            "volumeNumber": self.volume_number,
            "publisher": self.publisher,
            "year": self.year,
            "pageCount": self.page_count,
            "sources": list(self.sources),
        }


@dataclass(frozen=True)
class SourceAnswer:
    """Odpowiedź jednego źródła: `found` (z danymi), `notFound` albo `failed`."""

    status: str
    info: BookInfo | None = None

    @classmethod
    def found(cls, info: BookInfo) -> "SourceAnswer":
        return cls(FOUND, info)

    @classmethod
    def not_found(cls) -> "SourceAnswer":
        return cls(NOT_FOUND)

    @classmethod
    def failed(cls) -> "SourceAnswer":
        return cls(FAILED)

    @classmethod
    def from_parsed(cls, info: BookInfo | None) -> "SourceAnswer":
        """Serwer odpowiedział: dane albo „nie znaleziono”."""
        return cls.found(info) if info is not None else cls.not_found()


@dataclass
class LookupResult:
    """Wynik końcowy: `found` (z `info`), `notFound` albo `offline`."""

    status: str
    info: BookInfo | None = None

    def to_json(self) -> dict[str, Any]:
        return {"status": self.status, "info": self.info.to_json() if self.info else None}


def merge_answers(answers: Iterable[SourceAnswer], cover: bytes | None = None) -> LookupResult:
    """Łączy odpowiedzi podane w kolejności ważności; „offline” tylko gdy wszystkie zawiodły."""
    answers = list(answers)
    merged: BookInfo | None = None
    for answer in answers:
        if answer.status != FOUND or answer.info is None:
            continue
        info = answer.info.normalized()
        if merged is None:
            merged = info
        else:
            merged.fill(info)
    if merged is not None:
        if merged.cover is None:
            merged.cover = cover or None
        return LookupResult(FOUND, merged)
    if answers and all(answer.status == FAILED for answer in answers):
        return LookupResult(OFFLINE)
    return LookupResult(NOT_FOUND)
