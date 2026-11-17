"""Testy serwera HTTP (aiohttp): trasy API, Ingress, nagłówki, pliki statyczne, okładki, CSV i zadania w tle."""

import asyncio
import gzip
import io
import json
import os
import time
import unicodedata

import pytest
import aiohttp
import pytest_asyncio
from aiohttp import web
from PIL import Image, ImageDraw
from yarl import URL

from biblioteczka import __version__, barcode, lookup, server, views
from biblioteczka.lookup import BookInfo, LookupResult

pytestmark = pytest.mark.asyncio

ISBN_A = "9788375780635"
ISBN_B = "9788380083738"
ISBN_C = "9788310139658"

CATALOG = {
    "version": 1,
    "name": "Katalog testowy",
    "books": [
        {"title": "Pucio uczy się mówić", "author": "Marta Galewska-Kustra", "series": "Pucio", "volume": 1},
        {"title": "Dzieci z Bullerbyn", "author": "Astrid Lindgren"},
    ],
}

TEMPLATE = (
    '<!doctype html><html data-dev="{{DEV}}" data-version="{{VERSION}}"><head>'
    '<base href="{{BASE}}"><script type="module" src="static/js/app.js?v={{VERSION}}"></script>'
    "</head><body></body></html>"
)


# --- Pomocnicze ---


def jpeg_bytes(size=(300, 450), color=(40, 90, 200)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def png_bytes(size=(1200, 1800)):
    buffer = io.BytesIO()
    image = Image.new("RGBA", size, (200, 30, 30, 255))
    ImageDraw.Draw(image).rectangle([10, 10, 100, 100], fill=(0, 0, 0, 0))
    image.save(buffer, format="PNG")
    return buffer.getvalue()


_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
_R = ["".join("1" if bit == "0" else "0" for bit in code) for code in _L]
_G = [code[::-1] for code in _R]
_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]


