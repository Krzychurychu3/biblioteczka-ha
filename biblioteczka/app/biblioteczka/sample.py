"""Przykładowe dane do wypróbowania aplikacji (tylko tryb deweloperski) – port `SampleData.swift`."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from . import db
from .store import Library

# (seria, autor, liczba tomów, tytuły kolejnych tomów, numery posiadanych tomów)
SERIES = [
    (
        "Wiedźmin",
        "Andrzej Sapkowski",
        8,
        [
            "Ostatnie życzenie", "Miecz przeznaczenia", "Krew elfów", "Czas pogardy",
            "Chrzest ognia", "Wieża Jaskółki", "Pani Jeziora", "Sezon burz",
        ],
        {1, 2, 3, 5, 7},
    ),
    (
        "Harry Potter",
        "J.K. Rowling",
        7,
        [
            "Harry Potter i Kamień Filozoficzny", "Harry Potter i Komnata Tajemnic",
            "Harry Potter i więzień Azkabanu", "Harry Potter i Czara Ognia",
            "Harry Potter i Zakon Feniksa", "Harry Potter i Książę Półkrwi",
            "Harry Potter i Insygnia Śmierci",
        ],
        {1, 2, 3, 4, 5, 6, 7},
    ),
    ("Diuna", "Frank Herbert", 6, ["Diuna", "Mesjasz Diuny", "Dzieci Diuny"], {1, 2, 3}),
    (
        "Ziemiomorze",
        "Ursula K. Le Guin",
        6,
        ["Czarnoksiężnik z Archipelagu", "Grobowce Atuanu", "Najdalszy brzeg", "Tehanu"],
        {1, 2},
    ),
]

# (tytuł, autor, czy posiadana) – książki spoza serii.
STANDALONE = [
    ("Solaris", "Stanisław Lem", True),
    ("Cyberiada", "Stanisław Lem", False),
    ("Lalka", "Bolesław Prus", True),
    ("Pan Tadeusz", "Adam Mickiewicz", True),
]


def insert_sample_data(conn: sqlite3.Connection, now: Optional[datetime] = None) -> int:
    """Dodaje przykładowe serie i książki (autorów i serie wyszukuje lub tworzy). Zwraca liczbę książek.

    Daty dodania zaczynają się dobę wstecz i rosną o minutę z każdą książką – w kolejności wstawiania.
    """
    moment = (now or datetime.now(timezone.utc)) - timedelta(days=1)
    library = Library(conn)
    added = 0
    with db.transaction(conn):
        for name, author_name, planned, titles, owned in SERIES:
            author_id = library._find_or_create_author(author_name)
            series_id = library._find_or_create_series(name, author_id)
            if author_id is None or series_id is None:
                continue
            conn.execute("UPDATE series SET planned_volume_count = ? WHERE id = ?", (planned, series_id))
            for index, title in enumerate(titles):
                number = index + 1
                moment += timedelta(seconds=60)
                conn.execute(
                    """INSERT INTO book(title, volume_number, is_owned, notes, added_at, author_id, series_id)
                       VALUES (?, ?, ?, '', ?, ?, ?)""",
                    (title, number, int(number in owned), db.format_time(moment), author_id, series_id),
                )
                added += 1
        for title, author_name, is_owned in STANDALONE:
            moment += timedelta(seconds=60)
            conn.execute(
                """INSERT INTO book(title, is_owned, notes, added_at, author_id) VALUES (?, ?, '', ?, ?)""",
                (title, int(is_owned), db.format_time(moment), library._find_or_create_author(author_name)),
            )
            added += 1
    return added


def insert_sample_data_if_empty(conn: sqlite3.Connection, now: Optional[datetime] = None) -> int:
    """Przykładowe dane tylko do pustej bazy (bez żadnej książki, także z katalogu). Zwraca liczbę książek."""
    if conn.execute("SELECT 1 FROM book LIMIT 1").fetchone() is not None:
        return 0
    return insert_sample_data(conn, now)
