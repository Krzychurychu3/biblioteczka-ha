"""Testy wyliczanych właściwości i stanu JSON (`views.build_state`) – logic.md §3.1, §4, §5; design §9 (8, 9)."""

import json

import pytest

from biblioteczka import db, views
from biblioteczka.store import Library

COVER_1 = "1" * 40
COVER_2 = "2" * 40
COVER_3 = "3" * 40


@pytest.fixture
def conn():
    c = db.open_db(":memory:")
    yield c
    c.close()


@pytest.fixture
def lib(conn):
    return Library(conn)


def raw(conn, title, author_id=None, series_id=None, volume=None, owned=True, **extra):
    columns = {"title": title, "author_id": author_id, "series_id": series_id, "volume_number": volume,
               "is_owned": int(owned), "added_at": "2026-01-01T00:00:00Z", **extra}
    with db.transaction(conn):
        return conn.execute(
            f"INSERT INTO book({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(columns.values()),
        ).lastrowid


def make_series(conn, name, author_id=None, planned=None):
    with db.transaction(conn):
        return conn.execute(
            "INSERT INTO series(name, planned_volume_count, created_at, author_id) VALUES (?, ?, 't', ?)",
            (name, planned, author_id),
        ).lastrowid


def make_author(conn, name):
    with db.transaction(conn):
        return conn.execute("INSERT INTO author(name, created_at) VALUES (?, 't')", (name,)).lastrowid


def state(conn, **kwargs):
    return views.build_state(conn, "0.1.0", **kwargs)


def by_id(items, item_id):
    return next(item for item in items if item["id"] == item_id)


# --- Kolejność „localized standard” (§3.1) ---


def test_localized_order_matches_verified_sample():
    expected = ["abc", "Abc", "ABD", "ala", "Ala", "Ąbc", "Cma", "Ćma", "Dom", "lody", "Łódź", "Oko", "Ósemka",
                "tom 2", "tom 10", "zebra", "Zebra", "Źrebię", "Żaba"]
    shuffled = list(reversed(expected))
    assert sorted(shuffled, key=views.localized_key) == expected


def test_localized_order_details():
    assert sorted(["Tom 10", "Tom 9", "Tom 1"], key=views.localized_key) == ["Tom 1", "Tom 9", "Tom 10"]
    assert sorted(["éclair", "eclair", "ecla"], key=views.localized_key) == ["ecla", "eclair", "éclair"]
    assert views.localized_key("Ż") > views.localized_key("Ź") > views.localized_key("Z")
    assert views.localized_key("x²")  # znaki liczbowe spoza cyfr nie psują klucza


# --- Slots, postęp i opis braków (§4.2) ---


def series_state(conn, series_id):
    return by_id(state(conn)["series"], series_id)


def test_slots_progress_and_known_total(conn):
    s = make_series(conn, "Wiedźmin", planned=8)
    for n in (1, 2, 3, 5, 7):
        raw(conn, f"Tom {n}", series_id=s, volume=n)
    for n in (4, 6, 8):
        raw(conn, f"Tom {n}", series_id=s, volume=n, owned=False)
    item = series_state(conn, s)
    assert [slot["number"] for slot in item["slots"]] == list(range(1, 9))
    assert item["progress"]["owned"] == 5 and item["progress"]["total"] == 8
    assert item["progress"]["label"] == "5/8"
    assert item["progress"]["fraction"] == pytest.approx(5 / 8)
    assert item["progress"]["isComplete"] is False
    assert item["missingDescription"] == "Brakuje tomów: 4, 6, 8"
    assert item["nextVolumeNumber"] == 9  # wszystkie numery zajęte
    assert item["suggestedVolumeNumber"] == 9


