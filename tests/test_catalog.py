"""Testy katalogu bajek (logic.md §8 i addendum E): format, import bez duplikatów, zasiewanie wg wersji."""

import json

import pytest

from biblioteczka import catalog, db
from biblioteczka.store import Library


@pytest.fixture
def conn():
    c = db.open_db(":memory:")
    yield c
    c.close()


def write_catalog(path, books, version=1):
    path.write_text(json.dumps({"version": version, "name": "Test", "books": books}, ensure_ascii=False),
                    encoding="utf-8")
    return path


def books(conn):
    return conn.execute(
        """SELECT b.*, a.name AS author_name, s.name AS series_name, s.author_id AS series_author
           FROM book b LEFT JOIN author a ON a.id = b.author_id LEFT JOIN series s ON s.id = b.series_id
           ORDER BY b.id"""
    ).fetchall()


SMALL = [
    {"title": "Felix, Net i Nika oraz Gang", "author": "Rafał Kosik", "series": "Felix, Net i Nika", "volume": 1,
     "year": 2004},
    {"title": "Felix, Net i Nika oraz Katastrofa", "author": "Rafał Kosik", "series": "Felix, Net i Nika",
     "volume": 2, "year": 2005},
    {"title": "Opowiem ci, mamo, co robią dinozaury", "author": "Katharina von der Gathen",
     "series": "Opowiem ci, mamo", "volume": None},
    {"title": "Opowiem ci, mamo, co robią mrówki", "author": "Inny Autor", "series": "Opowiem ci, mamo"},
    {"title": "Dzieci z Bullerbyn", "author": "Astrid Lindgren", "series": None, "volume": 3, "year": 1958,
     "extra": "ignorowane"},
]


def test_bundled_catalog_loads_and_has_expected_shape():
    loaded = catalog.load_catalog()
    assert loaded is not None
    assert loaded.version == 1
    assert len(loaded.books) == 100
    assert len({e.author for e in loaded.books}) == 44
    assert len({e.series for e in loaded.books if e.series is not None}) == 23
    assert catalog.catalog_available()


def test_seed_full_catalog(conn):
    added = catalog.seed_if_needed(conn)
    assert added == 100
    rows = books(conn)
    assert len(rows) == 100
    assert all(r["is_owned"] == 0 for r in rows)
    assert all(r["added_at"] == db.CATALOG_DATE for r in rows)
    assert all(r["publication_year"] is None for r in rows)  # „year” z katalogu nie jest używany
    assert conn.execute("SELECT COUNT(*) FROM author").fetchone()[0] == 44
    assert conn.execute("SELECT COUNT(*) FROM series").fetchone()[0] == 23
    shared = conn.execute("SELECT * FROM series WHERE name = 'Opowiem ci, mamo'").fetchall()
    assert len(shared) == 1 and shared[0]["author_id"] is None
    assert all(r["volume_number"] is None for r in rows if r["series_id"] is None)
    assert db.get_meta(conn, db.META_CATALOG_VERSION) == "1"
    assert db.revision(conn) == 1
    assert catalog.seed_if_needed(conn) == 0  # ta wersja już zasiana
    assert db.revision(conn) == 1


def test_import_small_catalog(conn, tmp_path):
    path = write_catalog(tmp_path / "k.json", SMALL)
    assert catalog.import_missing(conn, path) == 5
    rows = books(conn)
    felix = [r for r in rows if r["series_name"] == "Felix, Net i Nika"]
    assert [r["volume_number"] for r in felix] == [1, 2]
    assert len({r["series_id"] for r in felix}) == 1
    assert felix[0]["series_author"] == felix[0]["author_id"]
    mamo = [r for r in rows if r["series_name"] == "Opowiem ci, mamo"]
    assert len({r["series_id"] for r in mamo}) == 1
    assert mamo[0]["series_author"] is None  # seria wielu autorów – wspólna, bez autora
    assert {r["author_name"] for r in mamo} == {"Katharina von der Gathen", "Inny Autor"}
    bullerbyn = next(r for r in rows if r["title"] == "Dzieci z Bullerbyn")
    assert bullerbyn["series_id"] is None and bullerbyn["volume_number"] is None
    # Ręczne uzupełnienie nie zmienia wersji zasiewu i nie dubluje wpisów.
    assert db.get_meta(conn, db.META_CATALOG_VERSION) is None
    assert catalog.import_missing(conn, path) == 0


def test_import_never_modifies_existing_books(conn, tmp_path):
    lib = Library(conn)
    owned = lib.save_book({"title": "felix, net i nika oraz gang", "authorName": "RAFAŁ KOSIK", "notes": "moja"})
    # Posiadana kopia tytułu z katalogu blokuje jego ponowny import.
    lib.save_book({"title": "Dzieci z Bullerbyn", "authorName": "Astrid Lindgren"})
    path = write_catalog(tmp_path / "k.json", SMALL)
    assert catalog.import_missing(conn, path) == 3
    row = conn.execute("SELECT * FROM book WHERE id = ?", (owned,)).fetchone()
    assert row["is_owned"] == 1 and row["notes"] == "moja" and row["series_id"] is None
    assert conn.execute("SELECT COUNT(*) FROM author WHERE name = 'Rafał Kosik'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM author").fetchone()[0] == 4  # „RAFAŁ KOSIK” użyty ponownie


def test_import_dedups_on_title_and_author_including_missing_author(conn, tmp_path):
    lib = Library(conn)
    lib.save_book({"title": "Bez autora"})
    path = write_catalog(
        tmp_path / "k.json",
        [{"title": "Bez autora", "author": "  "}, {"title": "Bez autora", "author": "Ktoś"},
         {"title": "Wiedzmin", "author": "X"}, {"title": "Wiedźmin", "author": "X"}],
    )
    assert catalog.import_missing(conn, path) == 3
    blank = conn.execute("SELECT * FROM book WHERE title = 'Bez autora' AND author_id IS NULL").fetchall()
    assert len(blank) == 1


