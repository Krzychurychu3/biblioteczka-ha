"""Serwer HTTP Biblioteczki (aiohttp): interfejs przez Ingress Home Assistanta, REST API,
okładki, kody kreskowe i zadania w tle.

Całe API działa w jednym wątku pętli asyncio, więc jedno połączenie SQLite wystarcza:
żadna transakcja nie obejmuje `await`. W wątkach roboczych liczymy tylko obrazy (Pillow, zxing-cpp).
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import html
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

import aiohttp
from aiohttp import web

from . import __version__, barcode, catalog, covers, csvio, db, lookup, polish, sample, views
from .covers import CoverStore
from .isbn import ISBN
from .store import Library, LibraryError, NotFoundError

__all__ = ["create_app", "STATIC_DIR", "INGRESS_PROXY_IP", "CONTENT_SECURITY_POLICY", "MAX_BODY_BYTES"]

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent / "static"
DB_FILENAME = "biblioteczka.db"
COVERS_DIRNAME = "covers"

# Cały ruch Ingress przychodzi od Supervisora; /healthz sprawdzamy też lokalnie z kontenera.
INGRESS_PROXY_IP = "172.30.32.2"
_LOCAL_IPS = frozenset({"127.0.0.1", "::1"})
_HEALTH_PATH = "/healthz"

# Zdjęcia z aparatu i pliki CSV wysyłamy jako surową treść żądania (body).
MAX_BODY_BYTES = 20 * 1024 * 1024

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; "
    "object-src 'none'; base-uri 'self'"
)

# Kompresja gzip: tylko tekstowe typy i tylko odpowiedzi, które są tego warte.
_COMPRESSIBLE_TYPES = frozenset(
    {
        "application/json",
        "text/csv",
        "text/javascript",
        "text/css",
        "text/html",
        "text/plain",
        "image/svg+xml",
        "application/wasm",
    }
)
_GZIP_MIN_BYTES = 1024

# Pliki statyczne: tylko znane rozszerzenia (reszta, np. pliki licencji, nie jest serwowana).
_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain; charset=utf-8",
}
_STATIC_CACHE = "public, max-age=86400"
_COVER_CACHE = "public, max-age=31536000, immutable"

# Okładki: sprzątanie osieroconych plików (najpierw chwilę po starcie, potem co 6 godzin).
COVER_GC_FIRST_DELAY = 300.0
COVER_GC_INTERVAL = 6 * 3600.0
COVER_GC_MIN_AGE = 86400.0

# Pobieranie brakujących okładek: 2 zapytania naraz, pauza po każdym.
COVER_JOB_CONCURRENCY = 2
COVER_JOB_PAUSE = 0.5

# Jednocześnie dekodowane zdjęcia (pamięć Raspberry Pi jest ograniczona).
IMAGE_WORKERS = 2

# Wartość nagłówka X-Ingress-Path: /api/hassio_ingress/<token>.
_INGRESS_PATH = re.compile(r"(?:/[A-Za-z0-9._~%-]+)+/?")
_MAX_DB_ID = 2**63 - 1

INTERNAL_ERROR_MESSAGE = "Wystąpił nieoczekiwany błąd."

_HTTP_ERRORS = {
    400: ("Niepoprawne żądanie.", "bad_request"),
    403: ("Brak dostępu do Biblioteczki.", "forbidden"),
    404: ("Nie znaleziono.", "not_found"),
    405: ("Ta operacja nie jest tu dostępna.", "method_not_allowed"),
    413: ("Plik jest za duży – limit to 20 MB.", "too_large"),
    415: ("Nieobsługiwany format pliku.", "unsupported_media_type"),
}


# --- Stan aplikacji ---


@dataclass(frozen=True)
class Settings:
    """Ustawienia ustalone przy starcie."""

    data_dir: Path
    dev: bool
    catalog_path: Optional[Path]
    catalog_available: bool
    # Losowy znacznik uruchomienia – ETag stanu zmienia się po restarcie (np. inna wersja, tryb).
    boot_id: str
    # Klucz plików statycznych (`?v=`, `data-version`, `appVersion` w stanie): wersja + skrót
    # zawartości `static/`, więc zmienia się po każdej aktualizacji i po „Przebuduj”.
    asset_key: str


@dataclass
class CoverJob:
    """Zadanie „pobierz brakujące okładki”: stan widoczny w `state.meta.coverJob`."""

    state: Optional[dict[str, Any]] = None
    # Licznik zmian stanu zadania – część ETag-u stanu (postęp nie zmienia rewizji bazy).
    version: int = 0
    task: Optional[asyncio.Task] = None

    @property
    def running(self) -> bool:
        return self.state is not None and bool(self.state.get("running"))

    def snapshot(self) -> Optional[dict[str, Any]]:
        return dict(self.state) if self.state is not None else None

    def update(self, **changes: Any) -> None:
        if self.state is None:
            self.state = {"running": False, "total": 0, "done": 0, "found": 0}
        self.state.update(changes)
        self.version += 1


@dataclass
class _StaticEntry:
    mtime_ns: int
    size: int
    body: bytes
    etag: str
    gzipped: Optional[bytes] = None


@dataclass
class StaticFiles:
    """Pliki z katalogu `static/` z pamięcią podręczną (odświeżaną po zmianie pliku na dysku)."""

    root: Path
    _cache: dict[Path, _StaticEntry] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()

    def resolve(self, relative: str) -> Optional[Path]:
        """Ścieżka pliku wewnątrz `root` albo None (ukryte pliki, `..`, katalogi, nieznane typy)."""
        if not relative or "\x00" in relative or "\\" in relative:
            return None
        parts = relative.split("/")
        if any(part in ("", ".", "..") or part.startswith(".") for part in parts):
            return None
        if Path(parts[-1]).suffix.lower() not in _STATIC_TYPES:
            return None
        try:
            resolved = (self.root / relative).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        try:
            resolved.relative_to(self.root)
        except ValueError:
            return None
        return resolved if resolved.is_file() else None

    def load(self, path: Path) -> _StaticEntry:
        stat = path.stat()
        entry = self._cache.get(path)
        if entry is None or entry.mtime_ns != stat.st_mtime_ns or entry.size != stat.st_size:
            body = path.read_bytes()
            entry = _StaticEntry(
                mtime_ns=stat.st_mtime_ns,
                size=stat.st_size,
                body=body,
                etag='"' + hashlib.sha1(body).hexdigest()[:20] + '"',
            )
            self._cache[path] = entry
        return entry

    def gzipped(self, entry: _StaticEntry) -> bytes:
        if entry.gzipped is None:
            entry.gzipped = gzip.compress(entry.body, compresslevel=6, mtime=0)
        return entry.gzipped


def static_tree_hash(root: Union[str, Path]) -> str:
    """Skrót SHA-1 (hex) całego katalogu plików statycznych: posortowane ścieżki względne i zawartość.

    Pomijamy ukryte pliki i katalogi oraz dowiązania symboliczne – serwer i tak ich nie udostępnia.
    """
    root = Path(root)
    files: list[tuple[str, Path]] = []
    for directory, subdirs, names in os.walk(root):
        subdirs[:] = [name for name in subdirs if not name.startswith(".")]
        for name in names:
            path = Path(directory, name)
            if name.startswith(".") or path.is_symlink() or not path.is_file():
                continue
            files.append((path.relative_to(root).as_posix(), path))
    digest = hashlib.sha1()
    for relative, path in sorted(files):
        body = path.read_bytes()
        # Ścieżka i długość przed treścią – sklejenie dwóch plików nie da tego samego skrótu.
        digest.update(f"{relative}\x00{len(body)}\x00".encode("utf-8"))
        digest.update(body)
    return digest.hexdigest()


def make_asset_key(root: Union[str, Path], version: str = __version__) -> str:
    """Klucz `?v=` plików statycznych: wersja aplikacji i 10 znaków skrótu zawartości `static/`."""
    return f"{version}-{static_tree_hash(root)[:10]}"


CONN = web.AppKey("conn", sqlite3.Connection)
LIBRARY = web.AppKey("library", Library)
COVERS = web.AppKey("covers", CoverStore)
SETTINGS = web.AppKey("settings", Settings)
STATIC = web.AppKey("static", StaticFiles)
COVER_JOB = web.AppKey("cover_job", CoverJob)
SESSION = web.AppKey("session", aiohttp.ClientSession)
IMAGE_LIMIT = web.AppKey("image_limit", asyncio.Semaphore)
_DENIED_IPS = web.AppKey("denied_ips", set)


# --- Pomocnicze: odpowiedzi i odczyt żądań ---


def _dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def json_response(data: Any, status: int = 200, cache: str = "no-store", headers: Optional[dict] = None) -> web.Response:
    response = web.json_response(data, status=status, dumps=_dumps)
    response.headers["Cache-Control"] = cache
    if headers:
        response.headers.update(headers)
    return response


def error_response(status: int, message: str, code: str) -> web.Response:
    return json_response({"error": message, "code": code}, status=status)


def _nfc_deep(value: Any) -> Any:
    """Wszystkie teksty (także klucze) w postaci NFC."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_nfc_deep(item) for item in value]
    if isinstance(value, dict):
        return {unicodedata.normalize("NFC", key): _nfc_deep(item) for key, item in value.items()}
    return value