def test_shared_slot_and_unnumbered_books_in_shelf_order(conn):
    s = make_series(conn, "Mix")
    a = raw(conn, "Zeta", series_id=s, volume=2)
    b = raw(conn, "alfa", series_id=s, volume=2, owned=False)
    c = raw(conn, "Bez numeru B", series_id=s)
    d = raw(conn, "bez numeru a", series_id=s, volume=0, owned=False)
    item = series_state(conn, s)
    assert item["slots"] == [
        {"number": 1, "bookIds": [], "isOwned": False},
        {"number": 2, "bookIds": [b, a], "isOwned": True},
        {"number": None, "bookIds": [d], "isOwned": False},
        {"number": None, "bookIds": [c], "isOwned": True},
    ]
    progress = item["progress"]
    assert (progress["total"], progress["owned"], progress["missing"]) == (4, 2, 2)
    assert progress["label"] == "2/?"
    assert progress["isComplete"] is False  # liczba tomów nieznana → nigdy kompletna
    assert item["nextVolumeNumber"] == 1


def test_complete_requires_known_total(conn):
    s = make_series(conn, "HP", planned=2)
    raw(conn, "1", series_id=s, volume=1)
    raw(conn, "2", series_id=s, volume=2)
    item = series_state(conn, s)
    assert item["progress"]["isComplete"] is True and item["missingDescription"] is None
    unknown = make_series(conn, "Bez liczby")
    raw(conn, "1", series_id=unknown, volume=1)
    assert series_state(conn, unknown)["progress"]["isComplete"] is False


def test_highest_number_beats_planned_count(conn):
    s = make_series(conn, "S", planned=2)
    raw(conn, "5", series_id=s, volume=5)
    item = series_state(conn, s)
    assert item["progress"]["total"] == 5
    assert item["progress"]["label"] == "1/5"


@pytest.mark.parametrize(
    "setup, expected",
    [
        # (numery posiadanych, numery brakujących, liczba brakujących bez numeru, planowane)
        (((1, 2, 3), (4,), 0, 4), "Brakuje tomu 4"),
        (((1,), (), 1, None), "Brakuje 1 tomu"),
        (((1,), (), 3, None), "Brakuje 3 tomów"),
        (((1, 2, 3), (), 0, 5), "Brakuje tomów: 4, 5"),
        # Poprawka §9.8: jeden brakujący numer + brakująca książka bez numeru → liczba, nie „tomu N”.
        (((1, 2, 3), (), 1, 4), "Brakuje 2 tomów"),
        (((1,), (), 2, 3), "Brakuje 4 tomów"),
        (((1, 2), (), 0, 2), None),
        (((), (), 0, None), None),
    ],
)
def test_missing_description(conn, setup, expected):
    owned, missing, unnumbered, planned = setup
    s = make_series(conn, "S", planned=planned)
    for n in owned:
        raw(conn, f"t{n}", series_id=s, volume=n)
    for n in missing:
        raw(conn, f"m{n}", series_id=s, volume=n, owned=False)
    for i in range(unnumbered):
        raw(conn, f"u{i}", series_id=s, owned=False)
    assert series_state(conn, s)["missingDescription"] == expected


def test_empty_series(conn):
    s = make_series(conn, "Pusta")
    item = series_state(conn, s)
    assert item["slots"] == []
    assert item["progress"]["label"] == "brak tomów"
    assert item["progress"]["fraction"] == 0
    assert item["isOnShelf"] is True and item["hasOwnedBooks"] is False
    assert item["suggestedVolumeNumber"] == 1
    sized = make_series(conn, "Pusta z liczbą", planned=3)
    item = series_state(conn, sized)
    assert [slot["number"] for slot in item["slots"]] == [1, 2, 3]
    assert item["missingDescription"] == "Brakuje tomów: 1, 2, 3"
    assert item["progress"]["label"] == "0/3"


def test_suggested_volume_for_unnumbered_series_is_zero(conn):
    s = make_series(conn, "Pucio")
    raw(conn, "Pucio mówi", series_id=s)
    raw(conn, "Pucio uczy się", series_id=s)
    item = series_state(conn, s)
    assert item["suggestedVolumeNumber"] == 0
    assert item["nextVolumeNumber"] == 1


