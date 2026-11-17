"""Szukanie książki po ISBN w bezpłatnych katalogach (port `BookLookup` z iOS).

1. Biblioteka Narodowa (data.bn.org.pl) – najpełniejsze dane polskich wydań, z serią i tomem,
2. e-ISBN (dane od wydawców) – nowości, których BN jeszcze nie skatalogowała,
3. Open Library – książki zagraniczne i okładki.

Wysyłany jest wyłącznie numer ISBN. Google Books celowo pominięte (bez klucza API odpowiada 429).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable

import aiohttp

from .. import covers
from . import bn, http, onix, openlibrary
from .http import FetchError, make_session
from .merge import (
    FAILED,
    FOUND,
    NOT_FOUND,
    OFFLINE,
    SOURCE_BN,
    SOURCE_EISBN,
    SOURCE_OPEN_LIBRARY,
    BookInfo,
    LookupResult,
    SourceAnswer,
    merge_answers,
)

__all__ = [
    "BookInfo",
    "LookupResult",
    "SourceAnswer",
    "FOUND",
    "NOT_FOUND",
    "OFFLINE",
    "FAILED",
    "SOURCE_BN",
    "SOURCE_EISBN",
    "SOURCE_OPEN_LIBRARY",
    "lookup",
    "fetch_cover",
    "make_session",
]

_LOGGER = logging.getLogger(__name__)


async def fetch_cover(isbn: Any, session: aiohttp.ClientSession) -> bytes | None:
    """Okładka z Open Library pomniejszona do JPEG (≤ 900 px) albo None, gdy jej nie ma."""
    try:
        data = await http.get(session, openlibrary.cover_url(isbn))
    except FetchError as error:
        _LOGGER.debug("Brak okładki: %s", error)
        return None
    loop = asyncio.get_running_loop()
    # Dekodowanie i skalowanie obrazu w wątku roboczym, żeby nie blokować serwera.
    return await loop.run_in_executor(None, covers.downscale, data)


def _answer_of(task: asyncio.Task) -> SourceAnswer:
    if task.cancelled() or not task.done():
        return SourceAnswer.failed()
    error = task.exception()
    if error is not None:
        _LOGGER.error("Nieoczekiwany błąd źródła danych", exc_info=error)
        return SourceAnswer.failed()
    return task.result()


async def lookup(isbn: Any, session: aiohttp.ClientSession) -> LookupResult:
    """Szuka książki we wszystkich źródłach naraz i łączy wyniki w stałej kolejności ważności.

    Całość trwa najwyżej `http.LOOKUP_TIMEOUT` sekund: źródło, które nie zdążyło, liczy się
    jako nieudane. Wynik „offline” tylko wtedy, gdy zawiodły wszystkie trzy źródła danych.
    """
    sources: list[Awaitable[Any]] = [
        bn.fetch(isbn, session),
        onix.fetch(isbn, session),
        openlibrary.fetch(isbn, session),
    ]
    metadata = [asyncio.ensure_future(source) for source in sources]
    cover_task = asyncio.ensure_future(fetch_cover(isbn, session))
    tasks = [*metadata, cover_task]
    labels = [SOURCE_BN, SOURCE_EISBN, SOURCE_OPEN_LIBRARY, "okładka (Open Library)"]
    try:
        _, pending = await asyncio.wait(tasks, timeout=http.LOOKUP_TIMEOUT)
        if pending:
            # Nazwy zamiast liczby – bez odmiany „1 źródło / 2 źródła / 5 źródeł”.
            late = ", ".join(label for task, label in zip(tasks, labels) if task in pending)
            _LOGGER.info(
                "Wyszukiwanie ISBN %s: przekroczono czas oczekiwania, bez odpowiedzi: %s",
                getattr(isbn, "digits", isbn),
                late,
            )
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    answers = [_answer_of(task) for task in metadata]
    cover = None
    if not cover_task.cancelled() and cover_task.exception() is None:
        cover = cover_task.result()
    elif not cover_task.cancelled():
        _LOGGER.error("Nieoczekiwany błąd pobierania okładki", exc_info=cover_task.exception())
    return merge_answers(answers, cover)