async def read_json(request: web.Request) -> dict[str, Any]:
    """Treść żądania jako obiekt JSON (puste body = `{}`); teksty w NFC."""
    raw = await request.read()
    if not raw.strip():
        return {}
    try:
        data = _nfc_deep(json.loads(raw.decode("utf-8-sig")))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise LibraryError("Niepoprawne dane żądania.", "invalid_json") from error
    if not isinstance(data, dict):
        raise LibraryError("Niepoprawne dane żądania.", "invalid_json")
    return data


def _optional_id(value: Any, label: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= _MAX_DB_ID:
        raise LibraryError(f"Niepoprawny identyfikator ({label}).", "invalid_id")
    return value


def _path_id(request: web.Request) -> int:
    return int(request.match_info["id"])


def _revision(request: web.Request) -> int:
    return db.revision(request.app[CONN])


def _decode_text(raw: bytes, charset: Optional[str]) -> str:
    """Tekst przesłanego pliku: wskazane kodowanie, UTF-8, a w razie błędu Windows-1250 (polski Excel)."""
    candidates = []
    if charset:
        candidates.append(charset)
    candidates += ["utf-8", "cp1250"]
    for encoding in candidates:
        try:
            return raw.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _accepts_gzip(request: web.Request) -> bool:
    for item in request.headers.get("Accept-Encoding", "").lower().split(","):
        name, _, params = item.strip().partition(";")
        if name.strip() not in ("gzip", "*"):
            continue
        quality = params.strip()
        if quality.startswith("q="):
            try:
                return float(quality[2:]) > 0
            except ValueError:
                return False
        return True
    return False


def _etag_matches(header: Optional[str], etag: str) -> bool:
    """Porównanie `If-None-Match` (słabe – `W/` jest ignorowane)."""
    if not header:
        return False
    wanted = etag[2:] if etag.startswith("W/") else etag
    for item in header.split(","):
        tag = item.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == wanted:
            return True
    return False


def _normalized_ip(remote: Optional[str]) -> Optional[str]:
    if not remote:
        return None
    try:
        address = ipaddress.ip_address(remote.split("%", 1)[0])
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return str(address)


def _remote_allowed(request: web.Request) -> bool:
    ip = _normalized_ip(request.remote)
    if ip == INGRESS_PROXY_IP:
        return True
    return request.path == _HEALTH_PATH and ip in _LOCAL_IPS


def base_href(request: web.Request) -> str:
    """Wartość `<base href>`: ścieżka Ingress z ukośnikiem na końcu albo `./` poza Home Assistantem."""
    raw = request.headers.get("X-Ingress-Path", "").strip()
    if not raw:
        return "./"
    if not _INGRESS_PATH.fullmatch(raw):
        logger.warning("Pominięto niepoprawny nagłówek X-Ingress-Path: %r", raw[:200])
        return "./"
    return raw.rstrip("/") + "/"


# --- Middleware i sygnały ---


@web.middleware
async def ingress_guard(request: web.Request, handler):
    """Poza trybem deweloperskim tylko proxy Ingress (i lokalny /healthz); zmiany tylko z tej samej witryny."""
    if not request.app[SETTINGS].dev and not _remote_allowed(request):
        denied = request.app[_DENIED_IPS]
        if request.remote not in denied and len(denied) < 1000:
            denied.add(request.remote)
            logger.warning("Odrzucono żądanie spoza Home Assistant Ingress z adresu %s", request.remote)
        return error_response(403, "Brak dostępu – Biblioteczka działa tylko w panelu Home Assistant.", "forbidden")
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("Sec-Fetch-Site") == "cross-site":
        return error_response(403, "Brak dostępu do Biblioteczki.", "forbidden")
    return await handler(request)


@web.middleware
async def error_middleware(request: web.Request, handler):
    """Błędy jako JSON `{"error", "code"}` z polskim komunikatem."""
    try:
        return await handler(request)
    except LibraryError as error:
        return error_response(error.status, error.message_pl, error.code)
    except web.HTTPException as error:
        if error.status < 400:
            raise
        message, code = _HTTP_ERRORS.get(
            error.status,
            (INTERNAL_ERROR_MESSAGE, "internal") if error.status >= 500 else ("Niepoprawne żądanie.", "bad_request"),
        )
        response = error_response(error.status, message, code)
        if error.status == 405 and "Allow" in error.headers:
            response.headers["Allow"] = error.headers["Allow"]
        return response
    except Exception:
        logger.exception("Nieoczekiwany błąd przy %s %s", request.method, request.path)
        return error_response(500, INTERNAL_ERROR_MESSAGE, "internal")


@web.middleware
async def compression_middleware(request: web.Request, handler):
    """Gzip dla JSON, CSV, HTML itp. (pliki statyczne mają własną, zapamiętaną kompresję)."""
    response = await handler(request)
    if (
        type(response) is web.Response
        and response.content_type in _COMPRESSIBLE_TYPES
        and "Content-Encoding" not in response.headers
    ):
        response.headers["Vary"] = "Accept-Encoding"
        body = response.body
        if (
            response.status == 200
            and isinstance(body, (bytes, bytearray))
            and len(body) >= _GZIP_MIN_BYTES
            and _accepts_gzip(request)
        ):
            response.enable_compression(web.ContentCoding.gzip)
    return response


async def _security_headers(request: web.Request, response: web.StreamResponse) -> None:
    response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"


# --- Strona i pliki statyczne ---


async def handle_index(request: web.Request) -> web.Response:
    static = request.app[STATIC]
    path = static.root / "index.html"
    if not path.is_file():
        logger.error("Brak szablonu %s", path)
        return error_response(500, INTERNAL_ERROR_MESSAGE, "internal")
    template = static.load(path).body.decode("utf-8")
    page = (
        template.replace("{{BASE}}", html.escape(base_href(request), quote=True))
        .replace("{{VERSION}}", html.escape(request.app[SETTINGS].asset_key, quote=True))
        .replace("{{DEV}}", "true" if request.app[SETTINGS].dev else "false")
    )
    return web.Response(
        text=page, content_type="text/html", charset="utf-8", headers={"Cache-Control": "no-cache"}
    )


async def handle_static(request: web.Request) -> web.Response:
    static = request.app[STATIC]
    relative = request.match_info["path"]
    path = static.resolve(relative)
    # Surowy szablon strony nie jest plikiem statycznym (serwujemy go pod „/”).
    if path is None or path == static.root / "index.html":
        raise web.HTTPNotFound()
    entry = static.load(path)
    # Adres z bieżącym kluczem (`?v=` – wersja i skrót zawartości) można trzymać dobę; resztę
    # (importy modułów, adresy ze starym kluczem) przeglądarka sprawdza za każdym razem (ETag → 304),
    # żeby po aktualizacji nie mieszać starych plików z nowymi.
    versioned = request.query.get("v") == request.app[SETTINGS].asset_key and not request.app[SETTINGS].dev
    headers = {
        "ETag": entry.etag,
        "Cache-Control": _STATIC_CACHE if versioned else "no-cache",
        "Content-Type": _STATIC_TYPES[path.suffix.lower()],
    }
    compressible = headers["Content-Type"].split(";")[0] in _COMPRESSIBLE_TYPES
    if compressible:
        headers["Vary"] = "Accept-Encoding"
    if _etag_matches(request.headers.get("If-None-Match"), entry.etag):
        headers.pop("Content-Type")
        return web.Response(status=304, headers=headers)
    body = entry.body
    if compressible and len(body) >= _GZIP_MIN_BYTES and _accepts_gzip(request):
        body = static.gzipped(entry)
        headers["Content-Encoding"] = "gzip"
    return web.Response(body=body, headers=headers)


async def handle_healthz(request: web.Request) -> web.Response:
    try:
        request.app[CONN].execute("SELECT 1").fetchone()
    except sqlite3.Error:
        logger.exception("Baza danych nie odpowiada")
        return web.Response(status=503, text="error", headers={"Cache-Control": "no-store"})
    return web.Response(text="ok", headers={"Cache-Control": "no-store"})


# --- Stan ---


def state_etag(app: web.Application) -> str:
    conn = app[CONN]
    return f'"r{db.revision(conn)}-{app[SETTINGS].boot_id}-{app[COVER_JOB].version}"'


async def handle_state(request: web.Request) -> web.Response:
    app = request.app
    etag = state_etag(app)
    if _etag_matches(request.headers.get("If-None-Match"), etag):
        return web.Response(status=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    settings = app[SETTINGS]
    state = views.build_state(
        app[CONN],
        # Klucz plików, a nie sama wersja – komunikat „Dostępna jest nowa wersja” pojawia się też po „Przebuduj”.
        settings.asset_key,
        catalog_available=settings.catalog_available,
        dev_mode=settings.dev,
        barcode_server_decode=barcode.available(),
        cover_job=app[COVER_JOB].snapshot(),
    )
    return json_response(state, cache="no-cache", headers={"ETag": etag})


# --- Książki ---


async def create_book(request: web.Request) -> web.Response:
    body = await read_json(request)
    adopt_id = _optional_id(body.get("adoptId"), "adoptId")
    book_id = request.app[LIBRARY].save_book(body.get("draft"), None, adopt_id)
    return json_response({"id": book_id, "revision": _revision(request)})


async def update_book(request: web.Request) -> web.Response:
    body = await read_json(request)
    book_id = request.app[LIBRARY].save_book(body.get("draft"), book_id=_path_id(request))
    return json_response({"id": book_id, "revision": _revision(request)})


async def delete_book(request: web.Request) -> web.Response:
    request.app[LIBRARY].delete_book(_path_id(request))
    return json_response({"revision": _revision(request)})


async def set_book_owned(request: web.Request) -> web.Response:
    body = await read_json(request)
    if "isOwned" not in body:
        raise LibraryError("Niepoprawna wartość pola „Status”.", "invalid_field")
    book_id = _path_id(request)
    request.app[LIBRARY].set_owned(book_id, body["isOwned"])
    return json_response({"id": book_id, "revision": _revision(request)})


async def complete_book(request: web.Request) -> web.Response:
    body = await read_json(request)
    book_id = _path_id(request)
    request.app[LIBRARY].complete_book(book_id, body.get("edition"), body.get("markOwned", False))
    return json_response({"id": book_id, "revision": _revision(request)})


# --- Serie i autorzy ---


async def create_series(request: web.Request) -> web.Response:
    body = await read_json(request)
    series_id = request.app[LIBRARY].save_series(body.get("draft"))
    return json_response({"id": series_id, "revision": _revision(request)})


async def update_series(request: web.Request) -> web.Response:
    body = await read_json(request)
    series_id = request.app[LIBRARY].save_series(body.get("draft"), _path_id(request))
    return json_response({"id": series_id, "revision": _revision(request)})


async def delete_series(request: web.Request) -> web.Response:
    request.app[LIBRARY].delete_series(_path_id(request), request.query.get("withBooks"))
    return json_response({"revision": _revision(request)})


async def create_author(request: web.Request) -> web.Response:
    body = await read_json(request)
    result = request.app[LIBRARY].save_author(body.get("name"))
    return json_response({**result, "revision": _revision(request)})


async def update_author(request: web.Request) -> web.Response:
    body = await read_json(request)
    result = request.app[LIBRARY].save_author(body.get("name"), _path_id(request))
    return json_response({**result, "revision": _revision(request)})


async def delete_author(request: web.Request) -> web.Response:
    request.app[LIBRARY].delete_author(_path_id(request), request.query.get("withBooks"))
    return json_response({"revision": _revision(request)})


# --- Wyszukiwanie po ISBN ---


def _store_cover(app: web.Application, jpeg: bytes) -> Optional[str]:
    try:
        return app[COVERS].put(jpeg)
    except OSError:
        logger.exception("Nie udało się zapisać okładki")
        return None


async def handle_lookup(request: web.Request) -> web.Response:
    app = request.app
    body = await read_json(request)
    editing_id = _optional_id(body.get("editingBookId"), "editingBookId")
    form = body.get("form")
    if form is not None and not isinstance(form, dict):
        raise LibraryError("Niepoprawne dane żądania.", "invalid_json")
    raw_isbn = body.get("isbn")
    parsed = ISBN.parse(raw_isbn) if isinstance(raw_isbn, str) else None
    if parsed is None:
        return json_response({"status": "invalid", "info": None, "resolution": None})
    if editing_id is not None and app[CONN].execute("SELECT 1 FROM book WHERE id = ?", (editing_id,)).fetchone() is None:
        raise NotFoundError("Nie ma już tej książki – mogła zostać usunięta na innym urządzeniu.", "book_not_found")

    result = await lookup.lookup(parsed, app[SESSION])
    if result.status != lookup.FOUND or result.info is None:
        return json_response({"status": result.status, "info": None, "resolution": None})

    info = result.info.to_json()
    cover_id = None
    jpeg = result.info.cover
    if jpeg and not jpeg.startswith(b"\xff\xd8"):
        async with app[IMAGE_LIMIT]:
            jpeg = await asyncio.get_running_loop().run_in_executor(None, covers.downscale, jpeg)
    if jpeg:
        cover_id = _store_cover(app, jpeg)
    info["coverId"] = cover_id
    # Stan bazy mógł się zmienić w trakcie wyszukiwania – sprawdzamy go dopiero teraz.
    resolution = app[LIBRARY].resolve_lookup(info, editing_id, form=form)
    return json_response({"status": result.status, "info": info, "resolution": resolution})


# --- Okładki ---


async def upload_cover(request: web.Request) -> web.Response:
    app = request.app
    data = await request.read()
    if not data:
        raise LibraryError("Nie przesłano zdjęcia.", "empty_body")
    async with app[IMAGE_LIMIT]:
        jpeg = await asyncio.get_running_loop().run_in_executor(None, covers.downscale, data)
    if jpeg is None:
        raise LibraryError(
            "Nie udało się odczytać zdjęcia – wybierz plik JPEG, PNG albo WebP (co najmniej 40 × 40 pikseli).",
            "invalid_image",
            415,
        )
    cover_id = _store_cover(app, jpeg)
    if cover_id is None:
        raise LibraryError("Nie udało się zapisać okładki.", "cover_write_failed", 500)
    return json_response({"coverId": cover_id})


async def get_cover(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    cover_id = name[:-4] if name.endswith(".jpg") else ""
    store = request.app[COVERS]
    if not store.is_valid_id(cover_id):
        raise LibraryError("Niepoprawny identyfikator okładki.", "invalid_cover")
    path = store.path(cover_id)
    if not path.is_file():
        raise NotFoundError("Nie ma takiej okładki.", "cover_not_found")
    return web.FileResponse(path, headers={"Cache-Control": _COVER_CACHE, "Content-Type": "image/jpeg"})


# --- Kody kreskowe ---


async def decode_barcode(request: web.Request) -> web.Response:
    data = await request.read()
    if not barcode.available():
        return json_response({"available": False, "kind": "none", "isbn": None, "codes": []})
    if not data:
        raise LibraryError("Nie przesłano zdjęcia.", "empty_body")
    async with request.app[IMAGE_LIMIT]:
        result = await barcode.decode_async(data)
    return json_response({"available": True, **result})


# --- Katalog, CSV, przykładowe dane, usuwanie ---


async def import_catalog(request: web.Request) -> web.Response:
    added = catalog.import_missing(request.app[CONN], request.app[SETTINGS].catalog_path)
    return json_response({"added": added, "revision": _revision(request)})


async def export_csv(request: web.Request) -> web.Response:
    text = csvio.export_csv(request.app[CONN])
    return web.Response(
        body=text.encode("utf-8"),
        content_type="text/csv",
        charset="utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{csvio.FILENAME}"',
            "Cache-Control": "no-store",
        },
    )


async def import_csv(request: web.Request) -> web.Response:
    raw = await request.read()
    text = unicodedata.normalize("NFC", _decode_text(raw, request.charset))
    report = csvio.import_csv(request.app[CONN], text)
    logger.info(
        "Import CSV: dodano %s, uzupełniono %s, pominięto %s",
        report.get("added"), report.get("updated"), report.get("skipped"),
    )
    return json_response({**report, "revision": _revision(request)})


async def insert_sample_data(request: web.Request) -> web.Response:
    if not request.app[SETTINGS].dev:
        raise web.HTTPNotFound()
    added = sample.insert_sample_data(request.app[CONN])
    return json_response({"added": added, "revision": _revision(request)})


async def delete_library(request: web.Request) -> web.Response:
    app = request.app
    job = app[COVER_JOB]
    # Zadanie pobierania okładek dotyczy usuwanych książek: przerywamy je (i czekamy na koniec),
    # żeby nie odpytywało dalej Open Library i nie blokowało nowego zadania po ponownym imporcie.
    # W pętli, bo w trakcie oczekiwania inne żądanie mogło zdążyć uruchomić kolejne zadanie.
    while job.task is not None and not job.task.done():
        await _cancel_cover_job(app, "usuwanie wszystkich danych")
    # Od tego miejsca bez `await` – nic nie wejdzie między przerwanie zadania a usunięcie danych.
    job.task = None
    if job.state is not None:
        # Karta postępu znika – ETag stanu zmienia się razem z licznikiem.
        job.state = None
        job.version += 1
    app[LIBRARY].delete_all()
    logger.info("Usunięto wszystkie dane biblioteczki")
    return json_response({"revision": _revision(request)})


# --- Pobieranie brakujących okładek (zadanie w tle) ---


def cover_candidates(conn: sqlite3.Connection) -> list[tuple[str, list[int]]]:
    """Książki z poprawnym ISBN i bez okładki, zgrupowane po numerze (posiadane najpierw)."""
    groups: dict[str, list[int]] = {}
    rows = conn.execute(
        "SELECT id, isbn FROM book WHERE cover_id IS NULL AND isbn IS NOT NULL ORDER BY is_owned DESC, id"
    )
    for row in rows:
        parsed = ISBN.parse(row["isbn"])
        if parsed is not None:
            groups.setdefault(parsed.digits, []).append(row["id"])
    return list(groups.items())


def _attach_cover(app: web.Application, digits: str, book_ids: list[int], jpeg: bytes) -> int:
    """Zapisuje okładkę w książkach, które wciąż jej nie mają i mają ten sam ISBN. Zwraca ich liczbę."""
    conn = app[CONN]
    marks = ",".join("?" for _ in book_ids)
    rows = conn.execute(
        f"SELECT id, isbn FROM book WHERE cover_id IS NULL AND id IN ({marks})", tuple(book_ids)
    ).fetchall()
    # Książkę mogła w międzyczasie zmienić inna osoba (nowa okładka albo inny ISBN).
    targets = []
    for row in rows:
        parsed = ISBN.parse(row["isbn"]) if row["isbn"] else None
        if parsed is not None and parsed.digits == digits:
            targets.append(row["id"])
    if not targets:
        return 0
    cover_id = _store_cover(app, jpeg)
    if cover_id is None:
        return 0
    marks = ",".join("?" for _ in targets)
    with db.transaction(conn):
        cur = conn.execute(
            f"UPDATE book SET cover_id = ? WHERE cover_id IS NULL AND id IN ({marks})", (cover_id, *targets)
        )
    return cur.rowcount


async def _run_cover_job(app: web.Application, groups: list[tuple[str, list[int]]]) -> None:
    job = app[COVER_JOB]
    queue = deque(groups)
    session = app[SESSION]

    async def worker() -> None:
        while queue:
            digits, book_ids = queue.popleft()
            found = 0
            try:
                jpeg = await lookup.fetch_cover(ISBN(digits), session)
                if jpeg:
                    found = _attach_cover(app, digits, book_ids, jpeg)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Błąd pobierania okładki dla ISBN %s", digits)
            job.update(done=job.state["done"] + len(book_ids), found=job.state["found"] + found)
            if queue:
                await asyncio.sleep(COVER_JOB_PAUSE)

    try:
        await asyncio.gather(*(worker() for _ in range(min(COVER_JOB_CONCURRENCY, len(groups)))))
    finally:
        job.update(running=False)
        logger.info(
            "Pobieranie okładek zakończone: sprawdzono %d z %d, znaleziono %d",
            job.state["done"], job.state["total"], job.state["found"],
        )


async def fetch_missing_covers(request: web.Request) -> web.Response:
    app = request.app
    job = app[COVER_JOB]
    if job.running:
        return json_response({"started": False, "total": job.state["total"], "revision": _revision(request)})
    groups = cover_candidates(app[CONN])
    total = sum(len(ids) for _, ids in groups)
    if not groups:
        return json_response({"started": False, "total": 0, "revision": _revision(request)})
    job.state = None
    job.update(running=True, total=total, done=0, found=0)
    job.task = asyncio.get_running_loop().create_task(_run_cover_job(app, groups))
    logger.info("Pobieranie okładek: %s bez okładki", polish.count(total, "book"))
    return json_response({"started": True, "total": total, "revision": _revision(request)})


# --- Sprzątanie okładek ---


def collect_orphan_covers(app: web.Application, min_age_seconds: float = COVER_GC_MIN_AGE) -> int:
    """Usuwa pliki okładek, do których nie odwołuje się żadna książka (starsze niż doba)."""
    referenced = app[LIBRARY].referenced_cover_ids()
    return app[COVERS].gc(referenced, min_age_seconds=min_age_seconds)


async def _cover_gc_loop(app: web.Application) -> None:
    await asyncio.sleep(COVER_GC_FIRST_DELAY)
    while True:
        try:
            collect_orphan_covers(app)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Błąd sprzątania okładek")
        await asyncio.sleep(COVER_GC_INTERVAL)


# --- Cykl życia ---


async def _http_session_ctx(app: web.Application):
    app[SESSION] = lookup.make_session()
    yield
    await app[SESSION].close()


async def _background_ctx(app: web.Application):
    gc_task = asyncio.get_running_loop().create_task(_cover_gc_loop(app))
    yield
    tasks = [gc_task]
    job_task = app[COVER_JOB].task
    if job_task is not None:
        tasks.append(job_task)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def _cancel_cover_job(app: web.Application, reason: str) -> None:
    """Przerywa trwające pobieranie okładek i czeka, aż zadanie się zakończy (`running` = False)."""
    task = app[COVER_JOB].task
    if task is not None and not task.done():
        logger.info("Przerywam pobieranie okładek (%s)", reason)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def _stop_cover_job(app: web.Application) -> None:
    await _cancel_cover_job(app, "zamykanie serwera")


async def _close_db(app: web.Application) -> None:
    conn = app[CONN]
    try:
        conn.execute("PRAGMA optimize")
    except sqlite3.Error:
        pass
    conn.close()
    logger.info("Baza danych zamknięta")


def create_app(
    data_dir: Union[str, Path],
    dev: bool = False,
    sample_data: bool = False,
    *,
    catalog_path: Union[str, Path, None] = None,
    static_dir: Union[str, Path, None] = None,
) -> web.Application:
    """Aplikacja aiohttp: otwiera bazę, zasiewa katalog (i ewentualnie przykładowe dane), rejestruje trasy.

    `catalog_path` i `static_dir` służą testom (domyślnie pliki z pakietu).
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = db.open_db(data_dir / DB_FILENAME)
    try:
        if sample_data:
            added = sample.insert_sample_data_if_empty(conn)
            if added:
                logger.info("Wczytano przykładowe dane: %s", polish.count(added, "book"))
        catalog.seed_if_needed(conn, catalog_path)
        static_root = Path(static_dir) if static_dir is not None else STATIC_DIR
        settings = Settings(
            data_dir=data_dir,
            dev=dev,
            catalog_path=Path(catalog_path) if catalog_path is not None else None,
            catalog_available=catalog.catalog_available(catalog_path),
            boot_id=secrets.token_hex(4),
            # Liczony raz przy starcie – w kontenerze pliki statyczne się nie zmieniają.
            asset_key=make_asset_key(static_root),
        )
        cover_store = CoverStore(data_dir / COVERS_DIRNAME)
    except BaseException:
        conn.close()
        raise

    app = web.Application(
        client_max_size=MAX_BODY_BYTES,
        middlewares=[ingress_guard, error_middleware, compression_middleware],
    )
    app[CONN] = conn
    app[LIBRARY] = Library(conn)
    app[COVERS] = cover_store
    app[SETTINGS] = settings
    app[STATIC] = StaticFiles(static_root)
    app[COVER_JOB] = CoverJob()
    app[IMAGE_LIMIT] = asyncio.Semaphore(IMAGE_WORKERS)
    app[_DENIED_IPS] = set()

    app.on_response_prepare.append(_security_headers)
    app.cleanup_ctx.append(_http_session_ctx)
    app.cleanup_ctx.append(_background_ctx)
    app.on_shutdown.append(_stop_cover_job)
    app.on_cleanup.append(_close_db)

    r = app.router
    r.add_get("/", handle_index)
    r.add_get("/static/{path:.+}", handle_static)
    r.add_get(_HEALTH_PATH, handle_healthz)
    r.add_get("/api/state", handle_state)
    book = r"/api/books/{id:[0-9]{1,18}}"
    r.add_post("/api/books", create_book)
    r.add_put(book, update_book)
    r.add_delete(book, delete_book)
    r.add_post(book + "/owned", set_book_owned)
    r.add_post(book + "/complete", complete_book)
    series = r"/api/series/{id:[0-9]{1,18}}"
    r.add_post("/api/series", create_series)
    r.add_put(series, update_series)
    r.add_delete(series, delete_series)
    author = r"/api/authors/{id:[0-9]{1,18}}"
    r.add_post("/api/authors", create_author)
    r.add_put(author, update_author)
    r.add_delete(author, delete_author)
    r.add_post("/api/lookup", handle_lookup)
    r.add_post("/api/covers", upload_cover)
    r.add_post("/api/covers/fetch-missing", fetch_missing_covers)
    r.add_get("/api/covers/{name}", get_cover)
    r.add_post("/api/barcode", decode_barcode)
    r.add_post("/api/catalog/import", import_catalog)
    r.add_get("/api/export.csv", export_csv)
    r.add_post("/api/import/csv", import_csv)
    r.add_post("/api/sample-data", insert_sample_data)
    r.add_delete("/api/library", delete_library)

    logger.info(
        "Biblioteczka %s: dane w %s%s", __version__, data_dir, " (tryb deweloperski)" if dev else ""
    )
    return app
