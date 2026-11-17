"""Testy całego wyszukiwania po ISBN na lokalnym serwerze udającym katalogi (bez internetu)."""

import asyncio
import io
import time

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestServer
from PIL import Image

from conftest import FIXTURES_DIR

from biblioteczka import lookup as lookup_pkg
from biblioteczka.lookup import BookInfo, LookupResult, bn, fetch_cover, http, lookup, make_session, onix, openlibrary
from biblioteczka.lookup.merge import SourceAnswer, isbn_numbers, merge_answers

try:
    from biblioteczka.isbn import ISBN

    def make_isbn(text):
        return ISBN.parse(text)

except ImportError:  # moduł isbn pisany równolegle – prywatny dubler na potrzeby testów
    from dataclasses import dataclass

    def _check10(first9):
        c = (11 - sum(int(d) * (10 - i) for i, d in enumerate(first9)) % 11) % 11
        return "X" if c == 10 else str(c)

    @dataclass(frozen=True)
    class _IsbnDouble:
        digits: str

        @property
        def isbn10(self):
            return self.digits[3:12] + _check10(self.digits[3:12]) if self.digits.startswith("978") else None

    def make_isbn(text):
        return _IsbnDouble(text)


def jpeg(size=(300, 450), colour=(20, 60, 140)):
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, format="JPEG")
    return buffer.getvalue()


class FakeCatalogs:
    """Serwer z odpowiedziami z katalogu `fixtures`; zachowanie da się zmieniać w teście."""

    def __init__(self):
        self.requests = []
        self.status = {}  # źródło → wymuszony kod HTTP
        self.delay = {}  # źródło → opóźnienie odpowiedzi (s)
        self.body = {}  # źródło → wymuszona treść
        self.covers = {}  # ISBN-13 → bajty okładki

    def app(self):
        app = web.Application()
        app.router.add_get("/bn/bibs.json", self.bn)
        app.router.add_get("/eisbn/api.xml", self.eisbn)
        app.router.add_get("/ol/api/books", self.openlibrary)
        app.router.add_get("/covers/{name}", self.cover)
        app.router.add_get("/storage/{isbn}.jpg", self.storage)
        return app

    async def _prepare(self, source, request):
        self.requests.append((source, request.path_qs, request.headers.get("User-Agent")))
        if source in self.delay:
            await asyncio.sleep(self.delay[source])
        if source in self.status:
            return web.Response(status=self.status[source], text="błąd")
        if source in self.body:
            return web.Response(body=self.body[source])
        return None

    async def bn(self, request):
        forced = await self._prepare("bn", request)
        if forced is not None:
            return forced
        number = request.query["isbnIssn"]
        assert request.query["limit"] == "20"
        names = [f"{number}.json"] if len(number) == 13 else [p.name for p in (FIXTURES_DIR / "bn").glob(f"*.isbn10-{number}.json")]
        for name in names:
            path = FIXTURES_DIR / "bn" / name
            if path.exists():
                return web.Response(body=path.read_bytes(), content_type="application/json")
        return web.json_response({"nextPage": "", "bibs": []})

    async def eisbn(self, request):
        forced = await self._prepare("eisbn", request)
        if forced is not None:
            return forced
        path = FIXTURES_DIR / "eisbn" / f"{request.query['isbn']}.xml"
        if not path.exists():
            path = FIXTURES_DIR / "eisbn" / "9788399999990.xml"
        return web.Response(body=path.read_bytes(), content_type="application/xml")

    async def openlibrary(self, request):
        forced = await self._prepare("openlibrary", request)
        if forced is not None:
            return forced
        assert request.query["format"] == "json" and request.query["jscmd"] == "data"
        isbn = request.query["bibkeys"].removeprefix("ISBN:")
        path = FIXTURES_DIR / "openlibrary" / f"{isbn}.json"
        return web.Response(body=path.read_bytes() if path.exists() else b"{}", content_type="application/json")

    async def cover(self, request):
        forced = await self._prepare("cover", request)
        if forced is not None:
            return forced
        assert request.query["default"] == "false"
        isbn = request.match_info["name"].removesuffix("-L.jpg")
        if isbn not in self.covers:
            return web.Response(status=404)
        # Jak covers.openlibrary.org: przekierowanie do magazynu archive.org.
        raise web.HTTPFound(f"/storage/{isbn}.jpg")

    async def storage(self, request):
        return web.Response(body=self.covers[request.match_info["isbn"]], content_type="image/jpeg")


