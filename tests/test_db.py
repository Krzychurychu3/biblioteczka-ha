"""Testy warstwy bazy: migracje, metadane, transakcje z numerem rewizji."""

import re
import sqlite3
from datetime import datetime, timezone

import pytest

from biblioteczka import db


@pytest.fixture
def conn():
    c = db.open_db(":memory:")
    yield c
    c.close()


def test_schema_created(conn):
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"author", "series", "book", "meta"} <= tables
    indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {"book_author_idx", "book_series_idx", "book_isbn_idx", "series_author_idx"} <= indexes
    assert db.get_meta(conn, db.META_SCHEMA_VERSION) == str(db.SCHEMA_VERSION)
    assert db.revision(conn) == 0
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert isinstance(conn.execute("SELECT 1 AS x").fetchone(), sqlite3.Row)


def test_file_database_uses_wal_and_survives_reopen(tmp_path):
    path = tmp_path / "sub" / "biblioteczka.db"
    c = db.open_db(path)
    assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    with db.transaction(c):
        c.execute("INSERT INTO author(name, created_at) VALUES ('A', '2026-01-01T00:00:00Z')")
    c.close()
    c = db.open_db(path)
    assert c.execute("SELECT name FROM author").fetchone()[0] == "A"
    assert db.revision(c) == 1
    assert db.get_meta(c, db.META_SCHEMA_VERSION) == str(db.SCHEMA_VERSION)
    c.close()


def test_newer_schema_is_rejected(tmp_path):
    path = tmp_path / "b.db"
    c = db.open_db(path)
    db.set_meta(c, db.META_SCHEMA_VERSION, db.SCHEMA_VERSION + 1)
    c.close()
    with pytest.raises(RuntimeError):
        db.open_db(path)


def test_meta_roundtrip(conn):
    assert db.get_meta(conn, "x") is None
    assert db.get_meta(conn, "x", "d") == "d"
    db.set_meta(conn, "x", 5)
    db.set_meta(conn, "x", 7)
    assert db.get_meta(conn, "x") == "7"


def test_transaction_commits_and_bumps_revision(conn):
    with db.transaction(conn):
        conn.execute("INSERT INTO author(name, created_at) VALUES ('A', 't')")
    assert db.revision(conn) == 1
    assert not conn.in_transaction
    with db.transaction(conn, bump=False):
        conn.execute("INSERT INTO author(name, created_at) VALUES ('B', 't')")
    assert db.revision(conn) == 1
    assert conn.execute("SELECT COUNT(*) FROM author").fetchone()[0] == 2


def test_transaction_rolls_back_on_error(conn):
    with pytest.raises(ValueError):
        with db.transaction(conn):
            conn.execute("INSERT INTO author(name, created_at) VALUES ('A', 't')")
            raise ValueError("boom")
    assert conn.execute("SELECT COUNT(*) FROM author").fetchone()[0] == 0
    assert db.revision(conn) == 0
    assert not conn.in_transaction


def test_nested_transaction_uses_savepoint(conn):
    with db.transaction(conn):
        conn.execute("INSERT INTO author(name, created_at) VALUES ('outer', 't')")
        with pytest.raises(KeyError):
            with db.transaction(conn):
                conn.execute("INSERT INTO author(name, created_at) VALUES ('inner', 't')")
                raise KeyError("x")
        with db.transaction(conn):
            conn.execute("INSERT INTO author(name, created_at) VALUES ('inner2', 't')")
    names = [r[0] for r in conn.execute("SELECT name FROM author ORDER BY id")]
    assert names == ["outer", "inner2"]
    assert db.revision(conn) == 1  # tylko zewnętrzna transakcja zwiększa rewizję


def test_foreign_keys_nullify(conn):
    with db.transaction(conn):
        conn.execute("INSERT INTO author(id, name, created_at) VALUES (1, 'A', 't')")
        conn.execute("INSERT INTO series(id, name, created_at, author_id) VALUES (1, 'S', 't', 1)")
        conn.execute("INSERT INTO book(title, added_at, author_id, series_id) VALUES ('B', 't', 1, 1)")
    with db.transaction(conn):
        conn.execute("DELETE FROM author WHERE id = 1")
        conn.execute("DELETE FROM series WHERE id = 1")
    row = conn.execute("SELECT author_id, series_id, is_owned, notes FROM book").fetchone()
    assert tuple(row) == (None, None, 1, "")


def test_time_format():
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", db.utc_now())
    assert db.format_time(datetime(2001, 1, 1, tzinfo=timezone.utc)) == db.CATALOG_DATE
    assert db.format_time(datetime(2026, 5, 6, 7, 8, 9)) == "2026-05-06T07:08:09Z"


def _insert(conn, table):
    columns = {"author": "name, created_at", "series": "name, created_at", "book": "title, added_at"}[table]
    with db.transaction(conn):
        return conn.execute(f"INSERT INTO {table}({columns}) VALUES ('X', 't')").lastrowid


@pytest.mark.parametrize("table", ["author", "series", "book"])
def test_ids_are_not_reused_after_delete(conn, table):
    """sync-1: usunięta pozycja o najwyższym id nie oddaje go następnej (AUTOINCREMENT)."""
    first = _insert(conn, table)
    second = _insert(conn, table)
    with db.transaction(conn):
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (second,))
    third = _insert(conn, table)
    assert third > second > first


def test_ids_are_not_reused_after_deleting_everything(tmp_path):
    """sync-1: `DELETE FROM` („Usuń wszystkie dane”) nie zeruje licznika – także po ponownym otwarciu bazy."""
    path = tmp_path / "b.db"
    c = db.open_db(path)
    old = {table: _insert(c, table) for table in ("author", "series", "book")}
    with db.transaction(c):
        for table in ("book", "series", "author"):
            c.execute(f"DELETE FROM {table}")
    c.close()
    c = db.open_db(path)
    new = {table: _insert(c, table) for table in ("author", "series", "book")}
    c.close()
    assert all(new[table] > old[table] for table in old), (old, new)


def test_schema_uses_autoincrement(conn):
    for table in ("author", "series", "book"):
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()[0]
        assert "id INTEGER PRIMARY KEY AUTOINCREMENT" in sql, table
