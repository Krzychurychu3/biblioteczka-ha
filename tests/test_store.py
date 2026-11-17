"""Testy operacji na danych (`store.Library`): find-or-create, zapis z edytorów, usuwanie, sprzątanie,
`resolve_lookup` – reguły z logic.md §5–§7 i poprawki z design.md §9 (1, 2)."""

import pytest

from biblioteczka import db
from biblioteczka.store import ConflictError, Library, LibraryError, NotFoundError

COVER_A = "a" * 40
COVER_B = "b" * 40


class Clock:
    """Kolejne, rosnące znaczniki czasu – żeby dało się sprawdzić, kiedy data dodania się zmienia."""

    def __init__(self):
        self.tick = 0

    def __call__(self):
        self.tick += 1
        return f"2026-03-01T10:{self.tick // 60:02d}:{self.tick % 60:02d}Z"


@pytest.fixture
def conn():
    c = db.open_db(":memory:")
    yield c
    c.close()


@pytest.fixture
def lib(conn):
    return Library(conn, now=Clock())


def book(conn, book_id):
    return conn.execute("SELECT * FROM book WHERE id = ?", (book_id,)).fetchone()


def series(conn, series_id):
    return conn.execute("SELECT * FROM series WHERE id = ?", (series_id,)).fetchone()


def author(conn, author_id):
    return conn.execute("SELECT * FROM author WHERE id = ?", (author_id,)).fetchone()


def count(conn, table):
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def add_raw_book(conn, title, author_id=None, series_id=None, volume=None, owned=False, **extra):
    """Wstawia książkę z pominięciem logiki (jak katalog: „nie mam”, 2001-01-01)."""
    columns = {"title": title, "author_id": author_id, "series_id": series_id, "volume_number": volume,
               "is_owned": int(owned), "added_at": db.CATALOG_DATE, **extra}
    names = ", ".join(columns)
    marks = ", ".join("?" for _ in columns)
    with db.transaction(conn):
        return conn.execute(f"INSERT INTO book({names}) VALUES ({marks})", tuple(columns.values())).lastrowid


# --- Autorzy (§6.1) ---


def test_find_or_create_author_reuses_case_insensitive_match(lib, conn):
    first = lib.find_or_create_author("  Andrzej   Sapkowski ")
    assert author(conn, first)["name"] == "Andrzej Sapkowski"
    assert lib.find_or_create_author("andrzej sapkowski") == first
    assert lib.find_or_create_author("ANDRZEJ\tSAPKOWSKI") == first
    assert lib.find_or_create_author("   ") is None
    assert lib.find_or_create_author("") is None
    assert count(conn, "author") == 1
    # Znaki diakrytyczne się liczą: to inny autor.
    assert lib.find_or_create_author("Andrzej Sapkowsky") != first


def test_find_author_returns_first_by_id(lib, conn):
    with db.transaction(conn):
        conn.execute("INSERT INTO author(id, name, created_at) VALUES (5, 'Lem', 't'), (3, 'LEM', 't')")
    assert lib.find_author("lem")["id"] == 3
    assert lib.find_author("") is None
    assert lib.find_author("Prus") is None


def test_nfc_normalisation(lib, conn):
    decomposed = "Ostatnie życzenie"
    book_id = lib.save_book({"title": decomposed, "authorName": "Andrzej Sapkowski"})
    assert book(conn, book_id)["title"] == "Ostatnie życzenie"
    assert lib.find_author("Andrzej Sapkowski") is not None


# --- Serie (§6.2) ---


def test_find_or_create_series_never_returns_other_authors_series(lib, conn):
    a = lib.find_or_create_author("A")
    b = lib.find_or_create_author("B")
    sa = lib.find_or_create_series("Saga", a)
    assert lib.find_or_create_series("saga", a) == sa
    sb = lib.find_or_create_series("Saga", b)
    assert sb != sa
    assert series(conn, sb)["author_id"] == b
    # Bez autora – pierwsza seria o tej nazwie, niezależnie od autora.
    assert lib.find_or_create_series("SAGA", None) == sa
    assert lib.find_or_create_series(" ", a) is None


def test_find_or_create_series_prefers_own_then_authorless(lib, conn):
    a = lib.find_or_create_author("A")
    b = lib.find_or_create_author("B")
    shared = lib.find_or_create_series("Wspólna", None)
    other = lib.find_or_create_series("Wspólna", b)
    assert other == shared  # bez książek innych autorów seria bez autora zostaje „przejęta”
    assert series(conn, shared)["author_id"] == b
    # Teraz A nie dostanie serii B – powstaje nowa.
    assert lib.find_or_create_series("Wspólna", a) not in (shared, None)


def test_authorless_series_claimed_only_without_other_authors_books(lib, conn):
    a = lib.find_or_create_author("A")
    b = lib.find_or_create_author("B")
    s = lib.find_or_create_shared_series("Opowiem ci, mamo")
    add_raw_book(conn, "Tom A", author_id=a, series_id=s)
    add_raw_book(conn, "Tom B", author_id=b, series_id=s)
    assert lib.find_or_create_series("Opowiem ci, mamo", a) == s
    assert series(conn, s)["author_id"] is None  # są tu książki innego autora

    s2 = lib.find_or_create_shared_series("Druga")
    add_raw_book(conn, "Bez autora", series_id=s2)
    add_raw_book(conn, "Tom A2", author_id=a, series_id=s2)
    assert lib.find_or_create_series("druga", a) == s2
    assert series(conn, s2)["author_id"] == a


