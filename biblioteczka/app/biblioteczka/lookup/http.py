"""Klient HTTP dla katalogów: sesja aiohttp, limity czasu i pobieranie z kontrolą statusu."""

from __future__ import annotations

import asyncio
import logging
import ssl
from urllib.parse import quote

import aiohttp
from yarl import URL

__all__ = [
    "USER_AGENT",
    "REQUEST_TIMEOUT",
    "LOOKUP_TIMEOUT",
    "MAX_BODY_BYTES",
    "FetchError",
    "build_url",
    "make_session",
    "get",
]

_LOGGER = logging.getLogger(__name__)

USER_AGENT = "Biblioteczka/0.1 (Home Assistant)"
# Limit na jedno zapytanie (poprawka §9.10) i na całe wyszukiwanie.
REQUEST_TIMEOUT = 12.0
LOOKUP_TIMEOUT = 20.0
# Bezpiecznik na rozmiar odpowiedzi (okładki i rekordy katalogowe są dużo mniejsze).
MAX_BODY_BYTES = 15 * 1024 * 1024


class FetchError(Exception):
    """Zapytanie nieudane: błąd sieci, przekroczony czas albo status spoza 2xx."""


def _ssl_context() -> ssl.SSLContext | None:
    """Kontekst TLS z certyfikatami certifi, gdy pakiet jest dostępny (Python z python.org nie ma systemowych)."""
    try:
        import certifi
    except ImportError:
        return None
    try:
        return ssl.create_default_context(cafile=certifi.where())
    except (OSError, ssl.SSLError):
        _LOGGER.warning("Nie udało się wczytać certyfikatów certifi – używam systemowych")
        return None


def _timeout(total: float) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=total, sock_connect=min(total, 10.0), sock_read=min(total, 10.0))


def make_session() -> aiohttp.ClientSession:
    """Sesja bez ciasteczek i pamięci podręcznej; wywoływać wewnątrz działającej pętli asyncio."""
    context = _ssl_context()
    connector = aiohttp.TCPConnector(ssl=context if context is not None else True, limit=20)
    return aiohttp.ClientSession(
        connector=connector,
        headers={"User-Agent": USER_AGENT},
        timeout=_timeout(REQUEST_TIMEOUT),
        cookie_jar=aiohttp.DummyCookieJar(),
        raise_for_status=False,
    )


def build_url(base: str, query: dict[str, str] | None = None) -> str:
    """Adres z parametrami posortowanymi po kluczu (jak `URLComponents`); „:” zostaje dosłownie."""
    if not query:
        return base
    pairs = "&".join(
        f"{quote(key, safe=':/')}={quote(value, safe=':/')}" for key, value in sorted(query.items())
    )
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{pairs}"


async def get(session: aiohttp.ClientSession, url: str, *, timeout: float | None = None) -> bytes:
    """Pobiera treść spod adresu (przekierowania są śledzone); każdy błąd → `FetchError`."""
    limit = REQUEST_TIMEOUT if timeout is None else timeout
    try:
        async with session.get(
            URL(url, encoded=True),
            allow_redirects=True,
            max_redirects=10,
            timeout=_timeout(limit),
        ) as response:
            if not 200 <= response.status < 300:
                raise FetchError(f"HTTP {response.status}: {url}")
            if response.content_length is not None and response.content_length > MAX_BODY_BYTES:
                raise FetchError(f"Za duża odpowiedź: {url}")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.content.iter_chunked(64 * 1024):
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    raise FetchError(f"Za duża odpowiedź: {url}")
                chunks.append(chunk)
            return b"".join(chunks)
    except FetchError:
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as error:
        raise FetchError(f"{type(error).__name__}: {url}") from error