@pytest_asyncio.fixture
async def catalogs(aiohttp_server, monkeypatch):
    fake = FakeCatalogs()
    server = await aiohttp_server(fake.app())
    base = str(server.make_url(""))
    monkeypatch.setattr(bn, "ENDPOINT", f"{base}/bn/bibs.json")
    monkeypatch.setattr(onix, "ENDPOINT", f"{base}/eisbn/api.xml")
    monkeypatch.setattr(openlibrary, "ENDPOINT", f"{base}/ol/api/books")
    monkeypatch.setattr(openlibrary, "COVER_ENDPOINT", f"{base}/covers")
    fake.server = server
    return fake


@pytest_asyncio.fixture
async def session():
    client = make_session()
    yield client
    await client.close()


def summary(info):
    return (
        info.title,
        info.author_name,
        info.series_name,
        info.is_series_certain,
        info.volume_number,
        info.publisher,
        info.year,
        info.page_count,
        info.sources,
    )


@pytest.mark.asyncio
async def test_bn_wins_and_open_library_fills_gaps(catalogs, session):
    catalogs.covers["9788375780635"] = jpeg((1200, 1800))
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "found"
    assert summary(result.info) == (
        "Ostatnie życzenie",
        "Andrzej Sapkowski",
        "Wiedźmin",
        True,
        None,
        "SuperNOWA",
        2014,
        330,
        ["Biblioteka Narodowa", "Open Library"],
    )
    cover = Image.open(io.BytesIO(result.info.cover))
    assert (cover.format, cover.size) == ("JPEG", (600, 900))


@pytest.mark.asyncio
async def test_all_three_sources_merge_in_priority_order(catalogs, session):
    result = await lookup(make_isbn("9788380083738"), session)
    assert result.status == "found"
    # Strony z BN (325), nie z Open Library (328); wydawca z BN, nie „Media Rodzina,” z e-ISBN.
    assert summary(result.info) == (
        "Harry Potter i więzień Azkabanu",
        "J. K. Rowling",
        None,
        False,
        None,
        "Media Rodzina",
        2017,
        325,
        ["Biblioteka Narodowa", "e-ISBN", "Open Library"],
    )
    assert result.info.cover is None


@pytest.mark.asyncio
async def test_priority_does_not_depend_on_completion_order(catalogs, session):
    catalogs.delay["bn"] = 0.3
    result = await lookup(make_isbn("9788380083738"), session)
    assert result.info.page_count == 325
    assert result.info.sources[0] == "Biblioteka Narodowa"


@pytest.mark.asyncio
async def test_bn_asks_isbn13_then_isbn10_and_sends_only_the_number(catalogs, session):
    catalogs.covers["9788372780140"] = (FIXTURES_DIR / "covers" / "synthetic-182x276.jpg").read_bytes()
    result = await lookup(make_isbn("9788372780140"), session)
    assert result.status == "found"
    assert result.info.year == 2001 and result.info.page_count == 458
    assert Image.open(io.BytesIO(result.info.cover)).size == (182, 276)

    bn_requests = [path for source, path, _ in catalogs.requests if source == "bn"]
    assert bn_requests == [
        "/bn/bibs.json?isbnIssn=9788372780140&limit=20",
        "/bn/bibs.json?isbnIssn=8372780145&limit=20",
    ]
    paths = {source: path for source, path, _ in catalogs.requests}
    assert paths["eisbn"] == "/eisbn/api.xml?isbn=9788372780140"
    assert paths["openlibrary"] == "/ol/api/books?bibkeys=ISBN:9788372780140&format=json&jscmd=data"
    assert paths["cover"] == "/covers/9788372780140-L.jpg?default=false"
    assert {agent for _, _, agent in catalogs.requests} == {"Biblioteczka/0.1 (Home Assistant)"}