def test_find_or_create_shared_series_returns_first_with_name(lib, conn):
    a = lib.find_or_create_author("A")
    sa = lib.find_or_create_series("Seria", a)
    assert lib.find_or_create_shared_series("seria") == sa
    assert series(conn, sa)["author_id"] == a
    new = lib.find_or_create_shared_series("Inna")
    assert series(conn, new)["author_id"] is None
    assert lib.find_or_create_shared_series("") is None


# --- Zapis książki (§7.1.5, §7.1.6) ---


def test_save_new_book_basic_fields(lib, conn):
    book_id = lib.save_book(
        {
            "title": "  Krew   elfów ",
            "authorName": "Andrzej Sapkowski",
            "seriesName": "Wiedźmin",
            "volumeNumber": 3,
            "notes": "\n  pożyczona Ani  \n",
            "isbn": "83-7054-061-9",
            "publisher": "  superNOWA ",
            "publicationYear": "1994",
            "pageCount": 340,
        }
    )
    b = book(conn, book_id)
    assert b["title"] == "Krew elfów"
    assert b["volume_number"] == 3
    assert b["is_owned"] == 1
    assert b["notes"] == "pożyczona Ani"
    assert b["isbn"] == "9788370540616"  # ISBN-10 zapisany jako 13 cyfr
    assert b["publisher"] == "superNOWA"
    assert b["publication_year"] == 1994
    assert b["page_count"] == 340
    assert b["cover_id"] is None
    assert b["added_at"].startswith("2026-03-01T")
    assert series(conn, b["series_id"])["author_id"] == b["author_id"]


def test_save_book_requires_title(lib):
    with pytest.raises(LibraryError) as info:
        lib.save_book({"title": "   "})
    assert info.value.status == 400
    assert info.value.code == "title_required"
    with pytest.raises(LibraryError):
        lib.save_book("nie słownik")


def test_save_book_invalid_isbn_stored_as_cleaned_text(lib, conn):
    book_id = lib.save_book({"title": "X", "isbn": "  978 83 1234 "})
    assert book(conn, book_id)["isbn"] == "978 83 1234"
    other = lib.save_book({"title": "Y", "isbn": "   "})
    assert book(conn, other)["isbn"] is None


def test_volume_only_with_series_and_in_range(lib, conn):
    assert book(conn, lib.save_book({"title": "A", "volumeNumber": 4}))["volume_number"] is None
    assert book(conn, lib.save_book({"title": "B", "seriesName": "S", "volumeNumber": 0}))["volume_number"] is None
    assert book(conn, lib.save_book({"title": "C", "seriesName": "S", "volumeNumber": 1000}))["volume_number"] is None
    assert book(conn, lib.save_book({"title": "D", "seriesName": "S", "volumeNumber": 999}))["volume_number"] == 999
    b = book(conn, lib.save_book({"title": "E", "publicationYear": 999, "pageCount": 10000}))
    assert (b["publication_year"], b["page_count"]) == (None, None)
    b = book(conn, lib.save_book({"title": "F", "publicationYear": 2100, "pageCount": 9999}))
    assert (b["publication_year"], b["page_count"]) == (2100, 9999)


def test_invalid_field_types_rejected(lib):
    for draft in (
        {"title": "A", "volumeNumber": "trzy", "seriesName": "S"},
        {"title": "A", "volumeNumber": True, "seriesName": "S"},
        {"title": "A", "isOwned": "tak"},
        {"title": "A", "coverId": "../../etc/passwd"},
        {"title": 5},
    ):
        with pytest.raises(LibraryError):
            lib.save_book(draft)


def test_author_inherited_from_series(lib, conn):
    a = lib.find_or_create_author("Rafał Kosik")
    lib.find_or_create_series("Felix, Net i Nika", a)
    book_id = lib.save_book({"title": "Tom 3", "seriesName": "felix, net i nika", "volumeNumber": 3})
    assert book(conn, book_id)["author_id"] == a


def test_edit_overwrites_edition_and_cover_rules(lib, conn):
    book_id = lib.save_book(
        {"title": "A", "isbn": "9788375780635", "publisher": "P", "publicationYear": 2000,
         "pageCount": 100, "coverId": COVER_A, "notes": "n"}
    )
    # Klucz coverId nieobecny → okładka zostaje; puste pola wydania nadpisują (pełny zapis jak w iOS).
    lib.save_book({"title": "A"}, book_id=book_id)
    b = book(conn, book_id)
    assert b["cover_id"] == COVER_A
    assert (b["isbn"], b["publisher"], b["publication_year"], b["page_count"], b["notes"]) == (None,) * 4 + ("",)
    lib.save_book({"title": "A", "coverId": COVER_B}, book_id=book_id)
    assert book(conn, book_id)["cover_id"] == COVER_B
    lib.save_book({"title": "A", "coverId": None}, book_id=book_id)
    assert book(conn, book_id)["cover_id"] is None