def test_import_reuses_existing_series_and_clamps_volume(conn, tmp_path):
    lib = Library(conn)
    kosik = lib.find_or_create_author("Rafał Kosik")
    existing = lib.find_or_create_series("FELIX, NET I NIKA", kosik)
    path = write_catalog(
        tmp_path / "k.json",
        [{"title": "Tom zero", "author": "Rafał Kosik", "series": "Felix, Net i Nika", "volume": 0},
         {"title": "Tom 5000", "author": "Rafał Kosik", "series": "Felix, Net i Nika", "volume": 5000},
         {"title": "Pusta seria", "author": "Rafał Kosik", "series": "", "volume": 2}],
    )
    assert catalog.import_missing(conn, path) == 3
    rows = {r["title"]: r for r in books(conn)}
    assert rows["Tom zero"]["series_id"] == existing and rows["Tom zero"]["volume_number"] is None
    assert rows["Tom 5000"]["volume_number"] is None
    assert rows["Pusta seria"]["series_id"] is None and rows["Pusta seria"]["volume_number"] is None


def test_seed_is_version_based_not_empty_db_based(conn, tmp_path):
    v1 = write_catalog(tmp_path / "v1.json", SMALL[:2], version=1)
    assert catalog.seed_if_needed(conn, v1) == 2
    Library(conn).delete_all()
    assert catalog.seed_if_needed(conn, v1) == 0  # po „Usuń wszystkie dane” katalog nie wraca sam
    assert conn.execute("SELECT COUNT(*) FROM book").fetchone()[0] == 0
    v2 = write_catalog(tmp_path / "v2.json", SMALL, version=2)
    assert catalog.seed_if_needed(conn, v2) == 5  # nowsza wersja dodaje brakujące, także usunięte
    assert db.get_meta(conn, db.META_CATALOG_VERSION) == "2"
    assert catalog.seed_if_needed(conn, v2) == 0


def test_deleted_book_does_not_return_on_restart(conn, tmp_path):
    path = write_catalog(tmp_path / "k.json", SMALL)
    catalog.seed_if_needed(conn, path)
    first = conn.execute("SELECT id FROM book ORDER BY id").fetchone()[0]
    Library(conn).delete_book(first)
    assert catalog.seed_if_needed(conn, path) == 0
    assert catalog.import_missing(conn, path) == 1  # ręcznie z menu – wraca


@pytest.mark.parametrize(
    "content",
    [
        "nie json",
        json.dumps([]),
        json.dumps({"name": "x", "books": []}),
        json.dumps({"version": "1", "name": "x", "books": []}),
        json.dumps({"version": True, "name": "x", "books": []}),
        json.dumps({"version": 1, "books": []}),
        json.dumps({"version": 1, "name": "x", "books": {}}),
        json.dumps({"version": 1, "name": "x", "books": [{"title": "t"}]}),
        json.dumps({"version": 1, "name": "x", "books": [{"title": "t", "author": 5}]}),
        json.dumps({"version": 1, "name": "x", "books": [{"title": "t", "author": "a", "volume": "1"}]}),
        json.dumps({"version": 1, "name": "x", "books": [{"title": "t", "author": "a", "series": 3}]}),
        json.dumps({"version": 1, "name": "x", "books": [{"title": "t", "author": "a", "year": 1.5}]}),
    ],
)
def test_invalid_catalog_is_unavailable(conn, tmp_path, content):
    path = tmp_path / "zly.json"
    path.write_text(content, encoding="utf-8")
    assert catalog.load_catalog(path) is None
    assert not catalog.catalog_available(path)
    assert catalog.seed_if_needed(conn, path) == 0
    assert catalog.import_missing(conn, path) == 0
    assert db.get_meta(conn, db.META_CATALOG_VERSION) is None
    assert db.revision(conn) == 0


def test_missing_catalog_file(conn, tmp_path):
    assert catalog.load_catalog(tmp_path / "brak.json") is None
    assert catalog.seed_if_needed(conn, tmp_path / "brak.json") == 0


def test_catalog_text_is_nfc(conn, tmp_path):
    path = write_catalog(tmp_path / "k.json", [{"title": "Żółw", "author": "Łácki"}])
    catalog.import_missing(conn, path)
    row = books(conn)[0]
    assert row["title"] == "Żółw"
    assert row["author_name"] == "Łácki"


def _messages(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "biblioteczka.catalog"]


@pytest.mark.parametrize(("count", "text"), [(1, "1 książka"), (3, "3 książki"), (5, "5 książek")])
def test_log_uses_polish_plural(conn, tmp_path, caplog, count, text):
    """Przegląd pl-7: dziennik pisał „Katalog: dodano 1 pozycji”."""
    entries = [{"title": f"Bajka {i}", "author": "Autor"} for i in range(count)]
    caplog.set_level("INFO", logger="biblioteczka.catalog")
    catalog.import_missing(conn, write_catalog(tmp_path / "k.json", entries))
    assert _messages(caplog) == [f"Uzupełniono katalog bajek: {text}"]
    caplog.clear()
    catalog.import_missing(conn, write_catalog(tmp_path / "k.json", entries))
    assert _messages(caplog) == ["Uzupełniono katalog bajek: 0 książek"]
    caplog.clear()
    catalog.seed_if_needed(conn, write_catalog(tmp_path / "k2.json", entries + [{"title": "Nowa", "author": "A"}], 2))
    assert _messages(caplog) == ["Zasiano katalog bajek w wersji 2: 1 książka"]