def test_series_visibility(conn):
    catalog = make_series(conn, "Z katalogu")
    raw(conn, "1", series_id=catalog, volume=1, owned=False)
    owned = make_series(conn, "Moja")
    raw(conn, "1", series_id=owned, volume=1, owned=False)
    raw(conn, "2", series_id=owned, volume=2, owned=True)
    s = state(conn)["series"]
    assert by_id(s, catalog)["isOnShelf"] is False
    assert by_id(s, owned)["isOnShelf"] is True and by_id(s, owned)["hasOwnedBooks"] is True


def test_author_line(conn):
    a = make_author(conn, "Andrzej Sapkowski")
    b = make_author(conn, "Inny")
    with_author = make_series(conn, "Wiedźmin", author_id=a)
    raw(conn, "x", author_id=b, series_id=with_author)
    shared = make_series(conn, "Opowiem ci, mamo")
    raw(conn, "1", author_id=a, series_id=shared)
    raw(conn, "2", author_id=b, series_id=shared)
    single = make_series(conn, "Jeden")
    raw(conn, "1", author_id=b, series_id=single)
    raw(conn, "2", series_id=single)
    unknown = make_series(conn, "Nikt")
    raw(conn, "1", series_id=unknown)
    s = state(conn)["series"]
    assert by_id(s, with_author)["authorLine"] == "Andrzej Sapkowski"
    assert by_id(s, shared)["authorLine"] == "Różni autorzy"
    assert by_id(s, single)["authorLine"] == "Inny"
    assert by_id(s, unknown)["authorLine"] == "Autor nieznany"


def test_series_cover_pick_order(conn):
    s = make_series(conn, "S")
    raw(conn, "bez numeru", series_id=s, cover_id=COVER_3)
    raw(conn, "b", series_id=s, volume=2, cover_id=COVER_2)
    raw(conn, "Z tom 2", series_id=s, volume=2, cover_id=COVER_1)  # „Z” < „b” bajtowo
    raw(conn, "pierwszy bez okładki", series_id=s, volume=1)
    assert series_state(conn, s)["coverId"] == COVER_1
    empty = make_series(conn, "Bez okładek")
    raw(conn, "x", series_id=empty)
    assert series_state(conn, empty)["coverId"] is None


# --- Autorzy (§4.3) ---


def test_author_summaries_and_visibility(conn):
    a = make_author(conn, "A")
    s1 = make_series(conn, "S1", author_id=a)
    s2 = make_series(conn, "S2", author_id=a)
    for i in range(3):
        raw(conn, f"own{i}", author_id=a, series_id=s1, volume=i + 1)
    for i in range(9):
        raw(conn, f"cat{i}", author_id=a, series_id=s2, owned=False)
    catalog_only = make_author(conn, "Tylko katalog")
    raw(conn, "k", author_id=catalog_only, owned=False)
    empty = make_author(conn, "Pusty")
    only_series = make_author(conn, "Tylko seria")
    make_series(conn, "Seria bez książek", author_id=only_series)
    authors = state(conn)["authors"]

    item = by_id(authors, a)
    assert item["summary"] == "2 serie · 12 książek"
    assert item["ownedSummary"] == "1 seria · 3 książki"
    assert item["bookCount"] == 12 and item["ownedBookCount"] == 3
    assert item["isOnShelf"] is True
    assert item["seriesIds"] == [s1, s2]
    assert by_id(authors, catalog_only)["isOnShelf"] is False
    assert by_id(authors, catalog_only)["ownedSummary"] == "Brak książek na półce"
    assert by_id(authors, catalog_only)["summary"] == "1 książka"
    assert by_id(authors, empty)["isOnShelf"] is True
    assert by_id(authors, empty)["summary"] == "0 książek"
    assert by_id(authors, only_series)["isOnShelf"] is False  # ma serię, brak posiadanych książek


def test_author_owned_summary_without_series(conn):
    a = make_author(conn, "Lem")
    raw(conn, "Solaris", author_id=a)
    raw(conn, "Cyberiada", author_id=a, owned=False)
    assert by_id(state(conn)["authors"], a)["ownedSummary"] == "1 książka"