@pytest.mark.asyncio
async def test_979_isbn_has_no_isbn10_query(catalogs, session):
    isbn = make_isbn("9791032305690")
    if isbn is None:
        pytest.skip("ISBN niepoprawny dla tej implementacji")
    result = await lookup(isbn, session)
    assert result.status == "notFound"
    assert [path for source, path, _ in catalogs.requests if source == "bn"] == [
        "/bn/bibs.json?isbnIssn=9791032305690&limit=20"
    ]


@pytest.mark.asyncio
async def test_open_library_only_book_with_redirected_cover(catalogs, session):
    catalogs.covers["9781593279509"] = (FIXTURES_DIR / "covers" / "synthetic-378x500.jpg").read_bytes()
    result = await lookup(make_isbn("9781593279509"), session)
    assert result.status == "found"
    assert result.info.title == "Eloquent JavaScript"
    assert result.info.sources == ["Open Library"]
    assert Image.open(io.BytesIO(result.info.cover)).size == (378, 500)


@pytest.mark.asyncio
async def test_unknown_isbn_is_not_found(catalogs, session):
    result = await lookup(make_isbn("9788399999990"), session)
    assert result == LookupResult("notFound", None)


@pytest.mark.asyncio
async def test_all_sources_failing_is_offline(catalogs, session):
    for source in ("bn", "eisbn", "openlibrary", "cover"):
        catalogs.status[source] = 503
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "offline"
    assert result.info is None


@pytest.mark.asyncio
async def test_one_answering_source_means_not_found_not_offline(catalogs, session):
    catalogs.status["bn"] = 500
    catalogs.status["eisbn"] = 404
    result = await lookup(make_isbn("9788399999990"), session)
    assert result.status == "notFound"


@pytest.mark.asyncio
async def test_unparseable_answers_count_as_answered(catalogs, session):
    catalogs.body["bn"] = b"<html>Przerwa techniczna</html>"
    catalogs.body["eisbn"] = b"{}"
    catalogs.body["openlibrary"] = b"<not json"
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "notFound"


@pytest.mark.asyncio
async def test_bn_falls_back_to_isbn10_after_failed_first_query(catalogs, session, monkeypatch):
    original = catalogs.bn
    calls = []

    async def flaky(request):
        calls.append(request.query["isbnIssn"])
        if len(calls) == 1:
            return web.Response(status=502)
        return await original(request)

    catalogs.bn = flaky
    # Nowa aplikacja z podmienioną obsługą BN; źródło wywołujemy bezpośrednio.
    async with TestServer(catalogs.app()) as flaky_server:
        monkeypatch.setattr(bn, "ENDPOINT", str(flaky_server.make_url("/bn/bibs.json")))
        answer = await bn.fetch(make_isbn("9788372780140"), session)
    assert calls == ["9788372780140", "8372780145"]
    assert answer.status == "found"
    assert answer.info.title == "Harry Potter i więzień Azkabanu"


@pytest.mark.asyncio
async def test_unreachable_servers_are_offline(session, monkeypatch, unused_tcp_port):
    base = f"http://127.0.0.1:{unused_tcp_port}"
    monkeypatch.setattr(bn, "ENDPOINT", f"{base}/bn")
    monkeypatch.setattr(onix, "ENDPOINT", f"{base}/eisbn")
    monkeypatch.setattr(openlibrary, "ENDPOINT", f"{base}/ol")
    monkeypatch.setattr(openlibrary, "COVER_ENDPOINT", f"{base}/covers")
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "offline"


@pytest.mark.asyncio
async def test_request_timeout_counts_as_failure(catalogs, session, monkeypatch):
    monkeypatch.setattr(http, "REQUEST_TIMEOUT", 0.2)
    for source in ("bn", "eisbn", "openlibrary", "cover"):
        catalogs.delay[source] = 1.0
    started = time.monotonic()
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "offline"
    # BN pyta dwa razy po kolei, każde zapytanie ucięte po 0,2 s.
    assert time.monotonic() - started < 0.9


