"""Open Library: dane książki (JSON `api/books`) i adres okładki."""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any

import aiohttp

from . import catalogtext
from .http import FetchError, build_url, get
from .merge import SOURCE_OPEN_LIBRARY, BookInfo, SourceAnswer

__all__ = ["ENDPOINT", "COVER_ENDPOINT", "cover_url", "parse", "fetch"]

_LOGGER = logging.getLogger(__name__)

ENDPOINT = "https://openlibrary.org/api/books"
COVER_ENDPOINT = "https://covers.openlibrary.org/b/isbn"

# Open Library dopisuje do tytułów np. „(Polish Edition)”; wielkość liter ma znaczenie.
_EDITION_SUFFIX = re.compile(r"\s*\([A-Za-z]+ Edition\)$")


class _DecodeError(Exception):
    """Wpis nie ma oczekiwanych typów (w iOS: nieudany `JSONDecoder`)."""


def cover_url(isbn: Any) -> str:
    """Okładka w dużym rozmiarze; `default=false` → 404, gdy jej nie ma."""
    return f"{COVER_ENDPOINT}/{isbn.digits}-L.jpg?default=false"


def _optional_str(entry: dict, key: str) -> str | None:
    value = entry.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _DecodeError(key)
    return unicodedata.normalize("NFC", value)


def _optional_int(entry: dict, key: str) -> int | None:
    value = entry.get(key)
    if value is None:
        return None
    if isinstance(value, bool):
        raise _DecodeError(key)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    raise _DecodeError(key)


def _first_name(entry: dict, key: str) -> str | None:
    """Pierwsze `name` z listy obiektów; każdy obiekt musi mieć tekstowe `name`."""
    value = entry.get(key)
    if value is None:
        return None
    if not isinstance(value, list):
        raise _DecodeError(key)
    names = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise _DecodeError(key)
        names.append(unicodedata.normalize("NFC", item["name"]))
    return names[0] if names else None


def _decode_entry(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise _DecodeError("wpis nie jest obiektem")
    return {
        "title": _optional_str(entry, "title"),
        "author": _first_name(entry, "authors"),
        "publisher": _first_name(entry, "publishers"),
        "publish_date": _optional_str(entry, "publish_date"),
        "pages": _optional_int(entry, "number_of_pages"),
    }


def parse(data: bytes, isbn: Any) -> BookInfo | None:
    """Dane książki z odpowiedzi `{"ISBN:…": {…}}` albo None (`{}`, zły JSON, brak tytułu)."""
    try:
        payload = json.loads(data)
    except (ValueError, RecursionError):
        return None
    if not isinstance(payload, dict) or not payload:
        return None
    try:
        # Jak w iOS całość musi się zdekodować, choć używany jest tylko pierwszy wpis.
        entries = [_decode_entry(value) for value in payload.values()]
    except _DecodeError:
        return None
    entry = entries[0]
    raw_title = entry["title"]
    if raw_title is None:
        return None
    title = _EDITION_SUFFIX.sub("", raw_title, count=1)
    if not title:
        return None
    publish_date = entry["publish_date"]
    info = BookInfo(
        isbn=isbn,
        title=title,
        author_name=entry["author"],
        publisher=entry["publisher"],
        year=catalogtext.year(publish_date) if publish_date is not None else None,
        page_count=entry["pages"],
        sources=[SOURCE_OPEN_LIBRARY],
    )
    return info.normalized()


async def fetch(isbn: Any, session: aiohttp.ClientSession) -> SourceAnswer:
    url = build_url(ENDPOINT, {"bibkeys": f"ISBN:{isbn.digits}", "format": "json", "jscmd": "data"})
    try:
        data = await get(session, url)
    except FetchError as error:
        _LOGGER.info("Open Library nie odpowiedziało: %s", error)
        return SourceAnswer.failed()
    try:
        return SourceAnswer.from_parsed(parse(data, isbn))
    except Exception:  # błąd parsera nie może zepsuć całego wyszukiwania
        _LOGGER.exception("Nieoczekiwany błąd parsera Open Library")
        return SourceAnswer.not_found()