def test_author_other_series_books_and_missing_count(conn):
    """Poprawka §9.9: posiadane książki autora w seriach wspólnych lub cudzych."""
    a = make_author(conn, "A")
    b = make_author(conn, "B")
    own = make_series(conn, "Własna", author_id=a, planned=4)
    raw(conn, "1", author_id=a, series_id=own, volume=1)
    raw(conn, "2", author_id=a, series_id=own, volume=2, owned=False)
    shared = make_series(conn, "Wspólna")
    in_shared = raw(conn, "Wspólna z A", author_id=a, series_id=shared)
    foreign = make_series(conn, "Seria B", author_id=b)
    in_foreign = raw(conn, "Gościnnie", author_id=a, series_id=foreign)
    raw(conn, "Nieposiadana w cudzej", author_id=a, series_id=foreign, owned=False)
    catalog_series = make_series(conn, "Katalogowa", author_id=a)
    raw(conn, "k", author_id=a, series_id=catalog_series, owned=False)
    item = by_id(state(conn)["authors"], a)
    assert item["otherSeriesBookIds"] == [in_foreign, in_shared]  # wg tytułu: „Gościnnie” < „Wspólna z A”
    assert item["missingCount"] == 3  # tylko serie na półce: „Własna” 1/4 → brakuje 3
    assert item["ownedBookCount"] == 3


# --- Książki (§4.1) ---


def test_book_fields(conn):
    a = make_author(conn, "Andrzej Sapkowski")
    s = make_series(conn, "Wiedźmin", author_id=a)
    in_series = raw(conn, "Krew elfów", author_id=a, series_id=s, volume=3, isbn="9788375780635")
    unnumbered = raw(conn, "Opowiadania", series_id=s)
    alone = raw(conn, "Solaris")
    orphan_volume = raw(conn, "Bez serii z numerem", volume=4)
    books = state(conn)["books"]

    b = by_id(books, in_series)
    assert b["seriesLine"] == "Wiedźmin · tom 3"
    assert b["suggestionSubtitle"] == "Andrzej Sapkowski · Wiedźmin · tom 3"
    assert b["coverSeed"] == "Wiedźmin"
    assert b["coverLabel"] == "3"
    assert b["isOwned"] is True and b["isbn"] == "9788375780635"
    assert set(b) >= {"id", "title", "authorId", "seriesId", "volumeNumber", "isOwned", "notes", "addedAt", "isbn",
                      "publisher", "publicationYear", "pageCount", "coverId", "coverSeed", "coverLabel",
                      "seriesLine", "suggestionSubtitle"}
    b = by_id(books, unnumbered)
    assert (b["seriesLine"], b["suggestionSubtitle"], b["coverLabel"]) == ("Wiedźmin", "Wiedźmin", None)
    b = by_id(books, alone)
    assert (b["seriesLine"], b["suggestionSubtitle"], b["coverSeed"], b["coverLabel"]) == (None, "", "Solaris", None)
    b = by_id(books, orphan_volume)
    assert b["coverLabel"] is None and b["volumeNumber"] == 4


# --- Całość ---


def test_build_state_envelope(conn):
    lib = Library(conn)
    lib.save_book({"title": "A"})
    result = state(conn, catalog_available=True, dev_mode=True, barcode_server_decode=False,
                   cover_job={"running": True, "total": 3, "done": 1, "found": 0})
    assert result["revision"] == db.revision(conn) == 1
    assert result["appVersion"] == "0.1.0"
    assert result["meta"] == {"catalogAvailable": True, "devMode": True, "barcodeServerDecode": False,
                              "coverJob": {"running": True, "total": 3, "done": 1, "found": 0}}
    json.dumps(result)  # w całości serializowalny


def test_build_state_empty_db(conn):
    result = state(conn)
    assert result["authors"] == result["series"] == result["books"] == []
    assert result["meta"]["coverJob"] is None
