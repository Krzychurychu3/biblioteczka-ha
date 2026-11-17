"""Biblioteka Narodowa (data.bn.org.pl): rekordy MARC 21 w JSON."""

from __future__ import annotations

import json
import logging
import unicodedata
from dataclasses import dataclass
from typing import Any

import aiohttp

from . import catalogtext
from .http import FetchError, build_url, get
from .merge import SOURCE_BN, BookInfo, SourceAnswer, isbn_numbers

__all__ = ["ENDPOINT", "parse", "fetch"]

_LOGGER = logging.getLogger(__name__)

ENDPOINT = "https://data.bn.org.pl/api/institutions/bibs.json"


class _DecodeError(Exception):
    """Odpowiedź nie ma oczekiwanej struktury (w iOS: nieudany `JSONDecoder`)."""


@dataclass(frozen=True)
class _Field:
    tag: str
    subfields: tuple[tuple[str, str], ...]

    def first(self, code: str) -> str | None:
        for subfield_code, value in self.subfields:
            if subfield_code == code:
                return value
        return None

    def values(self, code: str) -> list[str]:
        return [value for subfield_code, value in self.subfields if subfield_code == code]


@dataclass(frozen=True)
class _Record:
    publication_year: str | None
    fields: tuple[_Field, ...]

    def field(self, tag: str) -> _Field | None:
        """Pierwsze pole o danym znaczniku."""
        for item in self.fields:
            if item.tag == tag:
                return item
        return None


def _decode_subfields(body: Any) -> tuple[tuple[str, str], ...]:
    """Podpola pola MARC; cokolwiek innego niż `{"subfields": [{kod: tekst}, …]}` → brak podpól."""
    if not isinstance(body, dict):
        return ()
    raw = body.get("subfields")
    if not isinstance(raw, list):
        return ()
    result: list[tuple[str, str]] = []
    for pairs in raw:
        if not isinstance(pairs, dict) or not all(isinstance(v, str) for v in pairs.values()):
            # Jedno złe podpole unieważnia wszystkie podpola pola (jak w iOS).
            return ()
        result.extend((code, unicodedata.normalize("NFC", value)) for code, value in sorted(pairs.items()))
    return tuple(result)


def _decode_field(raw: Any) -> _Field:
    if not isinstance(raw, dict):
        raise _DecodeError("pole MARC nie jest obiektem")
    if not raw:
        raise _DecodeError("puste pole MARC")
    tag = next(iter(raw))
    return _Field(tag=tag, subfields=_decode_subfields(raw[tag]))


def _decode_record(raw: Any) -> _Record:
    if not isinstance(raw, dict):
        raise _DecodeError("rekord nie jest obiektem")
    year = raw.get("publicationYear")
    if year is not None and not isinstance(year, str):
        raise _DecodeError("publicationYear nie jest tekstem")
    marc = raw.get("marc")
    if not isinstance(marc, dict) or not isinstance(marc.get("fields"), list):
        raise _DecodeError("brak marc.fields")
    if year is not None:
        year = unicodedata.normalize("NFC", year)
    return _Record(publication_year=year, fields=tuple(_decode_field(item) for item in marc["fields"]))


def _decode_response(data: bytes) -> list[_Record]:
    try:
        payload = json.loads(data)
    except (ValueError, RecursionError) as error:
        raise _DecodeError("niepoprawny JSON") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("bibs"), list):
        raise _DecodeError("brak bibs")
    return [_decode_record(item) for item in payload["bibs"]]


def _normalized_number(number: str) -> str:
    return "".join(ch for ch in number.upper() if ch == "X" or ch in "0123456789")


def _info_from_record(record: _Record, isbn: Any) -> BookInfo | None:
    title_field = record.field("245")
    raw_title = title_field.first("a") if title_field else None
    title = catalogtext.trimmed(raw_title) if raw_title is not None else None
    if not title:
        return None
    info = BookInfo(isbn=isbn, title=title, sources=[SOURCE_BN])

    main_field = record.field("100")
    main_author = main_field.first("a") if main_field else None
    coauthor = None
    for item in record.fields:
        if item.tag == "700" and any(role.lower().startswith("autor") for role in item.values("e")):
            coauthor = item.first("a")
            break
    author = main_author if main_author is not None else coauthor
    info.author_name = catalogtext.person_name(author) if author is not None else None

    # Seria (poprawka §9.6): nazwa z 490 $a (po polsku, jak na książce), a dopiero gdy jej brak –
    # z 800 $t (to bywa oryginalny, obcojęzyczny tytuł cyklu). 800 → cykl pewny;
    # 490 z „ / ” (seria z autorem) → też cykl pewny. Brany jest tylko pierwszy 490.
    author_series = next((item for item in record.fields if item.tag == "800" and item.first("t") is not None), None)
    statement = record.field("490")
    statement_name = statement.first("a") if statement else None
    raw_series = statement_name if statement_name is not None else (author_series.first("t") if author_series else None)
    if raw_series is not None:
        info.series_name = catalogtext.series_name(raw_series)
        raw_volume = statement.first("v") if statement else None
        if raw_volume is None and author_series is not None:
            raw_volume = author_series.first("v")
        info.volume_number = catalogtext.volume_number(raw_volume) if raw_volume is not None else None
        info.is_series_certain = author_series is not None or (
            statement_name is not None and " / " in statement_name
        )
    if info.series_name == "":
        info.series_name = None

    imprint = next(
        (item for item in record.fields if item.tag in ("264", "260") and item.first("b") is not None),
        None,
    )
    if imprint is not None:
        info.publisher = catalogtext.publisher(imprint.first("b") or "") or None
    year = catalogtext.year(record.publication_year) if record.publication_year is not None else None
    if year is None and imprint is not None:
        raw_date = imprint.first("c")
        year = catalogtext.year(raw_date) if raw_date is not None else None
    info.year = year

    physical = record.field("300")
    raw_pages = physical.first("a") if physical else None
    info.page_count = catalogtext.page_count(raw_pages) if raw_pages is not None else None
    return info.normalized()


def parse(data: bytes, isbn: Any) -> BookInfo | None:
    """Dane książki z odpowiedzi BN albo None (brak pasującego rekordu, zła struktura)."""
    try:
        records = _decode_response(data)
    except _DecodeError:
        return None
    # Wyszukiwanie zwraca też inne wydania, które tylko wspominają ten numer (np. przekłady) –
    # bierzemy rekord, w którym to jest właściwy ISBN książki (pole 020 $a).
    wanted = set(isbn_numbers(isbn))
    for record in records:
        numbers = (
            _normalized_number(value)
            for item in record.fields
            if item.tag == "020"
            for value in item.values("a")
        )
        if any(number in wanted for number in numbers):
            return _info_from_record(record, isbn)
    return None


async def fetch(isbn: Any, session: aiohttp.ClientSession) -> SourceAnswer:
    """Pyta BN najpierw o ISBN-13, potem o ISBN-10 (starsze książki BN zapisuje w tej postaci)."""
    answered = False
    for number in isbn_numbers(isbn):
        try:
            data = await get(session, build_url(ENDPOINT, {"isbnIssn": number, "limit": "20"}))
        except FetchError as error:
            _LOGGER.info("Biblioteka Narodowa nie odpowiedziała: %s", error)
            continue
        answered = True
        try:
            info = parse(data, isbn)
        except Exception:  # błąd parsera nie może zepsuć całego wyszukiwania
            _LOGGER.exception("Nieoczekiwany błąd parsera BN")
            info = None
        if info is not None:
            return SourceAnswer.found(info)
    return SourceAnswer.not_found() if answered else SourceAnswer.failed()