@pytest.mark.asyncio
async def test_whole_lookup_is_capped(catalogs, session, monkeypatch, caplog):
    caplog.set_level("INFO", logger="biblioteczka.lookup")
    monkeypatch.setattr(http, "LOOKUP_TIMEOUT", 0.4)
    catalogs.delay["bn"] = 3.0
    catalogs.delay["cover"] = 3.0
    started = time.monotonic()
    result = await lookup(make_isbn("9788375780635"), session)
    elapsed = time.monotonic() - started
    assert elapsed < 1.5
    # BN nie zdążyło → liczy się jako nieudane; dane z Open Library, bez okładki.
    assert result.status == "found"
    assert result.info.sources == ["Open Library"]
    assert result.info.cover is None
    # Przegląd lookup-2: było „1 źródeł nie zdążyło” – teraz nazwy zamiast liczby.
    assert timeout_messages(caplog) == [
        "Wyszukiwanie ISBN 9788375780635: przekroczono czas oczekiwania, "
        "bez odpowiedzi: Biblioteka Narodowa, okładka (Open Library)"
    ]


def timeout_messages(caplog):
    return [r.getMessage() for r in caplog.records if "przekroczono czas" in r.getMessage()]


@pytest.mark.asyncio
async def test_lookup_cap_with_everything_slow_is_offline(catalogs, session, monkeypatch, caplog):
    caplog.set_level("INFO", logger="biblioteczka.lookup")
    monkeypatch.setattr(http, "LOOKUP_TIMEOUT", 0.3)
    for source in ("bn", "eisbn", "openlibrary", "cover"):
        catalogs.delay[source] = 3.0
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "offline"
    assert timeout_messages(caplog) == [
        "Wyszukiwanie ISBN 9788375780635: przekroczono czas oczekiwania, "
        "bez odpowiedzi: Biblioteka Narodowa, e-ISBN, Open Library, okładka (Open Library)"
    ]


@pytest.mark.asyncio
async def test_parser_crash_does_not_break_lookup(catalogs, session, monkeypatch):
    def boom(data, isbn):
        raise RuntimeError("błąd parsera")

    monkeypatch.setattr(bn, "parse", boom)
    result = await lookup(make_isbn("9788375780635"), session)
    assert result.status == "found"
    assert result.info.sources == ["Open Library"]


@pytest.mark.asyncio
async def test_fetch_cover(catalogs, session):
    catalogs.covers["9788375780635"] = jpeg((2000, 1000))
    data = await fetch_cover(make_isbn("9788375780635"), session)
    assert Image.open(io.BytesIO(data)).size == (900, 450)
    assert await fetch_cover(make_isbn("9788399999990"), session) is None

    catalogs.covers["9788380083738"] = b"GIF89a\x01\x00\x01\x00"  # zaślepka, nie obraz
    assert await fetch_cover(make_isbn("9788380083738"), session) is None
    catalogs.covers["9788372780140"] = jpeg((30, 30))  # za mała
    assert await fetch_cover(make_isbn("9788372780140"), session) is None


@pytest.mark.asyncio
async def test_http_get_rejects_oversized_body(catalogs, session, monkeypatch):
    monkeypatch.setattr(http, "MAX_BODY_BYTES", 100)
    catalogs.covers["9788375780635"] = jpeg()
    with pytest.raises(http.FetchError):
        await http.get(session, openlibrary.cover_url(make_isbn("9788375780635")))


# --- łączenie wyników (bez sieci) ---


def info(**fields):
    return BookInfo(isbn=make_isbn("9788375780635"), **fields)