def test_edit_missing_book_raises_not_found(lib):
    with pytest.raises(NotFoundError) as info:
        lib.save_book({"title": "A"}, book_id=999)
    assert info.value.status == 404


def test_added_at_resets_only_when_becoming_owned(lib, conn):
    book_id = lib.save_book({"title": "A", "isOwned": False})
    first = book(conn, book_id)["added_at"]
    lib.save_book({"title": "A", "isOwned": False, "notes": "x"}, book_id=book_id)
    assert book(conn, book_id)["added_at"] == first
    lib.save_book({"title": "A", "isOwned": True}, book_id=book_id)
    owned_at = book(conn, book_id)["added_at"]
    assert owned_at > first
    lib.save_book({"title": "A", "isOwned": True, "notes": "y"}, book_id=book_id)
    assert book(conn, book_id)["added_at"] == owned_at


# --- Przejmowanie wpisu „nie mam” (§9.1) ---


def test_adopt_saves_into_existing_record_and_keeps_its_data(lib, conn):
    a = lib.find_or_create_author("Marta Galewska-Kustra")
    s = lib.find_or_create_series("Pucio", a)
    catalog_id = add_raw_book(
        conn, "Pucio mówi pierwsze słowa", author_id=a, series_id=s,
        notes="od babci", isbn="9788310128542", publisher="Nasza Księgarnia", cover_id=COVER_A, page_count=40,
    )
    # Bez klucza `coverId` – tak klient wysyła formularz, w którym okładki wpisu nie zmieniono.
    saved = lib.save_book(
        {"title": "Pucio mówi pierwsze słowa", "authorName": "Marta Galewska-Kustra", "seriesName": "Pucio",
         "isOwned": True, "publicationYear": 2016, "pageCount": 48, "notes": ""},
        adopt_id=catalog_id,
    )
    assert saved == catalog_id
    assert count(conn, "book") == 1
    b = book(conn, catalog_id)
    assert b["is_owned"] == 1
    assert b["added_at"] != db.CATALOG_DATE  # właśnie trafiła na półkę
    assert b["notes"] == "od babci"
    assert b["isbn"] == "9788310128542"
    assert b["publisher"] == "Nasza Księgarnia"
    assert b["cover_id"] == COVER_A
    assert b["publication_year"] == 2016  # wpisane w formularzu
    assert b["page_count"] == 48  # wartość z formularza wygrywa


def test_adopt_user_values_win(lib, conn):
    catalog_id = add_raw_book(conn, "Tytuł", notes="stare", publisher="Stary", cover_id=COVER_A)
    lib.save_book({"title": "Tytuł", "notes": "nowe", "publisher": "Nowy", "coverId": COVER_B}, adopt_id=catalog_id)
    b = book(conn, catalog_id)
    assert (b["notes"], b["publisher"], b["cover_id"]) == ("nowe", "Nowy", COVER_B)


def test_adopt_with_removed_cover_clears_it(lib, conn):
    """Przegląd dom-2: „Usuń okładkę” w formularzu przejętego wpisu (`coverId: null`) usuwa okładkę."""
    catalog_id = add_raw_book(conn, "Pucio", notes="stara notatka", isbn="9788375780635", cover_id=COVER_A)
    draft = {"title": "Pucio", "isOwned": True, "notes": "", "isbn": None, "coverId": None}
    assert lib.save_book(draft, adopt_id=catalog_id) == catalog_id
    b = book(conn, catalog_id)
    assert b["cover_id"] is None
    # Pozostałe puste pola nadal zachowują dane wpisu (§9.1).
    assert (b["notes"], b["isbn"], b["is_owned"]) == ("stara notatka", "9788375780635", 1)


def test_adopt_of_vanished_record_creates_new_book(lib, conn):
    book_id = lib.save_book({"title": "Nowa"}, adopt_id=12345)
    assert book(conn, book_id)["title"] == "Nowa"


def test_edit_wins_over_adopt(lib, conn):
    edited = lib.save_book({"title": "Edytowana"})
    other = add_raw_book(conn, "Inna", notes="zostaje")
    assert lib.save_book({"title": "Edytowana 2"}, book_id=edited, adopt_id=other) == edited
    assert book(conn, other)["notes"] == "zostaje"


# --- Sprzątanie pustych serii i autorów (§9.2) ---


def test_moving_book_removes_emptied_series_and_author(lib, conn):
    book_id = lib.save_book({"title": "Krew elfów", "authorName": "Sapkowsky", "seriesName": "Wiedźmin", "volumeNumber": 3})
    old = book(conn, book_id)
    lib.save_book({"title": "Krew elfów", "authorName": "Andrzej Sapkowski"}, book_id=book_id)
    assert series(conn, old["series_id"]) is None
    assert author(conn, old["author_id"]) is None
    assert count(conn, "series") == 0
    assert count(conn, "author") == 1


def test_cleanup_keeps_entries_that_still_have_content(lib, conn):
    first = lib.save_book({"title": "Tom 1", "authorName": "A", "seriesName": "S", "volumeNumber": 1})
    second = lib.save_book({"title": "Tom 2", "authorName": "A", "seriesName": "S", "volumeNumber": 2})
    s_id = book(conn, first)["series_id"]
    lib.save_book({"title": "Tom 2", "authorName": "A"}, book_id=second)  # wyjęta z serii
    assert series(conn, s_id) is not None
    lib.delete_book(first)
    assert series(conn, s_id) is None  # ostatni tom usunięty → seria znika
    assert lib.find_author("A") is not None  # autor ma jeszcze „Tom 2”


