"""Testy przykładowych danych (logic.md §13.2)."""

from datetime import datetime, timezone

import pytest

from biblioteczka import db, sample, views
from biblioteczka.store import Library

NOW = datetime(2026, 11, 15, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def conn():
    c = db.open_db(":memory:")
    yield c
    c.close()


def by_name(items, key, value):
    return next(item for item in items if item[key] == value)


def test_sample_data_content_and_progress(conn):
    assert sample.insert_sample_data(conn, now=NOW) == 26
    state = views.build_state(conn, "0.1.0")
    series = state["series"]
    expected = {
        "Wiedźmin": ("5/8", False, "Brakuje tomów: 4, 6, 8"),
        "Harry Potter": ("7/7", True, None),
        "Diuna": ("3/6", False, "Brakuje tomów: 4, 5, 6"),
        "Ziemiomorze": ("2/6", False, "Brakuje tomów: 3, 4, 5, 6"),
    }
    assert {s["name"] for s in series} == set(expected)
    for name, (label, complete, missing) in expected.items():
        item = by_name(series, "name", name)
        assert item["progress"]["label"] == label
        assert item["progress"]["isComplete"] is complete
        assert item["missingDescription"] == missing
        assert item["plannedVolumeCount"] is not None
    books = state["books"]
    assert by_name(books, "title", "Cyberiada")["isOwned"] is False
    assert by_name(books, "title", "Solaris")["seriesId"] is None
    assert by_name(books, "title", "Tehanu")["volumeNumber"] == 4
    lem = by_name(state["authors"], "name", "Stanisław Lem")
    assert lem["ownedSummary"] == "1 książka" and lem["summary"] == "2 książki"
    assert by_name(state["authors"], "name", "J.K. Rowling")["ownedSummary"] == "1 seria · 7 książek"


def test_sample_added_at_sequence(conn):
    sample.insert_sample_data(conn, now=NOW)
    rows = conn.execute("SELECT title, added_at FROM book ORDER BY id").fetchall()
    assert rows[0]["title"] == "Ostatnie życzenie"
    assert rows[0]["added_at"] == "2026-11-14T12:01:00Z"  # doba wstecz + minuta
    assert rows[-1]["title"] == "Pan Tadeusz"
    assert rows[-1]["added_at"] == "2026-11-14T12:26:00Z"
    stamps = [r["added_at"] for r in rows]
    assert stamps == sorted(stamps) and len(set(stamps)) == len(stamps)


def test_sample_reuses_authors_and_overwrites_planned_count(conn):
    lib = Library(conn)
    author_id = lib.find_or_create_author("andrzej sapkowski")
    series_id = lib.save_series({"name": "wiedźmin", "authorName": "Andrzej Sapkowski", "plannedVolumeCount": 3})
    sample.insert_sample_data(conn, now=NOW)
    assert conn.execute("SELECT COUNT(*) FROM author WHERE name LIKE '%apkowski'").fetchone()[0] == 1
    row = conn.execute("SELECT * FROM series WHERE id = ?", (series_id,)).fetchone()
    assert row["planned_volume_count"] == 8
    assert conn.execute("SELECT COUNT(*) FROM book WHERE series_id = ?", (series_id,)).fetchone()[0] == 8
    assert row["author_id"] == author_id
    # Książki są wstawiane zawsze – drugi raz powstają duplikaty (jak w iOS).
    sample.insert_sample_data(conn, now=NOW)
    assert conn.execute("SELECT COUNT(*) FROM book").fetchone()[0] == 52


def test_insert_if_empty(conn):
    assert sample.insert_sample_data_if_empty(conn, now=NOW) == 26
    assert sample.insert_sample_data_if_empty(conn, now=NOW) == 0
    other = db.open_db(":memory:")
    Library(other).save_book({"title": "Z katalogu", "isOwned": False})
    assert sample.insert_sample_data_if_empty(other, now=NOW) == 0
    other.close()


def test_sample_bumps_revision_once(conn):
    sample.insert_sample_data(conn, now=NOW)
    assert db.revision(conn) == 1