def test_fill_moves_series_as_a_unit_and_overwrites_volume():
    merged = info(title="T", volume_number=4, sources=["Biblioteka Narodowa"])
    merged.fill(info(title="X", series_name="Cykl", is_series_certain=True, volume_number=2, sources=["e-ISBN"]))
    assert (merged.title, merged.series_name, merged.is_series_certain, merged.volume_number) == ("T", "Cykl", True, 2)
    merged.fill(info(series_name="Inna", volume_number=9, sources=["e-ISBN", "Open Library"]))
    assert (merged.series_name, merged.volume_number) == ("Cykl", 2)
    assert merged.sources == ["Biblioteka Narodowa", "e-ISBN", "Open Library"]


def test_merge_treats_empty_strings_as_missing():
    # Poprawka §9.5: pusty autor/wydawca wyższego źródła nie blokuje niższych.
    answers = [
        SourceAnswer.found(info(title="Tytuł", author_name="", publisher="  ", sources=["Biblioteka Narodowa"])),
        SourceAnswer.not_found(),
        SourceAnswer.found(info(title="Inny", author_name="Anna Nowak", publisher="Znak", year=2001, sources=["Open Library"])),
    ]
    result = merge_answers(answers, cover=b"jpeg")
    assert result.status == "found"
    assert (result.info.title, result.info.author_name, result.info.publisher, result.info.year) == (
        "Tytuł",
        "Anna Nowak",
        "Znak",
        2001,
    )
    assert result.info.cover == b"jpeg"


def test_merge_clamps_numbers_and_normalises_unicode():
    answers = [
        SourceAnswer.found(info(title="Żółw", year=2200, page_count=0, volume_number=1000, sources=["x"])),
        SourceAnswer.found(info(title="?", year=1999, page_count=12000, sources=["y"])),
    ]
    merged = merge_answers(answers).info
    assert merged.title == "Żółw"
    assert (merged.year, merged.page_count, merged.volume_number) == (1999, None, None)


def test_merge_statuses():
    assert merge_answers([SourceAnswer.failed()] * 3).status == "offline"
    assert merge_answers([SourceAnswer.failed(), SourceAnswer.not_found(), SourceAnswer.failed()]).status == "notFound"
    assert merge_answers([]).status == "notFound"
    # Okładka bez metadanych nie wystarcza do „found”.
    assert merge_answers([SourceAnswer.not_found()] * 3, cover=b"jpeg").status == "notFound"


def test_to_json_is_camel_case_without_cover():
    book = info(
        title="T",
        author_name="A",
        series_name="S",
        is_series_certain=True,
        volume_number=3,
        publisher="P",
        year=2001,
        page_count=100,
        cover=b"jpeg",
        sources=["e-ISBN"],
    )
    assert book.to_json() == {
        "isbn": "9788375780635",
        "title": "T",
        "authorName": "A",
        "seriesName": "S",
        "isSeriesCertain": True,
        "volumeNumber": 3,
        "publisher": "P",
        "year": 2001,
        "pageCount": 100,
        "sources": ["e-ISBN"],
    }
    assert LookupResult("found", book).to_json()["info"] == book.to_json()
    assert LookupResult("offline").to_json() == {"status": "offline", "info": None}


def test_isbn_numbers():
    assert isbn_numbers(make_isbn("9788375780635")) == ["9788375780635", "8375780634"]
    assert isbn_numbers(make_isbn("9791032305690") or make_isbn("9788375780635"))[0].startswith("97")


def test_build_url_sorts_keys_and_keeps_colon():
    url = http.build_url("https://openlibrary.org/api/books", {"jscmd": "data", "bibkeys": "ISBN:1", "format": "json"})
    assert url == "https://openlibrary.org/api/books?bibkeys=ISBN:1&format=json&jscmd=data"
    assert http.build_url("https://x/a", {"q": "a b&c"}) == "https://x/a?q=a%20b%26c"
    assert http.build_url("https://x/a", {}) == "https://x/a"


@pytest.mark.asyncio
async def test_make_session_defaults():
    client = make_session()
    try:
        assert client.headers["User-Agent"] == "Biblioteczka/0.1 (Home Assistant)"
        assert client.timeout.total == 12
    finally:
        await client.close()


def test_public_api():
    for name in ("BookInfo", "LookupResult", "lookup", "fetch_cover", "make_session"):
        assert hasattr(lookup_pkg, name)
