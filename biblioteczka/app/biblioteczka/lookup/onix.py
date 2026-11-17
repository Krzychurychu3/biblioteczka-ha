"""e-ISBN (e-isbn.pl): ONIX 3.0 w XML, parsowany strumieniowo jak w iOS (`ONIXParser`)."""

from __future__ import annotations

import logging
import unicodedata
import xml.etree.ElementTree as ET
from typing import Any

import aiohttp

from . import catalogtext
from .http import FetchError, build_url, get
from .merge import SOURCE_EISBN, BookInfo, SourceAnswer

__all__ = ["ENDPOINT", "parse", "fetch"]

_LOGGER = logging.getLogger(__name__)

ENDPOINT = "https://e-isbn.pl/IsbnWeb/api.xml"


def _local_name(tag: str) -> str:
    """Nazwa elementu bez przestrzeni nazw (`{ns}Product` → `Product`)."""
    return tag.rsplit("}", 1)[-1]


def _element_text(element: ET.Element) -> str:
    """Tekst zebrany od ostatniego otwarcia/zamknięcia elementu – jak `text` w iOS.

    Przy treści mieszanej zostaje tylko fragment po ostatnim dziecku.
    """
    raw = element[-1].tail if len(element) else element.text
    return catalogtext.strip_whitespace_and_newlines(unicodedata.normalize("NFC", raw or ""))


class _State:
    def __init__(self, isbn: Any) -> None:
        self.info = BookInfo(isbn=isbn, sources=[SOURCE_EISBN])
        self.has_product = False
        self.title_prefix: str | None = None
        self.title_without_prefix: str | None = None
        self.contributor_role: str | None = None
        self.contributor_name: str | None = None
        self.contributor_inverted: str | None = None
        self.imprint_name: str | None = None
        self.publisher_name: str | None = None
        self.date_role: str | None = None
        self.date_value: str | None = None
        self.extent_type: str | None = None
        self.extent_value: str | None = None
        self.extent_unit: str | None = None

    def start(self, name: str) -> None:
        if name == "Product":
            self.has_product = True
        elif name == "Contributor":
            self.contributor_role = self.contributor_name = self.contributor_inverted = None
        elif name == "PublishingDate":
            self.date_role = self.date_value = None
        elif name == "Extent":
            self.extent_type = self.extent_value = self.extent_unit = None

    def end(self, name: str, value: str, path: list[str]) -> None:
        info = self.info
        in_collection = "Collection" in path
        in_description = "DescriptiveDetail" in path

        if name == "TitleText" and in_collection:
            if info.series_name is None and value:
                info.series_name = catalogtext.series_name(value)
                info.is_series_certain = True
        elif name == "TitleText" and in_description:
            if info.title is None and value:
                info.title = value
        elif name == "TitlePrefix" and in_description and not in_collection:
            self.title_prefix = value
        elif name == "TitleWithoutPrefix" and in_description and not in_collection:
            self.title_without_prefix = value
        elif name == "TitleElement" and in_description and not in_collection:
            if info.title is None and self.title_without_prefix is not None:
                parts = [part for part in (self.title_prefix, self.title_without_prefix) if part is not None]
                info.title = " ".join(parts)
        elif name == "PartNumber" and in_description:
            # Collection leży wewnątrz DescriptiveDetail, więc numer części cyklu też się liczy.
            if info.volume_number is None:
                info.volume_number = catalogtext.volume_number(value)
        elif name == "ContributorRole":
            self.contributor_role = value
        elif name == "PersonName":
            self.contributor_name = value
        elif name == "PersonNameInverted":
            self.contributor_inverted = value
        elif name == "Contributor":
            if info.author_name is None and self.contributor_role == "A01":
                # Pusty PersonName nie blokuje postaci odwróconej ani kolejnych autorów (poprawka §9.5).
                if self.contributor_name:
                    info.author_name = self.contributor_name
                elif self.contributor_inverted:
                    info.author_name = catalogtext.person_name(self.contributor_inverted) or None
        elif name == "ImprintName":
            if self.imprint_name is None and value:
                self.imprint_name = value
        elif name == "PublisherName":
            if self.publisher_name is None and value:
                self.publisher_name = value
        elif name == "PublishingDateRole":
            self.date_role = value
        elif name == "Date" and "PublishingDate" in path:
            self.date_value = value
        elif name == "PublishingDate":
            # Data w ONIX ma postać RRRRMMDD (albo samo RRRR); rola 01 = data wydania.
            if info.year is None or self.date_role == "01":
                year = catalogtext.swift_int(self.date_value[:4]) if self.date_value is not None else None
                if year is not None and 1500 <= year <= 2100:
                    info.year = year
        elif name == "ExtentType":
            self.extent_type = value
        elif name == "ExtentValue":
            self.extent_value = value
        elif name == "ExtentUnit":
            self.extent_unit = value
        elif name == "Extent":
            # Jednostka 03 = strony; typ 00 / 11 = liczba stron treści.
            pages = catalogtext.swift_int(self.extent_value) if self.extent_value is not None else None
            if (
                self.extent_unit == "03"
                and pages is not None
                and pages > 0
                and (info.page_count is None or self.extent_type in ("00", "11"))
            ):
                info.page_count = pages


def parse(data: bytes, isbn: Any) -> BookInfo | None:
    """Dane książki z komunikatu ONIX albo None (zły XML, brak `<Product>`, brak tytułu)."""
    state = _State(isbn)
    parser = ET.XMLPullParser(events=("start", "end"))
    path: list[str] = []
    try:
        parser.feed(data)
        parser.close()
        events = parser.read_events()
        for event, element in events:
            name = _local_name(element.tag)
            if event == "start":
                path.append(name)
                state.start(name)
            else:
                state.end(name, _element_text(element), path)
                path.pop()
    except ET.ParseError:
        return None
    if not state.has_product:
        return None
    info = state.info
    if state.imprint_name is not None:
        # ImprintName trafia bez zmian, PublisherName jest porządkowany (jak w iOS).
        info.publisher = state.imprint_name
    elif state.publisher_name is not None:
        info.publisher = catalogtext.publisher(state.publisher_name)
    if not info.title:
        return None
    return info.normalized()


async def fetch(isbn: Any, session: aiohttp.ClientSession) -> SourceAnswer:
    try:
        data = await get(session, build_url(ENDPOINT, {"isbn": isbn.digits}))
    except FetchError as error:
        _LOGGER.info("e-ISBN nie odpowiedział: %s", error)
        return SourceAnswer.failed()
    try:
        return SourceAnswer.from_parsed(parse(data, isbn))
    except Exception:  # błąd parsera nie może zepsuć całego wyszukiwania
        _LOGGER.exception("Nieoczekiwany błąd parsera e-ISBN")
        return SourceAnswer.not_found()