def ean13_photo(code, module=3, height=160, quiet=12):
    """Zdjęcie (JPEG) z narysowanym kodem EAN-13."""
    first, left, right = int(code[0]), code[1:7], code[7:]
    bits = "101"
    for digit, parity in zip(left, _PARITY[first]):
        bits += (_L if parity == "L" else _G)[int(digit)]
    bits += "01010" + "".join(_R[int(d)] for d in right) + "101"
    label = Image.new("L", ((len(bits) + 2 * quiet) * module, height + 2 * quiet * module), 255)
    draw = ImageDraw.Draw(label)
    for index, bit in enumerate(bits):
        if bit == "1":
            x = (quiet + index) * module
            draw.rectangle([x, quiet * module, x + module - 1, quiet * module + height], fill=0)
    photo = Image.new("RGB", (1200, 900), (170, 160, 150))
    photo.paste(label.convert("RGB"), ((1200 - label.width) // 2, (900 - label.height) // 2))
    buffer = io.BytesIO()
    photo.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def fake_remote(app, remote):
    """Udaje, że żądania przychodzą z adresu `remote` (np. proxy Ingress)."""

    @web.middleware
    async def middleware(request, handler):
        return await handler(request.clone(remote=remote))

    app.middlewares.insert(0, middleware)


async def wait_for_job(client, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = await (await client.get("/api/state")).json()
        job = state["meta"]["coverJob"]
        if job is not None and not job["running"]:
            return state
        await asyncio.sleep(0.01)
    raise AssertionError("zadanie pobierania okładek nie skończyło się")


def asset_key(client):
    """Klucz `?v=` plików statycznych uruchomionej aplikacji."""
    return client.server.app[server.SETTINGS].asset_key


def book_by_title(state, title):
    return next(b for b in state["books"] if b["title"] == title)


async def post_book(client, **draft):
    draft.setdefault("title", "Solaris")
    resp = await client.post("/api/books", json={"draft": draft})
    assert resp.status == 200, await resp.text()
    return (await resp.json())["id"]


# --- Fikstury ---


@pytest.fixture
def catalog_file(tmp_path):
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps(CATALOG, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def static_dir(tmp_path):
    root = tmp_path / "static"
    (root / "js" / "core").mkdir(parents=True)
    (root / "css").mkdir()
    (root / "vendor" / "zxing-wasm").mkdir(parents=True)
    (root / "index.html").write_text(TEMPLATE, encoding="utf-8")
    (root / "js" / "app.js").write_text("export const big = '" + "x" * 5000 + "';\n", encoding="utf-8")
    (root / "js" / "core" / "text.js").write_text("export const a = 1;\n", encoding="utf-8")
    (root / "css" / "app.css").write_text("body { color: red; }\n", encoding="utf-8")
    (root / "vendor" / "zxing-wasm" / "zxing_reader.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00" + bytes(4000))
    (root / "vendor" / "data.json").write_text('{"a": 1}', encoding="utf-8")
    (root / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    (root / "vendor" / "LICENSE").write_text("MIT", encoding="utf-8")
    (root / "server.py").write_text("print('nie')", encoding="utf-8")
    (root / ".hidden.js").write_text("tajne", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("TAJNE", encoding="utf-8")
    (tmp_path / "secret.js").write_text("TAJNE", encoding="utf-8")
    try:
        os.symlink(tmp_path / "secret.js", root / "js" / "link.js")
    except OSError:
        pass
    return root


@pytest_asyncio.fixture
async def make_client(aiohttp_client, tmp_path, catalog_file, static_dir):
    async def factory(dev=True, sample_data=False, remote=None, static=static_dir, catalog=catalog_file):
        app = server.create_app(
            tmp_path / "data", dev=dev, sample_data=sample_data, catalog_path=catalog, static_dir=static
        )
        if remote is not None:
            fake_remote(app, remote)
        return await aiohttp_client(app)

    return factory


@pytest_asyncio.fixture
async def client(make_client):
    return await make_client()


@pytest.fixture
def no_pause(monkeypatch):
    monkeypatch.setattr(server, "COVER_JOB_PAUSE", 0)


# --- Zdrowie, Ingress, nagłówki ---


async def test_healthz(client):
    resp = await client.get("/healthz")
    assert resp.status == 200
    assert resp.content_type == "text/plain"
    assert await resp.text() == "ok"


async def test_non_dev_rejects_everything_outside_ingress(make_client):
    client = await make_client(dev=False, remote="192.168.1.20")
    for path in ("/", "/api/state", "/static/js/app.js", "/healthz", "/nope"):
        resp = await client.get(path)
        assert resp.status == 403, path
        body = await resp.json()
        assert body["code"] == "forbidden"
        assert "Home Assistant" in body["error"]
    resp = await client.post("/api/books", json={"draft": {"title": "X"}})
    assert resp.status == 403


async def test_non_dev_allows_ingress_proxy(make_client):
    client = await make_client(dev=False, remote="172.30.32.2")
    assert (await client.get("/api/state")).status == 200
    assert (await client.get("/")).status == 200
    assert (await client.get("/healthz")).status == 200
    assert (await client.post("/api/books", json={"draft": {"title": "X"}})).status == 200


async def test_non_dev_allows_ipv4_mapped_ingress_address(make_client):
    client = await make_client(dev=False, remote="::ffff:172.30.32.2")
    assert (await client.get("/api/state")).status == 200


@pytest.mark.parametrize("remote", ["127.0.0.1", "::1"])
async def test_non_dev_localhost_only_for_healthz(make_client, remote):
    client = await make_client(dev=False, remote=remote)
    assert (await client.get("/healthz")).status == 200
    assert (await client.get("/api/state")).status == 403
    assert (await client.get("/")).status == 403


async def test_non_dev_without_fake_remote_uses_real_peer(make_client):
    # Klient testowy łączy się z 127.0.0.1 – tylko /healthz.
    client = await make_client(dev=False)
    assert (await client.get("/healthz")).status == 200
    assert (await client.get("/api/state")).status == 403


async def test_dev_mode_allows_any_address(make_client):
    client = await make_client(dev=True, remote="10.1.2.3")
    assert (await client.get("/api/state")).status == 200


async def test_cross_site_mutation_is_rejected(client):
    resp = await client.post(
        "/api/authors", json={"name": "Stanisław Lem"}, headers={"Sec-Fetch-Site": "cross-site"}
    )
    assert resp.status == 403
    assert (await resp.json())["code"] == "forbidden"
    # Odczyt i żądania z tej samej witryny przechodzą.
    assert (await client.get("/api/state", headers={"Sec-Fetch-Site": "cross-site"})).status == 200
    resp = await client.post("/api/authors", json={"name": "Stanisław Lem"}, headers={"Sec-Fetch-Site": "same-origin"})
    assert resp.status == 200


@pytest.mark.parametrize(
    "path", ["/", "/api/state", "/static/js/app.js", "/healthz", "/api/nope", "/static/missing.js"]
)
async def test_security_headers_everywhere(client, path):
    resp = await client.get(path)
    assert resp.headers["Content-Security-Policy"] == server.CONTENT_SECURITY_POLICY
    assert "script-src 'self' 'wasm-unsafe-eval'" in resp.headers["Content-Security-Policy"]
    assert "object-src 'none'" in resp.headers["Content-Security-Policy"]
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["Referrer-Policy"] == "no-referrer"


async def test_security_headers_on_forbidden(make_client):
    client = await make_client(dev=False, remote="8.8.8.8")
    resp = await client.get("/")
    assert resp.status == 403
    assert resp.headers["Content-Security-Policy"] == server.CONTENT_SECURITY_POLICY


# --- Strona główna ---


async def test_index_without_ingress_header(client, static_dir):
    resp = await client.get("/")
    assert resp.status == 200
    assert resp.content_type == "text/html"
    assert resp.headers["Cache-Control"] == "no-cache"
    page = await resp.text()
    assert '<base href="./">' in page
    key = asset_key(client)
    assert key == f"{__version__}-{server.static_tree_hash(static_dir)[:10]}"
    assert f'data-version="{key}"' in page
    assert f"app.js?v={key}" in page
    assert 'data-dev="true"' in page
    assert "{{" not in page


@pytest.mark.parametrize(
    "header, base",
    [
        ("/api/hassio_ingress/abcDEF_12-3", "/api/hassio_ingress/abcDEF_12-3/"),
        ("/api/hassio_ingress/abc/", "/api/hassio_ingress/abc/"),
        ('/api/hassio_ingress/x"><script>alert(1)</script>', "./"),
        ("javascript:alert(1)", "./"),
        ("//evil.example.com/x", "./"),
        ("", "./"),
    ],
)
async def test_index_base_from_ingress_header(make_client, header, base):
    client = await make_client(dev=False, remote="172.30.32.2")
    resp = await client.get("/", headers={"X-Ingress-Path": header})
    page = await resp.text()
    assert f'<base href="{base}">' in page
    assert 'data-dev="false"' in page
    assert "<script>alert" not in page


async def test_head_index(client):
    resp = await client.head("/")
    assert resp.status == 200
    assert await resp.read() == b""


async def test_real_index_template_renders(make_client):
    client = await make_client(static=server.STATIC_DIR)
    page = await (await client.get("/", headers={"X-Ingress-Path": "/api/hassio_ingress/tok"})).text()
    assert "{{" not in page
    assert 'href="/api/hassio_ingress/tok/"' in page
    resp = await client.get("/static/vendor/zxing-wasm/zxing_reader.wasm")
    assert resp.status == 200
    assert resp.content_type == "application/wasm"
    assert (await resp.read())[:4] == b"\x00asm"
    resp = await client.get("/static/js/app.js")
    assert resp.status == 200
    assert resp.content_type == "text/javascript"


# --- Pliki statyczne ---


@pytest.mark.parametrize(
    "path, mime",
    [
        ("js/app.js", "text/javascript"),
        ("js/core/text.js", "text/javascript"),
        ("css/app.css", "text/css"),
        ("vendor/zxing-wasm/zxing_reader.wasm", "application/wasm"),
        ("vendor/data.json", "application/json"),
        ("icon.svg", "image/svg+xml"),
    ],
)
async def test_static_mime_types(client, static_dir, path, mime):
    resp = await client.get(f"/static/{path}", headers={"Accept-Encoding": "identity"})
    assert resp.status == 200
    assert resp.content_type == mime
    assert await resp.read() == (static_dir / path).read_bytes()
    assert "Content-Encoding" not in resp.headers


@pytest.mark.parametrize(
    "raw_path",
    [
        "/static/../secret.txt",
        "/static/%2e%2e/secret.txt",
        "/static/%2E%2E%2Fsecret.txt",
        "/static/js/..%2f..%2fsecret.js",
        "/static/js/%2e%2e/%2e%2e/secret.js",
        "/static/..%5csecret.js",
        "/static/js/link.js",
        "/static/.hidden.js",
        "/static/server.py",
        "/static/vendor/LICENSE",
        "/static/js",
        "/static/js/",
        "/static/",
        "/static/index.html",
        "/static/%00.js",
        "/static//etc/passwd",
    ],
)
async def test_static_rejects_traversal_and_unknown_files(client, raw_path):
    resp = await client.get(URL(raw_path, encoded=True))
    assert resp.status == 404, raw_path
    body = await resp.read()
    assert b"TAJNE" not in body and b"print" not in body


async def test_static_cache_control_and_etag(make_client):
    client = await make_client(dev=False, remote="172.30.32.2")
    resp = await client.get(f"/static/js/app.js?v={asset_key(client)}")
    assert resp.headers["Cache-Control"] == "public, max-age=86400"
    etag = resp.headers["ETag"]
    # Sam numer wersji (bez skrótu zawartości) to już nieaktualny klucz.
    resp = await client.get(f"/static/js/app.js?v={__version__}")
    assert resp.headers["Cache-Control"] == "no-cache"
    # Moduły importowane bez wersji przeglądarka sprawdza za każdym razem.
    resp = await client.get("/static/js/core/text.js")
    assert resp.headers["Cache-Control"] == "no-cache"
    resp = await client.get("/static/js/app.js", headers={"If-None-Match": etag})
    assert resp.status == 304
    assert await resp.read() == b""


async def test_static_dev_mode_never_long_cached(client):
    resp = await client.get(f"/static/js/app.js?v={asset_key(client)}")
    assert resp.headers["Cache-Control"] == "no-cache"


async def test_asset_key_follows_static_files(make_client, static_dir):
    """pkg-1: po aktualizacji (albo „Przebuduj”) bez zmiany numeru wersji przeglądarki dostają nowe pliki."""
    first = await make_client(dev=False, remote="172.30.32.2")
    old_key = asset_key(first)
    old_page = await (await first.get("/")).text()
    await first.close()

    (static_dir / "css" / "app.css").write_text("body { color: blue; }\n", encoding="utf-8")
    second = await make_client(dev=False, remote="172.30.32.2")
    new_key = asset_key(second)
    assert new_key != old_key and new_key.startswith(f"{__version__}-")
    page = await (await second.get("/")).text()
    assert f'data-version="{new_key}"' in page and f'data-version="{old_key}"' in old_page
    assert f"app.js?v={new_key}" in page
    # Stary adres z pamięci przeglądarki nie jest już trzymany przez dobę – tylko z ETag-iem.
    resp = await second.get(f"/static/css/app.css?v={old_key}")
    assert resp.headers["Cache-Control"] == "no-cache"
    assert "blue" in await resp.text()
    resp = await second.get(f"/static/css/app.css?v={new_key}")
    assert resp.headers["Cache-Control"] == "public, max-age=86400"
    # Klient porównuje `appVersion` z `data-version` i proponuje odświeżenie strony.
    assert (await (await second.get("/api/state")).json())["appVersion"] == new_key


async def test_static_change_on_disk_is_served(client, static_dir):
    first = await (await client.get("/static/js/core/text.js")).text()
    path = static_dir / "js" / "core" / "text.js"
    path.write_text("export const a = 22;\n", encoding="utf-8")
    os.utime(path, ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))
    second = await (await client.get("/static/js/core/text.js")).text()
    assert first != second and "22" in second


async def test_static_gzip(client, static_dir):
    resp = await client.get("/static/js/app.js", headers={"Accept-Encoding": "gzip, deflate"})
    assert resp.headers["Content-Encoding"] == "gzip"
    assert resp.headers["Vary"] == "Accept-Encoding"
    assert await resp.read() == (static_dir / "js" / "app.js").read_bytes()
    resp = await client.get("/static/vendor/zxing-wasm/zxing_reader.wasm", headers={"Accept-Encoding": "gzip"})
    assert resp.headers["Content-Encoding"] == "gzip"
    resp = await client.get("/static/js/app.js", headers={"Accept-Encoding": "gzip;q=0"})
    assert "Content-Encoding" not in resp.headers


async def test_json_responses_are_gzipped(client):
    await client.post("/api/sample-data")
    resp = await client.get("/api/state", headers={"Accept-Encoding": "gzip"})
    assert resp.headers.get("Content-Encoding") == "gzip"
    assert (await resp.json())["books"]


async def test_json_gzip_raw_bytes(make_client):
    client = await make_client()
    await client.post("/api/sample-data")
    async with aiohttp.ClientSession(auto_decompress=False) as session:
        async with session.get(client.make_url("/api/state"), headers={"Accept-Encoding": "gzip"}) as resp:
            raw = await resp.read()
    assert json.loads(gzip.decompress(raw))["books"]


# --- Stan i ETag ---


async def test_state_shape_and_meta(client):
    resp = await client.get("/api/state")
    assert resp.status == 200
    assert resp.headers["Cache-Control"] == "no-cache"
    state = await resp.json()
    assert state["appVersion"] == asset_key(client)
    assert state["appVersion"].startswith(f"{__version__}-")
    assert state["meta"] == {
        "catalogAvailable": True,
        "devMode": True,
        "barcodeServerDecode": barcode.available(),
        "coverJob": None,
    }
    # Katalog zasiany przy starcie (pozycje „nie mam”).
    assert {b["title"] for b in state["books"]} == {"Pucio uczy się mówić", "Dzieci z Bullerbyn"}
    assert not any(b["isOwned"] for b in state["books"])


async def test_state_etag_and_304(client):
    resp = await client.get("/api/state")
    etag = resp.headers["ETag"]
    assert etag.startswith('"r') and etag.endswith('"')
    revision = (await resp.json())["revision"]
    assert etag.startswith(f'"r{revision}-')

    resp = await client.get("/api/state", headers={"If-None-Match": etag})
    assert resp.status == 304
    assert resp.headers["ETag"] == etag
    assert await resp.read() == b""
    assert (await client.get("/api/state", headers={"If-None-Match": "W/" + etag})).status == 304
    assert (await client.get("/api/state", headers={"If-None-Match": f'"zzz", {etag}'})).status == 304
    assert (await client.get("/api/state", headers={"If-None-Match": '"r0-old-0"'})).status == 200

    await post_book(client)
    resp = await client.get("/api/state", headers={"If-None-Match": etag})
    assert resp.status == 200
    assert resp.headers["ETag"] != etag
    assert (await resp.json())["revision"] == revision + 1


async def test_state_etag_changes_after_restart(make_client):
    first = await make_client()
    etag = (await first.get("/api/state")).headers["ETag"]
    await first.close()
    second = await make_client()
    resp = await second.get("/api/state", headers={"If-None-Match": etag})
    # Ta sama rewizja, ale inne uruchomienie (np. inna wersja albo tryb) – pełny stan.
    assert resp.status == 200


# --- Błędy ---


async def test_invalid_json_body(client):
    resp = await client.post("/api/books", data=b"{nie json", headers={"Content-Type": "application/json"})
    assert resp.status == 400
    assert await resp.json() == {"error": "Niepoprawne dane żądania.", "code": "invalid_json"}
    resp = await client.post("/api/books", json=[1, 2])
    assert (await resp.json())["code"] == "invalid_json"
    resp = await client.post("/api/books", data=b"\xff\xfe", headers={"Content-Type": "application/json"})
    assert (await resp.json())["code"] == "invalid_json"


async def test_library_errors_as_json(client):
    resp = await client.post("/api/books", json={"draft": {"title": "   "}})
    assert resp.status == 400
    assert await resp.json() == {"error": "Podaj tytuł książki.", "code": "title_required"}
    resp = await client.post("/api/books", json={})
    assert (await resp.json())["code"] == "invalid_draft"
    resp = await client.put("/api/books/999", json={"draft": {"title": "X"}})
    assert resp.status == 404
    body = await resp.json()
    assert body["code"] == "book_not_found"
    assert body["error"].startswith("Nie ma już tej książki")


async def test_routing_errors_as_json(client):
    resp = await client.get("/api/nope")
    assert resp.status == 404
    assert await resp.json() == {"error": "Nie znaleziono.", "code": "not_found"}
    resp = await client.get("/api/books/abc")
    assert resp.status == 404
    resp = await client.patch("/api/state")
    assert resp.status == 405
    assert (await resp.json())["code"] == "method_not_allowed"
    assert "GET" in resp.headers["Allow"]


async def test_unexpected_error_is_500_json(client, monkeypatch, caplog):
    def boom(*args, **kwargs):
        raise RuntimeError("awaria")

    monkeypatch.setattr(views, "build_state", boom)
    resp = await client.get("/api/state")
    assert resp.status == 500
    assert await resp.json() == {"error": "Wystąpił nieoczekiwany błąd.", "code": "internal"}
    assert "awaria" in caplog.text


@pytest.mark.parametrize("adopt", [True, "5", -1, 0, 2**70, 1.5])
async def test_invalid_ids_in_body(client, adopt):
    resp = await client.post("/api/books", json={"draft": {"title": "X"}, "adoptId": adopt})
    assert resp.status == 400
    assert (await resp.json())["code"] == "invalid_id"


async def test_huge_path_id_is_not_found(client):
    resp = await client.delete("/api/books/" + "9" * 30)
    assert resp.status == 404


# --- Książki ---


async def test_book_lifecycle(client):
    state = await (await client.get("/api/state")).json()
    rev = state["revision"]

    resp = await client.post(
        "/api/books",
        json={"draft": {"title": "Ostatnie życzenie", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin",
                        "volumeNumber": 1, "isOwned": True, "isbn": "978-83-7578-063-5"}},
    )
    assert resp.status == 200
    created = await resp.json()
    assert created["revision"] == rev + 1
    book_id = created["id"]

    state = await (await client.get("/api/state")).json()
    book = next(b for b in state["books"] if b["id"] == book_id)
    assert book["isbn"] == ISBN_A
    assert book["seriesLine"] is not None
    assert any(s["name"] == "Wiedźmin" for s in state["series"])

    resp = await client.put(f"/api/books/{book_id}", json={"draft": {"title": "Ostatnie życzenie", "isOwned": True,
                                                                     "authorName": "Andrzej Sapkowski",
                                                                     "seriesName": "Wiedźmin", "volumeNumber": 2}})
    assert (await resp.json()) == {"id": book_id, "revision": rev + 2}

    resp = await client.post(f"/api/books/{book_id}/owned", json={"isOwned": False})
    assert (await resp.json())["revision"] == rev + 3
    resp = await client.post(f"/api/books/{book_id}/owned", json={})
    assert resp.status == 400

    resp = await client.post(
        f"/api/books/{book_id}/complete",
        json={"edition": {"publisher": "superNOWA", "publicationYear": 2014, "pageCount": 332}, "markOwned": True},
    )
    assert resp.status == 200
    state = await (await client.get("/api/state")).json()
    book = next(b for b in state["books"] if b["id"] == book_id)
    assert (book["isOwned"], book["publisher"], book["publicationYear"], book["pageCount"]) == (
        True, "superNOWA", 2014, 332)

    resp = await client.delete(f"/api/books/{book_id}")
    assert resp.status == 200
    state = await (await client.get("/api/state")).json()
    assert all(b["id"] != book_id for b in state["books"])
    # Seria i autor bez książek znikają razem z ostatnią książką.
    assert all(s["name"] != "Wiedźmin" for s in state["series"])
    assert (await client.delete(f"/api/books/{book_id}")).status == 404


async def test_adopt_catalog_book(client):
    state = await (await client.get("/api/state")).json()
    pucio = book_by_title(state, "Pucio uczy się mówić")
    resp = await client.post(
        "/api/books",
        json={"draft": {"title": "Pucio uczy się mówić", "authorName": "Marta Galewska-Kustra",
                        "seriesName": "Pucio", "volumeNumber": 1, "isOwned": True}, "adoptId": pucio["id"]},
    )
    assert (await resp.json())["id"] == pucio["id"]
    state = await (await client.get("/api/state")).json()
    assert book_by_title(state, "Pucio uczy się mówić")["isOwned"] is True
    assert len([b for b in state["books"] if b["title"] == "Pucio uczy się mówić"]) == 1


async def test_input_is_nfc_normalized(client):
    decomposed = unicodedata.normalize("NFD", "Stanisław Lem – Żółć")
    assert decomposed != unicodedata.normalize("NFC", decomposed)
    book_id = await post_book(client, title=decomposed, authorName=decomposed)
    state = await (await client.get("/api/state")).json()
    book = next(b for b in state["books"] if b["id"] == book_id)
    assert book["title"] == unicodedata.normalize("NFC", decomposed)
    assert any(a["name"] == unicodedata.normalize("NFC", decomposed) for a in state["authors"])


# --- Serie i autorzy ---


async def test_series_endpoints(client):
    resp = await client.post("/api/series", json={"draft": {"name": "Diuna", "authorName": "Frank Herbert",
                                                            "plannedVolumeCount": 6}})
    assert resp.status == 200
    series_id = (await resp.json())["id"]
    resp = await client.post("/api/series", json={"draft": {"name": "Diuna", "authorName": "Frank Herbert"}})
    assert resp.status == 409
    body = await resp.json()
    assert body["code"] == "series_exists"
    assert body["error"] == "Taka seria jest już w biblioteczce."

    resp = await client.put(f"/api/series/{series_id}", json={"draft": {"name": "Kroniki Diuny",
                                                                        "authorName": "Frank Herbert"}})
    assert (await resp.json())["id"] == series_id
    await post_book(client, title="Diuna", authorName="Frank Herbert", seriesName="Kroniki Diuny", volumeNumber=1)

    assert (await client.delete(f"/api/series/{series_id}?withBooks=tak")).status == 400
    resp = await client.delete(f"/api/series/{series_id}?withBooks=0")
    assert resp.status == 200
    state = await (await client.get("/api/state")).json()
    assert all(s["id"] != series_id for s in state["series"])
    book = book_by_title(state, "Diuna")
    assert book["seriesId"] is None

    resp = await client.post("/api/series", json={"draft": {"name": "Ziemiomorze"}})
    second = (await resp.json())["id"]
    await post_book(client, title="Czarnoksiężnik z Archipelagu", seriesName="Ziemiomorze", volumeNumber=1)
    assert (await client.delete(f"/api/series/{second}?withBooks=1")).status == 200
    state = await (await client.get("/api/state")).json()
    assert all(b["title"] != "Czarnoksiężnik z Archipelagu" for b in state["books"])
    assert (await client.delete(f"/api/series/{second}")).status == 404


async def test_author_endpoints(client):
    resp = await client.post("/api/authors", json={"name": "Stanisław Lem"})
    first = await resp.json()
    assert first["mergedInto"] is None and isinstance(first["revision"], int)
    resp = await client.post("/api/authors", json={"name": "  Stanisław   Lem "})
    assert resp.status == 409
    assert (await resp.json())["code"] == "author_exists"
    resp = await client.post("/api/authors", json={"name": ""})
    assert (await resp.json())["code"] == "name_required"

    second = await (await client.post("/api/authors", json={"name": "S. Lem"})).json()
    await post_book(client, title="Solaris", authorName="S. Lem")
    resp = await client.put(f"/api/authors/{second['id']}", json={"name": "Stanisław Lem"})
    merged = await resp.json()
    assert merged["id"] == first["id"] and merged["mergedInto"] == first["id"]
    state = await (await client.get("/api/state")).json()
    assert book_by_title(state, "Solaris")["authorId"] == first["id"]

    resp = await client.delete(f"/api/authors/{first['id']}?withBooks=1")
    assert resp.status == 200
    state = await (await client.get("/api/state")).json()
    assert all(b["title"] != "Solaris" for b in state["books"])
    assert (await client.delete(f"/api/authors/{first['id']}?withBooks=0")).status == 404


# --- Okładki ---


async def test_cover_upload_and_download(client):
    resp = await client.post("/api/covers", data=png_bytes(), headers={"Content-Type": "image/png"})
    assert resp.status == 200
    cover_id = (await resp.json())["coverId"]
    assert len(cover_id) == 40 and all(c in "0123456789abcdef" for c in cover_id)

    resp = await client.get(f"/api/covers/{cover_id}.jpg")
    assert resp.status == 200
    assert resp.content_type == "image/jpeg"
    assert resp.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    with Image.open(io.BytesIO(await resp.read())) as image:
        assert image.format == "JPEG"
        assert max(image.size) == 900

    # Ta sama treść → ten sam identyfikator.
    again = await (await client.post("/api/covers", data=png_bytes(), headers={"Content-Type": "image/png"})).json()
    assert again["coverId"] == cover_id

    book_id = await post_book(client, title="Z okładką", coverId=cover_id)
    state = await (await client.get("/api/state")).json()
    assert next(b for b in state["books"] if b["id"] == book_id)["coverId"] == cover_id


@pytest.mark.parametrize(
    "name, status",
    [
        ("ABCDEF0123456789ABCDEF0123456789ABCDEF01.jpg", 400),
        ("abc.jpg", 400),
        ("0123456789abcdef0123456789abcdef01234567.png", 400),
        ("0123456789abcdef0123456789abcdef01234567", 400),
        ("..%2F..%2Fbiblioteczka.db", 400),
        ("0123456789abcdef0123456789abcdef01234567.jpg", 404),
    ],
)
async def test_cover_id_validation(client, name, status):
    resp = await client.get(URL(f"/api/covers/{name}", encoded=True))
    assert resp.status == status
    assert (await resp.json())["code"] in ("invalid_cover", "cover_not_found")


async def test_cover_upload_rejects_bad_images(client):
    resp = await client.post("/api/covers", data=b"to nie jest obraz", headers={"Content-Type": "image/jpeg"})
    assert resp.status == 415
    assert (await resp.json())["code"] == "invalid_image"
    resp = await client.post("/api/covers", data=jpeg_bytes(size=(30, 200)))
    assert resp.status == 415
    resp = await client.post("/api/covers", data=b"")
    assert resp.status == 400
    assert (await resp.json())["code"] == "empty_body"


async def test_upload_size_limit(client):
    too_big = b"\xff\xd8" + bytes(server.MAX_BODY_BYTES)
    for path in ("/api/covers", "/api/barcode", "/api/import/csv"):
        resp = await client.post(path, data=io.BytesIO(too_big), headers={"Content-Type": "application/octet-stream"})
        assert resp.status == 413, path
        body = await resp.json()
        assert body["code"] == "too_large"
        assert "20 MB" in body["error"]


async def test_upload_just_under_limit_is_read(client, monkeypatch):
    seen = {}

    def fake_downscale(data, *args, **kwargs):
        seen["size"] = len(data)
        return None

    monkeypatch.setattr(server.covers, "downscale", fake_downscale)
    resp = await client.post("/api/covers", data=io.BytesIO(bytes(server.MAX_BODY_BYTES - 10)))
    assert resp.status == 415
    assert seen["size"] == server.MAX_BODY_BYTES - 10


async def test_cover_gc_removes_only_old_orphans(client, tmp_path):
    app = client.server.app
    used = (await (await client.post("/api/covers", data=jpeg_bytes())).json())["coverId"]
    await post_book(client, title="Z okładką", coverId=used)
    orphan = (await (await client.post("/api/covers", data=jpeg_bytes(color=(1, 2, 3)))).json())["coverId"]
    fresh = (await (await client.post("/api/covers", data=jpeg_bytes(color=(9, 9, 9)))).json())["coverId"]
    covers_dir = tmp_path / "data" / "covers"
    old = time.time() - 2 * 86400
    for cover_id in (used, orphan):
        os.utime(covers_dir / f"{cover_id}.jpg", (old, old))

    assert server.collect_orphan_covers(app) == 1
    assert (covers_dir / f"{used}.jpg").exists()
    assert not (covers_dir / f"{orphan}.jpg").exists()
    assert (covers_dir / f"{fresh}.jpg").exists()


# --- Wyszukiwanie po ISBN ---


async def test_lookup_found_stores_cover_and_resolves(client, monkeypatch):
    calls = []
    cover = jpeg_bytes(size=(400, 600))

    async def fake_lookup(isbn, session):
        calls.append(isbn.digits)
        info = BookInfo(isbn=isbn, title="Ostatnie życzenie", author_name="Andrzej Sapkowski",
                        series_name="Wiedźmin", is_series_certain=True, volume_number=1,
                        publisher="superNOWA", year=2014, page_count=332, cover=cover,
                        sources=["Biblioteka Narodowa"])
        return LookupResult("found", info)

    monkeypatch.setattr(lookup, "lookup", fake_lookup)
    resp = await client.post("/api/lookup", json={"isbn": "978-83-7578-063-5"})
    assert resp.status == 200
    result = await resp.json()
    assert calls == [ISBN_A]
    assert result["status"] == "found"
    info = result["info"]
    assert info["isbn"] == ISBN_A
    assert info["title"] == "Ostatnie życzenie"
    assert info["year"] == 2014 and info["pageCount"] == 332
    assert info["sources"] == ["Biblioteka Narodowa"]
    assert "cover" not in info
    cover_resp = await client.get(f"/api/covers/{info['coverId']}.jpg")
    assert cover_resp.status == 200

    resolution = result["resolution"]
    assert resolution["libraryBookId"] is None
    assert resolution["seriesName"] == "Wiedźmin"
    assert resolution["volumeNumber"] == 1
    assert resolution["isbnBookIds"] == []

    # Książka z tym numerem w bazie → jej id w `isbnBookIds`.
    book_id = await post_book(client, title="Ostatnie życzenie", authorName="Andrzej Sapkowski", isbn=ISBN_A)
    result = await (await client.post("/api/lookup", json={"isbn": ISBN_A})).json()
    assert result["resolution"]["isbnBookIds"] == [book_id]


async def test_lookup_passes_form_and_editing_book(client, monkeypatch):
    async def fake_lookup(isbn, session):
        return LookupResult("found", BookInfo(isbn=isbn, title="Inny tytuł", author_name="Ktoś"))

    monkeypatch.setattr(lookup, "lookup", fake_lookup)
    book_id = await post_book(client, title="Mój tytuł", authorName="Mój autor")
    result = await (
        await client.post("/api/lookup", json={"isbn": ISBN_B, "editingBookId": book_id,
                                               "form": {"title": "Mój tytuł", "authorName": "", "seriesName": ""}})
    ).json()
    resolution = result["resolution"]
    # Edytowana książka zachowuje tytuł; pusty autor w formularzu jest uzupełniany.
    assert resolution["title"] == "Mój tytuł"
    assert resolution["authorName"] == "Ktoś"
    assert result["info"]["coverId"] is None


@pytest.mark.parametrize("status", ["notFound", "offline"])
async def test_lookup_without_result(client, monkeypatch, status):
    async def fake_lookup(isbn, session):
        return LookupResult(status)

    monkeypatch.setattr(lookup, "lookup", fake_lookup)
    result = await (await client.post("/api/lookup", json={"isbn": ISBN_C})).json()
    assert result == {"status": status, "info": None, "resolution": None}


@pytest.mark.parametrize("isbn", ["9788375780636", "123", "", None, 9788375780635, "abc"])
async def test_lookup_invalid_isbn_does_not_go_online(client, monkeypatch, isbn):
    async def fake_lookup(isbn, session):
        raise AssertionError("nie powinno pytać internetu")

    monkeypatch.setattr(lookup, "lookup", fake_lookup)
    result = await (await client.post("/api/lookup", json={"isbn": isbn})).json()
    assert result == {"status": "invalid", "info": None, "resolution": None}


async def test_lookup_for_deleted_book(client, monkeypatch):
    async def fake_lookup(isbn, session):
        raise AssertionError("nie powinno pytać internetu")

    monkeypatch.setattr(lookup, "lookup", fake_lookup)
    resp = await client.post("/api/lookup", json={"isbn": ISBN_A, "editingBookId": 4242})
    assert resp.status == 404
    assert (await resp.json())["code"] == "book_not_found"
    resp = await client.post("/api/lookup", json={"isbn": ISBN_A, "form": "zły"})
    assert resp.status == 400


# --- Kody kreskowe ---


async def test_barcode_decode(client):
    if not barcode.available():
        pytest.skip("brak zxing-cpp")
    resp = await client.post("/api/barcode", data=ean13_photo(ISBN_A), headers={"Content-Type": "image/jpeg"})
    assert resp.status == 200
    result = await resp.json()
    assert result["available"] is True
    assert result["kind"] == "book"
    assert result["isbn"] == ISBN_A
    assert ISBN_A in result["codes"]

    blank = jpeg_bytes(size=(800, 600), color=(255, 255, 255))
    result = await (await client.post("/api/barcode", data=blank)).json()
    assert result == {"available": True, "kind": "none", "isbn": None, "codes": []}
    resp = await client.post("/api/barcode", data=b"")
    assert resp.status == 400


async def test_barcode_unavailable(client, monkeypatch):
    monkeypatch.setattr(barcode, "_zxing", None)
    result = await (await client.post("/api/barcode", data=ean13_photo(ISBN_A))).json()
    assert result == {"available": False, "kind": "none", "isbn": None, "codes": []}
    state = await (await client.get("/api/state")).json()
    assert state["meta"]["barcodeServerDecode"] is False


# --- CSV ---


async def test_csv_export_and_import_round_trip(client):
    await post_book(client, title="Ostatnie życzenie", authorName="Andrzej Sapkowski", seriesName="Wiedźmin",
                    volumeNumber=1, isbn=ISBN_A, publisher="superNOWA", publicationYear=2014, pageCount=332,
                    notes='Notatka z "cudzysłowem";\nI nową linią')
    await post_book(client, title="Miecz przeznaczenia", authorName="Andrzej Sapkowski", seriesName="Wiedźmin",
                    volumeNumber=2, isOwned=False)
    await post_book(client, title="Solaris", authorName="Stanisław Lem")

    resp = await client.get("/api/export.csv")
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "text/csv; charset=utf-8"
    assert resp.headers["Content-Disposition"] == 'attachment; filename="Biblioteczka.csv"'
    exported = await resp.read()
    assert exported.startswith("﻿".encode("utf-8"))
    text = exported.decode("utf-8")
    assert text.lstrip("﻿").startswith('"Tytuł";"Autor";"Seria";"Tom";"Status"')
    assert '"Brakuje"' in text and '"Mam"' in text
    assert not text.endswith("\r\n")

    await client.delete("/api/library")
    state = await (await client.get("/api/state")).json()
    assert state["books"] == []

    resp = await client.post("/api/import/csv", data=exported, headers={"Content-Type": "text/csv; charset=utf-8"})
    assert resp.status == 200
    report = await resp.json()
    assert report["added"] == 3 and report["updated"] == 0 and report["errors"] == []
    assert isinstance(report["revision"], int)

    again = await (await client.get("/api/export.csv")).read()
    assert again == exported

    # Ponowny import tego samego pliku niczego nie dubluje.
    report = await (await client.post("/api/import/csv", data=exported)).json()
    assert report["added"] == 0


async def test_csv_import_windows_1250(client):
    text = '"Tytuł";"Autor";"Status"\r\n"Żółta łódź";"Józef Ćwik";"Mam"'
    resp = await client.post("/api/import/csv", data=text.encode("cp1250"), headers={"Content-Type": "text/csv"})
    assert (await resp.json())["added"] == 1
    state = await (await client.get("/api/state")).json()
    assert book_by_title(state, "Żółta łódź")["isOwned"] is True


async def test_csv_import_errors(client):
    resp = await client.post("/api/import/csv", data=b"")
    assert resp.status == 400
    assert (await resp.json())["code"] == "csv_empty"
    resp = await client.post("/api/import/csv", data="a;b\r\n1;2".encode())
    assert resp.status == 400
    assert (await resp.json())["code"] == "csv_no_header"


# --- Katalog, przykładowe dane, usuwanie ---


async def test_catalog_import_after_delete_all(client):
    result = await (await client.post("/api/catalog/import")).json()
    assert result["added"] == 0
    await client.delete("/api/library")
    result = await (await client.post("/api/catalog/import")).json()
    assert result["added"] == 2
    state = await (await client.get("/api/state")).json()
    assert state["revision"] == result["revision"]


async def test_catalog_unavailable(make_client, tmp_path):
    client = await make_client(catalog=tmp_path / "brak.json")
    state = await (await client.get("/api/state")).json()
    assert state["meta"]["catalogAvailable"] is False
    assert state["books"] == []
    assert (await (await client.post("/api/catalog/import")).json())["added"] == 0


async def test_delete_library(client):
    await post_book(client)
    resp = await client.delete("/api/library")
    assert resp.status == 200
    state = await (await client.get("/api/state")).json()
    assert state["books"] == state["series"] == state["authors"] == []
    assert state["revision"] == (await resp.json())["revision"]


async def test_ids_are_never_reused(client):
    """sync-1: nieaktualny edytor (inne urządzenie) nie nadpisze nowej pozycji, która dostałaby to samo id."""
    first = (await (await client.post("/api/series", json={"draft": {"name": "Seria A"}})).json())["id"]
    assert (await client.delete(f"/api/series/{first}?withBooks=0")).status == 200
    second = (await (await client.post("/api/series", json={"draft": {"name": "Seria B"}})).json())["id"]
    assert second > first

    old_book = await post_book(client, title="Książka A", authorName="Ktoś")
    assert (await client.delete(f"/api/books/{old_book}")).status == 200
    new_book = await post_book(client, title="Książka B", authorName="Ktoś Inny")
    assert new_book > old_book
    resp = await client.put(f"/api/books/{old_book}", json={"draft": {"title": "Książka A (poprawiona)"}})
    assert resp.status == 404
    assert book_by_title(await (await client.get("/api/state")).json(), "Książka B")["id"] == new_book

    # „Usuń wszystkie dane” nie zaczyna numeracji od nowa.
    state = await (await client.get("/api/state")).json()
    before = {kind: max(item["id"] for item in state[kind]) for kind in ("books", "series", "authors")}
    assert (await client.delete("/api/library")).status == 200
    book_id = await post_book(client, title="Po usunięciu", authorName="Nowy autor", seriesName="Nowa seria")
    state = await (await client.get("/api/state")).json()
    after = {"books": book_id, "series": state["series"][0]["id"], "authors": state["authors"][0]["id"]}
    assert all(after[kind] > before[kind] for kind in before), (before, after)


async def test_sample_data_only_in_dev(make_client):
    dev = await make_client(dev=True)
    resp = await dev.post("/api/sample-data")
    assert resp.status == 200
    assert (await resp.json())["added"] > 0
    await dev.close()

    prod = await make_client(dev=False, remote="172.30.32.2")
    resp = await prod.post("/api/sample-data")
    assert resp.status == 404
    assert (await resp.json())["code"] == "not_found"


async def test_sample_data_on_start_goes_before_catalog(make_client):
    client = await make_client(sample_data=True)
    state = await (await client.get("/api/state")).json()
    titles = {b["title"] for b in state["books"]}
    assert "Ostatnie życzenie" in titles
    assert "Pucio uczy się mówić" in titles
    await client.close()
    # Kolejny start: baza nie jest pusta, więc bez drugiej kopii.
    client = await make_client(sample_data=True)
    state = await (await client.get("/api/state")).json()
    assert len([b for b in state["books"] if b["title"] == "Ostatnie życzenie"]) == 1


async def test_data_persists_between_starts(make_client, tmp_path):
    client = await make_client()
    book_id = await post_book(client, title="Trwała książka")
    await client.close()
    client = await make_client()
    state = await (await client.get("/api/state")).json()
    assert any(b["id"] == book_id for b in state["books"])
    assert (tmp_path / "data" / "biblioteczka.db").is_file()


# --- Pobieranie brakujących okładek ---


async def test_fetch_missing_covers_job(client, monkeypatch, no_pause):
    active = 0
    peak = 0
    asked = []
    release = asyncio.Event()

    async def fake_fetch_cover(isbn, session):
        nonlocal active, peak
        asked.append(isbn.digits)
        active += 1
        peak = max(peak, active)
        await release.wait()
        await asyncio.sleep(0.01)
        active -= 1
        return None if isbn.digits == ISBN_C else jpeg_bytes(color=(int(isbn.digits[-2:]), 50, 50))

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)

    a1 = await post_book(client, title="A1", isbn=ISBN_A)
    a2 = await post_book(client, title="A2", isbn=ISBN_A, isOwned=False)
    b = await post_book(client, title="B", isbn=ISBN_B)
    c = await post_book(client, title="C", isbn=ISBN_C)
    await post_book(client, title="Bez ISBN")
    await post_book(client, title="Zły ISBN", isbn="12345")
    cover = (await (await client.post("/api/covers", data=jpeg_bytes())).json())["coverId"]
    with_cover = await post_book(client, title="Ma okładkę", isbn=ISBN_B, coverId=cover)
    rev_before = (await (await client.get("/api/state")).json())["revision"]

    resp = await client.post("/api/covers/fetch-missing")
    assert await resp.json() == {"started": True, "total": 4, "revision": rev_before}
    state = await (await client.get("/api/state")).json()
    assert state["meta"]["coverJob"] == {"running": True, "total": 4, "done": 0, "found": 0}

    # Drugie zlecenie w trakcie nie uruchamia kolejnego zadania.
    resp = await client.post("/api/covers/fetch-missing")
    assert (await resp.json())["started"] is False
    assert (await resp.json())["total"] == 4

    release.set()
    state = await wait_for_job(client)
    job = state["meta"]["coverJob"]
    assert job == {"running": False, "total": 4, "done": 4, "found": 3}
    assert peak == 2
    assert sorted(asked) == sorted([ISBN_A, ISBN_B, ISBN_C])  # jeden numer = jedno zapytanie

    books = {bk["id"]: bk for bk in state["books"]}
    assert books[a1]["coverId"] and books[a1]["coverId"] == books[a2]["coverId"]
    assert books[b]["coverId"] and books[b]["coverId"] != books[a1]["coverId"]
    assert books[c]["coverId"] is None
    assert books[with_cover]["coverId"] == cover
    assert state["revision"] == rev_before + 2  # jedna transakcja na każdą znalezioną okładkę

    # Nic już nie brakuje oprócz okładki dla C.
    resp = await client.post("/api/covers/fetch-missing")
    assert (await resp.json())["total"] == 1


async def test_fetch_missing_covers_nothing_to_do(client):
    await post_book(client, title="Bez ISBN")
    assert await (await client.post("/api/covers/fetch-missing")).json() == {
        "started": False, "total": 0, "revision": (await (await client.get("/api/state")).json())["revision"]}
    state = await (await client.get("/api/state")).json()
    assert state["meta"]["coverJob"] is None


async def test_cover_job_progress_changes_etag(client, monkeypatch, no_pause):
    gate = asyncio.Event()

    async def fake_fetch_cover(isbn, session):
        await gate.wait()
        return None

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    await post_book(client, title="A", isbn=ISBN_A)
    etag = (await client.get("/api/state")).headers["ETag"]
    await client.post("/api/covers/fetch-missing")
    resp = await client.get("/api/state", headers={"If-None-Match": etag})
    assert resp.status == 200  # rewizja ta sama, ale zmienił się postęp zadania
    gate.set()
    await wait_for_job(client)


async def test_cover_job_respects_changes_made_meanwhile(client, monkeypatch, no_pause):
    gate = asyncio.Event()

    async def fake_fetch_cover(isbn, session):
        await gate.wait()
        return jpeg_bytes()

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    book_id = await post_book(client, title="A", isbn=ISBN_A)
    await client.post("/api/covers/fetch-missing")
    own = (await (await client.post("/api/covers", data=png_bytes())).json())["coverId"]
    await client.put(f"/api/books/{book_id}", json={"draft": {"title": "A", "isbn": ISBN_A, "coverId": own}})
    gate.set()
    state = await wait_for_job(client)
    assert state["meta"]["coverJob"]["found"] == 0
    assert book_by_title(state, "A")["coverId"] == own


async def test_cover_job_survives_fetch_errors(client, monkeypatch, no_pause):
    async def fake_fetch_cover(isbn, session):
        if isbn.digits == ISBN_A:
            raise RuntimeError("awaria")
        return jpeg_bytes()

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    await post_book(client, title="A", isbn=ISBN_A)
    await post_book(client, title="B", isbn=ISBN_B)
    await client.post("/api/covers/fetch-missing")
    state = await wait_for_job(client)
    assert state["meta"]["coverJob"] == {"running": False, "total": 2, "done": 2, "found": 1}


async def test_shutdown_cancels_running_cover_job(make_client, monkeypatch, no_pause):
    cancelled = asyncio.Event()

    async def fake_fetch_cover(isbn, session):
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    client = await make_client()
    await post_book(client, title="A", isbn=ISBN_A)
    await client.post("/api/covers/fetch-missing")
    await asyncio.sleep(0.01)
    app = client.server.app
    await asyncio.wait_for(client.close(), timeout=5)
    assert cancelled.is_set()
    assert app[server.COVER_JOB].running is False


async def test_delete_library_stops_cover_job(client, monkeypatch, no_pause):
    """sec-5: „Usuń wszystkie dane” przerywa pobieranie okładek i pozwala od razu uruchomić nowe."""
    cancelled = asyncio.Event()
    asked = []

    async def slow_fetch_cover(isbn, session):
        asked.append(isbn.digits)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(lookup, "fetch_cover", slow_fetch_cover)
    await post_book(client, title="A", isbn=ISBN_A)
    await post_book(client, title="B", isbn=ISBN_B)
    assert (await (await client.post("/api/covers/fetch-missing")).json())["started"] is True
    await asyncio.sleep(0.01)
    assert (await (await client.get("/api/state")).json())["meta"]["coverJob"]["running"] is True

    resp = await client.delete("/api/library")
    assert resp.status == 200
    assert cancelled.is_set()
    job = client.server.app[server.COVER_JOB]
    assert job.task is None and not job.running
    state = await (await client.get("/api/state")).json()
    assert state["books"] == []
    assert state["meta"]["coverJob"] is None  # karta postępu znika

    async def quick_fetch_cover(isbn, session):
        asked.append(isbn.digits)
        return jpeg_bytes()

    monkeypatch.setattr(lookup, "fetch_cover", quick_fetch_cover)
    asked.clear()
    await post_book(client, title="C", isbn=ISBN_C)
    resp = await client.post("/api/covers/fetch-missing")
    assert (await resp.json())["started"] is True and (await resp.json())["total"] == 1
    state = await wait_for_job(client)
    assert state["meta"]["coverJob"] == {"running": False, "total": 1, "done": 1, "found": 1}
    assert asked == [ISBN_C]  # nic już nie pyta o numery usuniętych książek


async def test_delete_library_clears_finished_cover_job(client, monkeypatch, no_pause):
    async def fake_fetch_cover(isbn, session):
        return None

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    await post_book(client, title="A", isbn=ISBN_A)
    await client.post("/api/covers/fetch-missing")
    await wait_for_job(client)
    etag = (await client.get("/api/state")).headers["ETag"]
    await client.delete("/api/library")
    resp = await client.get("/api/state", headers={"If-None-Match": etag})
    assert resp.status == 200
    assert (await resp.json())["meta"]["coverJob"] is None


@pytest.mark.parametrize(
    "isbns, expected",
    [
        ([ISBN_A], "Pobieranie okładek: 1 książka bez okładki"),
        ([ISBN_A, ISBN_B, ISBN_C], "Pobieranie okładek: 3 książki bez okładki"),
        ([ISBN_A, ISBN_B, ISBN_C, ISBN_A, ISBN_B], "Pobieranie okładek: 5 książek bez okładki"),
    ],
)
async def test_cover_job_start_log_uses_polish_plurals(client, monkeypatch, no_pause, caplog, isbns, expected):
    """lookup-3: liczba książek w dzienniku z poprawną odmianą („1 książka”, „3 książki”)."""
    async def fake_fetch_cover(isbn, session):
        return None

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    for index, isbn in enumerate(isbns):
        await post_book(client, title=f"K{index}", isbn=isbn)
    with caplog.at_level("INFO", logger="biblioteczka.server"):
        assert (await (await client.post("/api/covers/fetch-missing")).json())["total"] == len(isbns)
        await wait_for_job(client)
    messages = [record.getMessage() for record in caplog.records if record.name == "biblioteczka.server"]
    assert expected in messages, messages


async def test_cover_job_pauses_between_requests(client, monkeypatch):
    monkeypatch.setattr(server, "COVER_JOB_PAUSE", 0.05)
    moments = []

    async def fake_fetch_cover(isbn, session):
        moments.append(time.monotonic())
        return None

    monkeypatch.setattr(lookup, "fetch_cover", fake_fetch_cover)
    for index, isbn in enumerate([ISBN_A, ISBN_B, ISBN_C, "9780140328721"]):
        await post_book(client, title=f"K{index}", isbn=isbn)
    await client.post("/api/covers/fetch-missing")
    await wait_for_job(client)
    assert len(moments) == 4
    # Dwa pierwsze naraz, kolejne dopiero po pauzie.
    assert moments[1] - moments[0] < 0.04
    assert moments[2] - moments[0] >= 0.045


# --- CLI ---


async def test_cli_arguments(tmp_path):
    from biblioteczka.__main__ import parse_args

    args = parse_args(["--data", str(tmp_path), "--dev", "--sample-data", "--port", "8100", "--host", "127.0.0.1"])
    assert (args.data, args.dev, args.sample_data, args.port, args.host) == (tmp_path, True, True, 8100, "127.0.0.1")
    defaults = parse_args(["--data", str(tmp_path)])
    assert (defaults.host, defaults.port, defaults.dev, defaults.sample_data) == ("0.0.0.0", 8099, False, False)
    with pytest.raises(SystemExit):
        parse_args(["--data", str(tmp_path), "--port", "70000"])
    with pytest.raises(SystemExit):
        parse_args([])