def test_author_with_only_a_series_is_kept(lib, conn):
    a = lib.find_or_create_author("A")
    lib.save_series({"name": "Pusta seria", "authorName": "A"})
    book_id = lib.save_book({"title": "X", "authorName": "A"})
    lib.save_book({"title": "X", "authorName": "B"}, book_id=book_id)
    assert author(conn, a) is not None  # ma jeszcze (celowo pustą) serię


def test_series_and_author_empty_before_operation_stay(lib, conn):
    empty_series = lib.save_series({"name": "Na później"})
    empty_author = lib.save_author("Ktoś Nowy")["id"]
    book_id = lib.save_book({"title": "X", "authorName": "Z", "seriesName": "S"})
    lib.save_book({"title": "X"}, book_id=book_id)
    lib.delete_book(book_id)
    assert series(conn, empty_series) is not None
    assert author(conn, empty_author) is not None


def test_delete_last_book_removes_series_and_its_author(lib, conn):
    book_id = lib.save_book({"title": "Jedyny tom", "authorName": "A", "seriesName": "S", "volumeNumber": 1})
    b = book(conn, book_id)
    lib.delete_book(book_id)
    assert count(conn, "book") == 0
    assert series(conn, b["series_id"]) is None
    assert author(conn, b["author_id"]) is None
    with pytest.raises(NotFoundError):
        lib.delete_book(book_id)


def test_cleanup_includes_author_of_previous_series(lib, conn):
    a = lib.find_or_create_author("A")
    s = lib.find_or_create_series("S", a)
    book_id = add_raw_book(conn, "Bez autora w serii A", series_id=s, owned=True)
    lib.save_book({"title": "Bez autora w serii A"}, book_id=book_id)
    assert series(conn, s) is None
    assert author(conn, a) is None


# --- Zmiana autora książki w serii (logic A2) ---


def test_author_change_splits_multi_volume_series(lib, conn):
    v1 = lib.save_book({"title": "Tom 1", "authorName": "A", "seriesName": "Saga", "volumeNumber": 1})
    v2 = lib.save_book({"title": "Tom 2", "authorName": "A", "seriesName": "Saga", "volumeNumber": 2})
    lib.save_book({"title": "Tom 2", "authorName": "B", "seriesName": "Saga", "volumeNumber": 2}, book_id=v2)
    assert book(conn, v1)["series_id"] != book(conn, v2)["series_id"]
    assert count(conn, "series") == 2


