"""Baza SQLite biblioteczki: połączenie, migracje schematu, metadane i transakcje z numerem rewizji.

Jedno połączenie na proces (aiohttp działa w jednym wątku). Każda zatwierdzona zmiana danych
zwiększa `meta('revision')` – po nim klienci poznają, że trzeba odświeżyć stan.
"""

from __future__ import annotations

import contextlib
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional, Union

logger = logging.getLogger(__name__)

# Kolejne migracje schematu: indeks + 1 = numer wersji po jej wykonaniu. Nigdy nie zmieniamy starych wpisów.
# AUTOINCREMENT: identyfikator usuniętej pozycji nigdy nie wraca (także po „Usuń wszystkie dane”,
# bo `DELETE FROM` nie zeruje `sqlite_sequence`) – nieaktualny edytor albo adres na innym urządzeniu
# dostaje wtedy 404 zamiast nadpisać lub pokazać zupełnie inną pozycję. Dopisane do wersji 1 jeszcze
# przed pierwszym wydaniem (jedyny wyjątek od zasady wyżej) – bazy testowe sprzed tej zmiany trzeba
# utworzyć od nowa; po wydaniu taka zmiana wymagałaby nowej migracji przebudowującej tabele.
MIGRATIONS: list[list[str]] = [
    [
        """CREATE TABLE author (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        )""",
        """CREATE TABLE series (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            planned_volume_count INTEGER NULL,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            author_id INTEGER NULL REFERENCES author(id) ON DELETE SET NULL
        )""",
        """CREATE TABLE book (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            volume_number INTEGER NULL,
            is_owned INTEGER NOT NULL DEFAULT 1,
            notes TEXT NOT NULL DEFAULT '',
            added_at TEXT NOT NULL,
            author_id INTEGER NULL REFERENCES author(id) ON DELETE SET NULL,
            series_id INTEGER NULL REFERENCES series(id) ON DELETE SET NULL,
            isbn TEXT NULL,
            publisher TEXT NULL,
            publication_year INTEGER NULL,
            page_count INTEGER NULL,
            cover_id TEXT NULL
        )""",
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE INDEX book_author_idx ON book(author_id)",
        "CREATE INDEX book_series_idx ON book(series_id)",
        "CREATE INDEX book_isbn_idx ON book(isbn)",
        "CREATE INDEX series_author_idx ON series(author_id)",
    ],
]

SCHEMA_VERSION = len(MIGRATIONS)

META_SCHEMA_VERSION = "schema_version"
META_REVISION = "revision"
META_CATALOG_VERSION = "starter_catalog_seeded_version"

# Data „dodania” pozycji z katalogu (Swift: `Date(timeIntervalSinceReferenceDate: 0)`).
CATALOG_DATE = "2001-01-01T00:00:00Z"


def utc_now() -> str:
    """Bieżący czas UTC w formacie `YYYY-MM-DDTHH:MM:SSZ`."""
    return format_time(datetime.now(timezone.utc))


def format_time(moment: datetime) -> str:
    """Czas jako tekst ISO-8601 UTC z sekundową dokładnością."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def open_db(path: Union[str, Path]) -> sqlite3.Connection:
    """Otwiera (lub tworzy) bazę, ustawia PRAGMA i wykonuje brakujące migracje.

    `":memory:"` daje bazę w pamięci (testy). Transakcjami sterujemy sami (`isolation_level=None`).
    """
    target = str(path)
    if target != ":memory:":
        Path(target).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if target != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    _migrate(conn)
    return conn


def _has_meta_table(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").fetchone()
    return row is not None


def _schema_version(conn: sqlite3.Connection) -> int:
    if not _has_meta_table(conn):
        return 0
    return int(get_meta(conn, META_SCHEMA_VERSION, "0"))


def _migrate(conn: sqlite3.Connection) -> None:
    current = _schema_version(conn)
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"Baza ma nowszy schemat ({current}) niż obsługuje ta wersja aplikacji ({SCHEMA_VERSION})."
        )
    for version in range(current + 1, SCHEMA_VERSION + 1):
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in MIGRATIONS[version - 1]:
                conn.execute(statement)
            set_meta(conn, META_SCHEMA_VERSION, version)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        logger.info("Schemat bazy zaktualizowany do wersji %d", version)


def get_meta(conn: sqlite3.Connection, key: str, default: Optional[str] = None) -> Optional[str]:
    """Wartość z tabeli `meta` (tekst) albo `default`."""
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return default if row is None else row[0]


def set_meta(conn: sqlite3.Connection, key: str, value: object) -> None:
    """Zapisuje wartość w tabeli `meta` (zamieniana na tekst)."""
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def revision(conn: sqlite3.Connection) -> int:
    """Numer rewizji danych (0 w nowej bazie)."""
    return int(get_meta(conn, META_REVISION, "0") or 0)


def bump_revision(conn: sqlite3.Connection) -> int:
    """Zwiększa numer rewizji o 1 i zwraca nową wartość."""
    value = revision(conn) + 1
    set_meta(conn, META_REVISION, value)
    return value


_savepoint_counter = 0


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection, bump: bool = True) -> Iterator[sqlite3.Connection]:
    """Jedna transakcja: zatwierdza i zwiększa rewizję po sukcesie, wycofuje przy błędzie.

    Wywołanie wewnątrz trwającej transakcji tworzy SAVEPOINT – rewizję zwiększa tylko zewnętrzna.
    """
    global _savepoint_counter
    if conn.in_transaction:
        _savepoint_counter += 1
        name = f"sp_{_savepoint_counter}"
        conn.execute(f"SAVEPOINT {name}")
        try:
            yield conn
        except BaseException:
            conn.execute(f"ROLLBACK TO SAVEPOINT {name}")
            conn.execute(f"RELEASE SAVEPOINT {name}")
            raise
        conn.execute(f"RELEASE SAVEPOINT {name}")
        return

    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        if bump:
            bump_revision(conn)
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