def test_author_change_of_only_volume_carries_series_over(lib, conn):
    v1 = lib.save_book({"title": "Tom 1", "authorName": "Sapkowsky", "seriesName": "Wiedźmin", "volumeNumber": 1})
    s = book(conn, v1)["series_id"]
    with db.transaction(conn):
        conn.execute("UPDATE series SET planned_volume_count = 8, notes = 'saga' WHERE id = ?", (s,))
    old_author = book(conn, v1)["author_id"]
    lib.save_book({"title": "Tom 1", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin", "volumeNumber": 1},
                  book_id=v1)
    b = book(conn, v1)
    assert b["series_id"] == s
    assert series(conn, s)["planned_volume_count"] == 8
    assert series(conn, s)["author_id"] == b["author_id"] != old_author
    assert author(conn, old_author) is None


def test_author_change_joins_existing_series_of_new_author(lib, conn):
    target = lib.save_book({"title": "Tom 1", "authorName": "B", "seriesName": "Saga", "volumeNumber": 1})
    moved = lib.save_book({"title": "Tom 2", "authorName": "A", "seriesName": "Saga", "volumeNumber": 2})
    old_series = book(conn, moved)["series_id"]
    lib.save_book({"title": "Tom 2", "authorName": "B", "seriesName": "Saga", "volumeNumber": 2}, book_id=moved)
    assert book(conn, moved)["series_id"] == book(conn, target)["series_id"]
    assert series(conn, old_series) is None


# --- Mam / Nie mam, uzupełnianie istniejącej (§5.1, §7.1.4) ---


def test_set_owned_resets_added_at(lib, conn):
    book_id = add_raw_book(conn, "Z katalogu")
    lib.set_owned(book_id, True)
    owned_at = book(conn, book_id)["added_at"]
    assert owned_at != db.CATALOG_DATE
    assert book(conn, book_id)["is_owned"] == 1
    lib.set_owned(book_id, False)
    b = book(conn, book_id)
    assert b["is_owned"] == 0 and b["added_at"] == owned_at
    lib.set_owned(book_id, True)
    assert book(conn, book_id)["added_at"] > owned_at
    with pytest.raises(NotFoundError):
        lib.set_owned(999, True)


def test_complete_book_fills_only_empty_fields(lib, conn):
    book_id = add_raw_book(conn, "A", owned=True, publisher="Stary", added_at="2020-01-01T00:00:00Z")
    lib.complete_book(
        book_id,
        {"isbn": "9788375780635", "publisher": "Nowy", "publicationYear": 2019, "pageCount": 0, "coverId": COVER_A,
         "title": "ignorowany"},
        mark_owned=False,
    )
    b = book(conn, book_id)
    assert (b["isbn"], b["publisher"], b["publication_year"], b["page_count"], b["cover_id"]) == (
        "9788375780635", "Stary", 2019, None, COVER_A)
    assert b["title"] == "A"
    assert b["added_at"] == "2020-01-01T00:00:00Z"
    lib.complete_book(book_id, {"coverId": COVER_B, "isbn": "9788310128542"}, mark_owned=True)
    b = book(conn, book_id)
    assert (b["cover_id"], b["isbn"]) == (COVER_A, "9788375780635")
    assert b["added_at"] == "2020-01-01T00:00:00Z"  # już była posiadana


def test_complete_book_mark_owned(lib, conn):
    book_id = add_raw_book(conn, "Brakująca")
    lib.complete_book(book_id, {"publisher": "W"}, mark_owned=True)
    b = book(conn, book_id)
    assert b["is_owned"] == 1
    assert b["added_at"] != db.CATALOG_DATE
    assert b["publisher"] == "W"


# --- Serie (§7.2) ---


def test_save_series_create_and_validation(lib, conn):
    s = lib.save_series({"name": "  Diuna ", "authorName": "Frank Herbert", "plannedVolumeCount": 6, "notes": " x \n"})
    row = series(conn, s)
    assert (row["name"], row["planned_volume_count"], row["notes"]) == ("Diuna", 6, "x")
    assert author(conn, row["author_id"])["name"] == "Frank Herbert"
    s2 = lib.save_series({"name": "Bez liczby", "plannedVolumeCount": 0})
    assert series(conn, s2)["planned_volume_count"] is None
    assert series(conn, s2)["author_id"] is None
    with pytest.raises(LibraryError) as info:
        lib.save_series({"name": " "})
    assert info.value.code == "name_required"


def test_save_series_duplicate_messages(lib, conn):
    lib.save_series({"name": "Diuna", "authorName": "Frank Herbert"})  # pusta = na półce
    with pytest.raises(ConflictError) as info:
        lib.save_series({"name": "diuna"})
    assert info.value.status == 409
    assert info.value.message_pl == "Taka seria jest już w biblioteczce."
    with pytest.raises(ConflictError):
        lib.save_series({"name": "Diuna", "authorName": "frank herbert"})
    # Inny autor – nie jest duplikatem.
    assert lib.save_series({"name": "Diuna", "authorName": "Ktoś Inny"})

    catalog_series = lib.find_or_create_series("Pucio", lib.find_or_create_author("M"))
    add_raw_book(conn, "Pucio", series_id=catalog_series)
    with pytest.raises(ConflictError) as info:
        lib.save_series({"name": "Pucio"})
    assert info.value.message_pl == (
        "Ta seria jest już w katalogu podpowiedzi. Dodaj książkę z tej serii, a seria pojawi się na liście."
    )
    # Seria bez autora jest duplikatem dla każdego autora.
    shared = lib.find_or_create_shared_series("Wspólna")
    add_raw_book(conn, "W1", series_id=shared, owned=True)
    with pytest.raises(ConflictError):
        lib.save_series({"name": "Wspólna", "authorName": "Ktokolwiek"})


def test_save_series_edit_does_not_conflict_with_itself(lib, conn):
    s = lib.save_series({"name": "Diuna", "authorName": "Frank Herbert"})
    assert lib.save_series({"name": "DIUNA", "authorName": "Frank Herbert", "plannedVolumeCount": 6}, series_id=s) == s
    assert series(conn, s)["name"] == "DIUNA"
    with pytest.raises(NotFoundError):
        lib.save_series({"name": "X"}, series_id=999)


def test_save_series_author_change_moves_books(lib, conn):
    a = lib.find_or_create_author("A")
    c = lib.find_or_create_author("C")
    s = lib.find_or_create_series("S", a)
    by_a = add_raw_book(conn, "1", author_id=a, series_id=s, owned=True)
    nobody = add_raw_book(conn, "2", series_id=s, owned=True)
    by_c = add_raw_book(conn, "3", author_id=c, series_id=s, owned=True)
    lib.save_series({"name": "S", "authorName": "B"}, series_id=s)
    b = lib.find_author("B")["id"]
    assert book(conn, by_a)["author_id"] == b
    assert book(conn, nobody)["author_id"] == b
    assert book(conn, by_c)["author_id"] == c
    assert series(conn, s)["author_id"] == b
    assert author(conn, a) is None  # poprzedni autor został bez książek i serii


def test_save_series_on_shared_series_only_moves_authorless_books(lib, conn):
    a = lib.find_or_create_author("A")
    s = lib.find_or_create_shared_series("Wspólna")
    by_a = add_raw_book(conn, "1", author_id=a, series_id=s, owned=True)
    nobody = add_raw_book(conn, "2", series_id=s, owned=True)
    lib.save_series({"name": "Wspólna", "authorName": "B"}, series_id=s)
    assert book(conn, by_a)["author_id"] == a
    assert author(conn, book(conn, nobody)["author_id"])["name"] == "B"


def test_save_series_author_removed_follows_to_none(lib, conn):
    a = lib.find_or_create_author("A")
    s = lib.find_or_create_series("S", a)
    b1 = add_raw_book(conn, "1", author_id=a, series_id=s, owned=True)
    lib.save_series({"name": "S", "authorName": ""}, series_id=s)
    assert book(conn, b1)["author_id"] is None
    assert series(conn, s)["author_id"] is None


def test_delete_series_with_and_without_books(lib, conn):
    keep = lib.save_book({"title": "T1", "authorName": "A", "seriesName": "S", "volumeNumber": 2})
    s = book(conn, keep)["series_id"]
    lib.delete_series(s, with_books=False)
    b = book(conn, keep)
    assert b["series_id"] is None and b["volume_number"] == 2  # numer tomu zostaje
    assert lib.find_author("A") is not None

    gone = lib.save_book({"title": "T2", "authorName": "B", "seriesName": "S2", "volumeNumber": 1})
    s2 = book(conn, gone)["series_id"]
    lib.delete_series(s2, with_books=True)
    assert book(conn, gone) is None
    assert lib.find_author("B") is None  # autor usuniętych książek bez innych wpisów znika
    with pytest.raises(NotFoundError):
        lib.delete_series(s2, with_books=False)


# --- Autorzy (§7.3, §6.3) ---


def test_save_author_create_conflicts(lib, conn):
    created = lib.save_author("  Stanisław Lem ")
    assert created == {"id": created["id"], "mergedInto": None}
    assert author(conn, created["id"])["name"] == "Stanisław Lem"
    with pytest.raises(ConflictError) as info:
        lib.save_author("stanisław lem")
    assert info.value.message_pl == "Ten autor jest już w biblioteczce."
    catalog_author = lib.find_or_create_author("Rafał Kosik")
    add_raw_book(conn, "Felix", author_id=catalog_author)
    with pytest.raises(ConflictError) as info:
        lib.save_author("Rafał Kosik")
    assert info.value.message_pl == (
        "Ten autor jest już w katalogu podpowiedzi – pojawi się na liście, gdy dodasz jego książkę."
    )
    with pytest.raises(LibraryError):
        lib.save_author("  ")


def test_save_author_edit_renames_or_merges(lib, conn):
    a = lib.save_author("J.K. Rowling")["id"]
    assert lib.save_author("J. K. Rowling", author_id=a) == {"id": a, "mergedInto": None}
    assert author(conn, a)["name"] == "J. K. Rowling"
    assert lib.save_author("j. k. rowling", author_id=a) == {"id": a, "mergedInto": None}  # sam ze sobą

    target = lib.find_or_create_author("Andrzej Sapkowski")
    s = lib.find_or_create_series("Wiedźmin", a)
    b = add_raw_book(conn, "Krew elfów", author_id=a, series_id=s)
    result = lib.save_author("ANDRZEJ SAPKOWSKI", author_id=a)
    assert result == {"id": target, "mergedInto": target}
    assert author(conn, a) is None
    assert author(conn, target)["name"] == "Andrzej Sapkowski"  # nazwa celu zostaje
    assert book(conn, b)["author_id"] == target
    assert series(conn, s)["author_id"] == target


def test_merge_authors_keeps_duplicate_series(lib, conn):
    a = lib.find_or_create_author("A")
    b = lib.find_or_create_author("B")
    sa = lib.find_or_create_series("Saga", a)
    sb = lib.find_or_create_series("Saga", b)
    lib.merge_authors(a, b)
    assert author(conn, a) is None
    assert series(conn, sa)["author_id"] == b and series(conn, sb)["author_id"] == b
    with pytest.raises(LibraryError):
        lib.merge_authors(b, b)
    with pytest.raises(NotFoundError):
        lib.merge_authors(a, b)


def test_delete_author_without_books_nullifies(lib, conn):
    book_id = lib.save_book({"title": "Solaris", "authorName": "Lem", "seriesName": "S"})
    a = book(conn, book_id)["author_id"]
    s = book(conn, book_id)["series_id"]
    lib.delete_author(a, with_books=False)
    assert book(conn, book_id)["author_id"] is None
    assert series(conn, s)["author_id"] is None


def test_delete_author_with_books(lib, conn):
    a = lib.find_or_create_author("A")
    other = lib.find_or_create_author("O")
    own_series = lib.find_or_create_series("Seria A", a)
    shared = lib.find_or_create_shared_series("Wspólna")
    other_series = lib.find_or_create_series("Seria O", other)
    in_own = add_raw_book(conn, "A1", author_id=a, series_id=own_series, owned=True)
    foreign_in_own = add_raw_book(conn, "O1", author_id=other, series_id=own_series, owned=True)
    in_shared = add_raw_book(conn, "A2", author_id=a, series_id=shared, owned=True)
    in_other = add_raw_book(conn, "A3", author_id=a, series_id=other_series, owned=True)
    other_keeps = add_raw_book(conn, "O2", author_id=other, series_id=other_series, owned=True)

    lib.delete_author(a, with_books=True)
    assert author(conn, a) is None
    for gone in (in_own, in_shared, in_other):
        assert book(conn, gone) is None
    assert series(conn, own_series) is None
    assert book(conn, foreign_in_own)["series_id"] is None  # cudza książka zostaje, bez serii
    assert series(conn, shared) is None  # wspólna seria opustoszała
    assert series(conn, other_series) is not None
    assert book(conn, other_keeps) is not None
    with pytest.raises(NotFoundError):
        lib.delete_author(a, with_books=False)


def test_delete_all_keeps_catalog_version(lib, conn):
    db.set_meta(conn, db.META_CATALOG_VERSION, 1)
    lib.save_book({"title": "A", "authorName": "B", "seriesName": "C"})
    lib.delete_all()
    assert count(conn, "book") == count(conn, "series") == count(conn, "author") == 0
    assert db.get_meta(conn, db.META_CATALOG_VERSION) == "1"


def test_referenced_cover_ids(lib, conn):
    assert lib.referenced_cover_ids() == set()
    lib.save_book({"title": "A", "coverId": COVER_A})
    lib.save_book({"title": "B", "coverId": COVER_A})
    lib.save_book({"title": "C", "coverId": COVER_B})
    lib.save_book({"title": "D"})
    assert lib.referenced_cover_ids() == {COVER_A, COVER_B}


def test_every_mutation_bumps_revision_once(lib, conn):
    start = db.revision(conn)
    book_id = lib.save_book({"title": "A", "authorName": "B", "seriesName": "C"})
    assert db.revision(conn) == start + 1
    lib.set_owned(book_id, False)
    lib.complete_book(book_id, {"publisher": "P"}, mark_owned=True)
    lib.delete_book(book_id)
    assert db.revision(conn) == start + 4
    with pytest.raises(LibraryError):
        lib.save_book({"title": ""})
    with pytest.raises(NotFoundError):
        lib.delete_book(book_id)
    assert db.revision(conn) == start + 4


def test_failed_operation_rolls_back_everything(lib, conn):
    lib.save_series({"name": "Diuna"})
    with pytest.raises(ConflictError):
        lib.save_series({"name": "Diuna", "authorName": "Nowy Autor"})
    # Autor nie powstał, bo zapis został wycofany w całości (duplikat: seria bez autora).
    assert lib.find_author("Nowy Autor") is None


# --- resolve_lookup (BookEditorView.apply, §7.1.8) ---


def info(**values):
    base = {"isbn": None, "title": None, "authorName": None, "seriesName": None, "isSeriesCertain": False,
            "volumeNumber": None, "publisher": None, "year": None, "pageCount": None, "sources": ["Biblioteka Narodowa"]}
    base.update(values)
    return base


def test_resolve_maps_author_to_existing_spelling(lib):
    lib.find_or_create_author("J. K. Rowling")
    result = lib.resolve_lookup(info(title="Nowa książka", authorName="J.K. Rowling"))
    assert result["authorName"] == "J. K. Rowling"
    assert result["title"] == "Nowa książka"
    assert result["libraryBookId"] is None
    assert result["seriesName"] is None


def test_resolve_library_book_exact_unowned_and_owned(lib, conn):
    a = lib.find_or_create_author("Grzegorz Kasdepke")
    s = lib.find_or_create_series("Detektyw Pozytywka", a)
    unowned = add_raw_book(conn, "Detektyw Pozytywka", author_id=a, series_id=s, volume=1)
    result = lib.resolve_lookup(info(title="detektyw pozytywka", authorName="Grzegorz Kasdepke"))
    assert result["libraryBookId"] == unowned
    assert result["libraryBookOwned"] is False
    assert result["title"] == "Detektyw Pozytywka"
    assert (result["seriesName"], result["volumeNumber"]) == ("Detektyw Pozytywka", 1)

    lib.set_owned(unowned, True)
    result = lib.resolve_lookup(info(title="Detektyw Pozytywka", authorName="G. Kasdepke"))
    # Autor z innym looseKey – książka bez zgodnego autora nie pasuje… chyba że autor pusty.
    assert result["libraryBookId"] is None
    result = lib.resolve_lookup(info(title="Detektyw Pozytywka"))
    assert result["libraryBookId"] == unowned and result["libraryBookOwned"] is True
    assert result["authorName"] == "Grzegorz Kasdepke"


def test_resolve_library_book_fuzzy_prefix(lib, conn):
    a = lib.find_or_create_author("Grzegorz Kasdepke")
    long_title = add_raw_book(conn, "Bon czy ton. Savoir-vivre dla dzieci", author_id=a)
    result = lib.resolve_lookup(info(title="Bon czy ton", authorName="Grzegorz  Kasdepke"))
    assert result["libraryBookId"] == long_title
    # Bez autora krok rozmyty nie działa.
    assert lib.resolve_lookup(info(title="Bon czy ton"))["libraryBookId"] is None
    # Krótszy tytuł musi mieć co najmniej 2 słowa.
    one_word = add_raw_book(conn, "Kacperiada", author_id=a)
    assert lib.resolve_lookup(info(title="Kacperiada. Tom 2", authorName="Grzegorz Kasdepke"))["libraryBookId"] is None
    # Identyczne słowa (inna interpunkcja) nie pasują w kroku rozmytym – wymagana spacja po prefiksie.
    add_raw_book(conn, "Mama, tata i ja", author_id=a)
    assert lib.resolve_lookup(info(title="Mama tata i ja!", authorName="Grzegorz Kasdepke"))["libraryBookId"] is None
    assert one_word


def test_resolve_skips_library_book_when_editing(lib, conn):
    add_raw_book(conn, "Bajka", author_id=lib.find_or_create_author("A"))
    editing = lib.save_book({"title": "Robocza", "authorName": "A"})
    result = lib.resolve_lookup(info(title="Bajka", authorName="A"), editing_book_id=editing)
    assert result["libraryBookId"] is None
    # W edycji tytuł i autor z danych tylko, gdy pola są puste – tu nie są.
    assert result["title"] == "Robocza"
    assert result["authorName"] == "A"
    with pytest.raises(NotFoundError):
        lib.resolve_lookup(info(title="X"), editing_book_id=999)


def test_resolve_series_from_authors_series_in_title(lib, conn):
    a = lib.find_or_create_author("Marta Galewska-Kustra")
    pucio = lib.find_or_create_series("Pucio", a)
    add_raw_book(conn, "Pucio uczy się mówić", author_id=a, series_id=pucio)
    result = lib.resolve_lookup(
        info(title="Pucio mówi pierwsze słowa", authorName="Marta Galewska-Kustra",
             seriesName="Seria z kotem", isSeriesCertain=True)
    )
    assert result["seriesName"] == "Pucio"
    assert result["volumeNumber"] is None  # seria bez numerów → 0 → brak


def test_resolve_series_existing_loose_key_and_certainty(lib, conn):
    felix = lib.find_or_create_series("Felix, Net i Nika", lib.find_or_create_author("Rafał Kosik"))
    add_raw_book(conn, "Tom 1", series_id=felix, volume=1, owned=True)
    add_raw_book(conn, "Tom 2", series_id=felix, volume=2)
    result = lib.resolve_lookup(info(title="Felix, Net i Nika oraz Pałac Snów", seriesName="Felix Net i Nika"))
    assert result["seriesName"] == "Felix, Net i Nika"  # pisownia z bazy
    assert result["volumeNumber"] == 3  # suggestedVolumeNumber istniejącej serii
    result = lib.resolve_lookup(info(title="Inna", seriesName="Felix Net i Nika", volumeNumber=7))
    assert result["volumeNumber"] == 7
    # Seria wydawnicza spoza bazy – nie podpowiadamy; cykl pewny – tak (nowa seria bez tomów → brak numeru).
    assert lib.resolve_lookup(info(title="X", seriesName="Klub Książki"))["seriesName"] is None
    certain = lib.resolve_lookup(info(title="X", seriesName="Nowy cykl", isSeriesCertain=True))
    assert (certain["seriesName"], certain["volumeNumber"]) == ("Nowy cykl", None)
    certain = lib.resolve_lookup(info(title="X", seriesName="Nowy cykl", isSeriesCertain=True, volumeNumber=2))
    assert certain["volumeNumber"] == 2
    assert lib.resolve_lookup(info(title="X", seriesName="", isSeriesCertain=True))["seriesName"] is None
    # Numer spoza zakresu nie przechodzi.
    assert lib.resolve_lookup(info(title="X", seriesName="Nowy cykl", isSeriesCertain=True,
                                   volumeNumber=5000))["volumeNumber"] is None


def test_resolve_series_only_when_new_or_series_empty(lib, conn):
    editing = lib.save_book({"title": "T", "seriesName": "Moja seria"})
    result = lib.resolve_lookup(info(title="T", seriesName="Cykl", isSeriesCertain=True), editing_book_id=editing)
    assert result["seriesName"] is None
    result = lib.resolve_lookup(info(title="T", seriesName="Cykl", isSeriesCertain=True), editing_book_id=editing,
                                form={"seriesName": " "})
    assert result["seriesName"] == "Cykl"


def test_resolve_empty_author_does_not_clear_form(lib):
    result = lib.resolve_lookup(info(title="T", authorName=""), form={"authorName": "Wpisany Autor"})
    assert result["authorName"] == "Wpisany Autor"
    result = lib.resolve_lookup(info(title=None), form={"title": "Mój tytuł"})
    assert result["title"] == "Mój tytuł"


def test_resolve_isbn_book_ids(lib, conn):
    first = lib.save_book({"title": "A", "isbn": "9788375780635"})
    second = lib.save_book({"title": "B", "isbn": "83-7578-063-4"})
    lib.save_book({"title": "C", "isbn": "9788310128542"})
    assert lib.resolve_lookup(info(isbn="9788375780635", title="Z"))["isbnBookIds"] == [first, second]
    assert lib.resolve_lookup(info(title="Z"))["isbnBookIds"] == []


def test_with_books_flag_accepts_query_values(lib, conn):
    book_id = lib.save_book({"title": "T", "seriesName": "S"})
    s = conn.execute("SELECT series_id FROM book WHERE id = ?", (book_id,)).fetchone()[0]
    lib.delete_series(s, with_books="1")
    assert conn.execute("SELECT COUNT(*) FROM book").fetchone()[0] == 0
    with pytest.raises(LibraryError):
        lib.delete_series(s, with_books="może")
