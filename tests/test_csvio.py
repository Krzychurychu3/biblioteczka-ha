"""Testy eksportu CSV (bajt w bajt jak iOS, logic.md §12) i importu pliku z eksportu."""

import csv

import pytest

from biblioteczka import csvio, db
from biblioteczka.store import Library, LibraryError

HEADER = '"Tytuł";"Autor";"Seria";"Tom";"Status";"ISBN";"Wydawnictwo";"Rok wydania";"Liczba stron";"Notatki"'


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


def all_books(conn):
    return conn.execute(
        """SELECT b.*, a.name AS author_name, s.name AS series_name FROM book b
           LEFT JOIN author a ON a.id = b.author_id LEFT JOIN series s ON s.id = b.series_id ORDER BY b.id"""
    ).fetchall()


# --- Eksport ---


def test_export_empty_library(conn):
    assert csvio.export_csv(conn) == "﻿" + HEADER
    assert not csvio.has_exportable_books(conn)


def test_export_byte_exact(lib, conn):
    lib.save_book({"title": "Krew elfów", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin",
                   "volumeNumber": 3, "isbn": "9788375780635", "publisher": "superNOWA", "publicationYear": 2014,
                   "pageCount": 340, "notes": 'Pożyczona "Ani"\ndruga linia'})
    lib.save_book({"title": "Ostatnie życzenie", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin",
                   "volumeNumber": 1})
    lib.save_book({"title": "Sezon burz", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin",
                   "isOwned": False})
    lib.save_book({"title": "Bez autora", "isbn": "zły numer"})
    lib.save_book({"title": "Łąka", "authorName": "Łucja Zet"})
    lib.save_book({"title": "abc", "authorName": "Zofia"})
    lib.save_book({"title": "ABC", "authorName": "Zofia"})
    expected = "﻿" + "\r\n".join(
        [
            HEADER,
            '"Bez autora";"";"";"";"Mam";"zły numer";"";"";"";""',
            '"Sezon burz";"Andrzej Sapkowski";"Wiedźmin";"";"Brakuje";"";"";"";"";""',
            '"Ostatnie życzenie";"Andrzej Sapkowski";"Wiedźmin";"1";"Mam";"";"";"";"";""',
            '"Krew elfów";"Andrzej Sapkowski";"Wiedźmin";"3";"Mam";"9788375780635";"superNOWA";"2014";"340";'
            '"Pożyczona ""Ani""\ndruga linia"',
            '"ABC";"Zofia";"";"";"Mam";"";"";"";"";""',
            '"abc";"Zofia";"";"";"Mam";"";"";"";"";""',
            '"Łąka";"Łucja Zet";"";"";"Mam";"";"";"";"";""',
        ]
    )
    text = csvio.export_csv(conn)
    assert text == expected
    assert not text.endswith("\r\n")
    assert text.encode("utf-8").startswith(b"\xef\xbb\xbf")


def test_export_selection_and_orphan_volume(lib, conn):
    a = lib.find_or_create_author("A")
    collected = lib.find_or_create_series("Zbierana", a)
    catalog_series = lib.find_or_create_series("Katalogowa", a)
    raw(conn, "Mam tom 1", author_id=a, series_id=collected, volume=1)
    raw(conn, "Brakuje tomu 2", author_id=a, series_id=collected, volume=2, owned=False)
    raw(conn, "Tylko katalog", author_id=a, series_id=catalog_series, volume=1, owned=False)
    raw(conn, "Nie mam, bez serii", author_id=a, owned=False)
    raw(conn, "Bez serii z numerem", author_id=a, volume=4)
    lines = csvio.export_csv(conn).split("\r\n")[1:]
    titles = [line.split(";")[0].strip('"') for line in lines]
    assert titles == ["Bez serii z numerem", "Mam tom 1", "Brakuje tomu 2"]
    assert lines[0].split(";")[3] == '"4"'  # numer tomu bez serii też trafia do eksportu
    assert csvio.has_exportable_books(conn)


# --- Import ---


def test_import_roundtrip_of_ios_export(lib, conn, tmp_path):
    lib.save_book({"title": "Krew elfów", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin",
                   "volumeNumber": 3, "isbn": "9788375780635", "notes": "a\r\nb; \"c\""})
    lib.save_book({"title": "Czas pogardy", "authorName": "Andrzej Sapkowski", "seriesName": "Wiedźmin",
                   "volumeNumber": 4, "isOwned": False})
    lib.save_book({"title": "Solaris", "authorName": "Stanisław Lem", "publisher": "WL", "publicationYear": 1961,
                   "pageCount": 300})
    text = csvio.export_csv(conn)
    other = db.open_db(":memory:")
    report = csvio.import_csv(other, text)
    assert report == {"added": 3, "updated": 0, "skipped": 0, "errors": [], "errorCount": 0}
    assert csvio.export_csv(other) == text
    assert db.revision(other) == 1
    rows = {r["title"]: r for r in all_books(other)}
    assert rows["Czas pogardy"]["is_owned"] == 0
    assert rows["Krew elfów"]["series_id"] == rows["Czas pogardy"]["series_id"]
    assert rows["Krew elfów"]["notes"] == "a\r\nb; \"c\""
    # Ponowny import niczego nie zmienia.
    assert csvio.import_csv(other, text) == {"added": 0, "updated": 0, "skipped": 3, "errors": [], "errorCount": 0}
    other.close()


def test_import_comma_separator_lf_and_missing_columns(conn):
    text = 'Tytuł,Autor,Status\n"Lalka","Bolesław Prus",Mam\nPan Tadeusz,Adam Mickiewicz,Brakuje\n\n'
    report = csvio.import_csv(conn, text)
    assert report == {"added": 2, "updated": 0, "skipped": 0, "errors": [], "errorCount": 0}
    rows = {r["title"]: r for r in all_books(conn)}
    assert rows["Lalka"]["is_owned"] == 1 and rows["Lalka"]["author_name"] == "Bolesław Prus"
    assert rows["Pan Tadeusz"]["is_owned"] == 0
    assert rows["Lalka"]["isbn"] is None and rows["Lalka"]["notes"] == ""


def test_import_header_without_polish_letters_and_reordered(conn):
    text = "﻿Autor;Tytul;Tom;Seria\r\nAndrzej Sapkowski;Krew elfów;3;Wiedźmin"
    assert csvio.import_csv(conn, text)["added"] == 1
    row = all_books(conn)[0]
    assert (row["title"], row["author_name"], row["series_name"], row["volume_number"]) == (
        "Krew elfów", "Andrzej Sapkowski", "Wiedźmin", 3)


def test_import_fills_only_empty_fields_and_marks_owned(lib, conn):
    existing = lib.save_book({"title": "Krew elfów", "authorName": "Andrzej Sapkowski", "publisher": "Stary",
                              "isOwned": False, "notes": ""})
    before = conn.execute("SELECT added_at FROM book WHERE id = ?", (existing,)).fetchone()[0]
    text = ("Tytuł;Autor;Seria;Tom;Status;ISBN;Wydawnictwo;Rok wydania;Liczba stron;Notatki\n"
            "krew elfów;andrzej sapkowski;Wiedźmin;3;Mam;9788375780635;Nowy;1994;340;z CSV")
    report = csvio.import_csv(conn, text)
    assert report == {"added": 0, "updated": 1, "skipped": 0, "errors": [], "errorCount": 0}
    row = all_books(conn)[0]
    assert row["title"] == "Krew elfów"  # tytuł i nazwy z bazy zostają
    assert row["publisher"] == "Stary"  # niepuste pole nie jest nadpisywane
    assert (row["isbn"], row["publication_year"], row["page_count"], row["notes"]) == (
        "9788375780635", 1994, 340, "z CSV")
    assert row["series_name"] == "Wiedźmin" and row["volume_number"] == 3
    assert row["is_owned"] == 1
    assert row["added_at"] >= before


def test_import_brakuje_never_unmarks_owned(lib, conn):
    lib.save_book({"title": "Solaris", "authorName": "Stanisław Lem"})
    report = csvio.import_csv(conn, "Tytuł;Autor;Status\nSolaris;Stanisław Lem;Brakuje")
    assert report["skipped"] == 1
    assert all_books(conn)[0]["is_owned"] == 1


def test_import_matches_by_isbn_first(lib, conn):
    lib.save_book({"title": "Wiedźmin. Ostatnie życzenie", "authorName": "A. Sapkowski", "isbn": "9788375780635"})
    report = csvio.import_csv(conn, 'Tytuł;Autor;ISBN;Notatki\nOstatnie życzenie;Andrzej Sapkowski;83-7578-063-4;x')
    assert report == {"added": 0, "updated": 1, "skipped": 0, "errors": [], "errorCount": 0}
    assert all_books(conn)[0]["notes"] == "x"


def test_import_different_isbn_is_another_edition(lib, conn):
    lib.save_book({"title": "Solaris", "authorName": "Stanisław Lem", "isbn": "9788375780635"})
    report = csvio.import_csv(conn, "Tytuł;Autor;ISBN\nSolaris;Stanisław Lem;9788310128546\nSolaris;Stanisław Lem;")
    assert report == {"added": 1, "updated": 0, "skipped": 1, "errors": [], "errorCount": 0}
    assert len(all_books(conn)) == 2


def test_import_dedups_within_file(conn):
    report = csvio.import_csv(conn, "Tytuł;Autor;Notatki\nLalka;Prus;\nlalka;PRUS;druga")
    assert report == {"added": 1, "updated": 1, "skipped": 0, "errors": [], "errorCount": 0}
    row = all_books(conn)[0]
    assert row["notes"] == "druga"


def test_import_reports_problems(conn):
    text = ("Tytuł;Autor;Tom;Status;Rok wydania;Liczba stron;Seria\n"
            ";Bez tytułu;;Mam;;;\n"
            "Dobra;A;x;Może;3000;-5;S\n"
            "Druga;A;1000;mam;1999;12;S\n")
    report = csvio.import_csv(conn, text)
    assert report["added"] == 2 and report["skipped"] == 1 and report["updated"] == 0
    assert report["errors"] == [
        "Wiersz 2: brak tytułu – pominięto.",
        "Wiersz 3: nieznany status „Może” – przyjęto „Mam”.",
        "Wiersz 3: pominięto niepoprawny numer tomu „x”.",
        "Wiersz 3: pominięto niepoprawny rok wydania „3000”.",
        "Wiersz 3: pominięto niepoprawną liczbę stron „-5”.",
        "Wiersz 4: pominięto niepoprawny numer tomu „1000”.",
    ]
    assert report["errorCount"] == 6
    rows = {r["title"]: r for r in all_books(conn)}
    assert rows["Dobra"]["is_owned"] == 1
    assert (rows["Dobra"]["volume_number"], rows["Dobra"]["publication_year"], rows["Dobra"]["page_count"]) == (
        None, None, None)
    assert (rows["Druga"]["publication_year"], rows["Druga"]["page_count"]) == (1999, 12)


def test_import_errors_are_capped(conn):
    lines = ["Tytuł;Tom;Seria"] + [f"T{i};zły;S" for i in range(csvio.MAX_ERRORS + 7)]
    report = csvio.import_csv(conn, "\n".join(lines))
    # Najwyżej MAX_ERRORS komunikatów, bez dopisanego zdania podsumowania; pełna liczba w errorCount.
    assert len(report["errors"]) == csvio.MAX_ERRORS
    assert all(e.startswith("Wiersz ") for e in report["errors"])
    assert report["errors"][-1] == f"Wiersz {csvio.MAX_ERRORS + 1}: pominięto niepoprawny numer tomu „zły”."
    assert report["errorCount"] == csvio.MAX_ERRORS + 7
    assert report["added"] == csvio.MAX_ERRORS + 7


@pytest.mark.parametrize("text", ["", "﻿  \r\n", "Imię;Nazwisko\nJan;Kowalski"])
def test_import_rejects_files_without_title_column(conn, text):
    with pytest.raises(LibraryError):
        csvio.import_csv(conn, text)
    assert db.revision(conn) == 0


def test_import_new_book_inherits_series_author(lib, conn):
    a = lib.find_or_create_author("Rafał Kosik")
    s = lib.find_or_create_series("Felix, Net i Nika", a)
    csvio.import_csv(conn, "Tytuł;Seria;Tom\nNowy tom;felix, net i nika;9")
    row = all_books(conn)[0]
    assert row["series_id"] == s and row["author_id"] == a and row["volume_number"] == 9


def test_import_row_without_author_in_series_with_author_is_not_duplicated(lib, conn):
    """Wiersz bez autora w serii z autorem: książka dziedziczy autora serii, więc ponowny import
    (albo ten sam wiersz drugi raz w pliku) ma ją znaleźć, a nie dodać duplikat."""
    a = lib.find_or_create_author("Rafał Kosik")
    s = lib.find_or_create_series("Felix, Net i Nika", a)
    text = ("Tytuł;Seria;Tom;Notatki\n"
            "Nowy tom;felix, net i nika;9;\n"
            "nowy TOM;Felix, Net i Nika;;druga\n")
    report = csvio.import_csv(conn, text)
    assert report == {"added": 1, "updated": 1, "skipped": 0, "errors": [], "errorCount": 0}
    again = csvio.import_csv(conn, text)
    assert again == {"added": 0, "updated": 0, "skipped": 2, "errors": [], "errorCount": 0}
    rows = all_books(conn)
    assert len(rows) == 1
    assert (rows[0]["author_id"], rows[0]["series_id"], rows[0]["volume_number"], rows[0]["notes"]) == (
        a, s, 9, "druga")
    # Książka dodana w aplikacji (save_book też dziedziczy autora serii) jest dopasowana tak samo.
    lib.save_book({"title": "Z aplikacji", "seriesName": "Felix, Net i Nika", "volumeNumber": 10})
    assert csvio.import_csv(conn, "Tytuł;Seria;Notatki\nZ aplikacji;Felix, Net i Nika;x")["updated"] == 1
    assert len(all_books(conn)) == 2


def test_import_row_without_author_prefers_book_without_author(lib, conn):
    """Najpierw (jak dotąd) książka bez autora o tym tytule; autor serii jest dopiero drugim kluczem.
    Inny poprawny ISBN nadal oznacza inne wydanie."""
    a = lib.find_or_create_author("Rafał Kosik")
    lib.find_or_create_series("Felix, Net i Nika", a)
    loose = raw(conn, "Nowy tom")
    with_author = raw(conn, "Nowy tom", author_id=a, isbn="9788375780635")
    report = csvio.import_csv(conn, "Tytuł;Seria;Notatki\nNowy tom;Felix, Net i Nika;x")
    assert report["updated"] == 1 and report["added"] == 0
    assert {r["id"]: r["notes"] for r in all_books(conn)} == {loose: "x", with_author: ""}
    with db.transaction(conn):
        conn.execute("DELETE FROM book WHERE id = ?", (loose,))
    report = csvio.import_csv(conn, "Tytuł;Seria;ISBN\nNowy tom;Felix, Net i Nika;9788310128546")
    assert report["added"] == 1
    report = csvio.import_csv(conn, "Tytuł;Seria;ISBN;Notatki\nNowy tom;Felix, Net i Nika;9788375780635;y")
    assert report["updated"] == 1
    assert next(r for r in all_books(conn) if r["id"] == with_author)["notes"] == "y"


# --- ISBN jako tożsamość książki (tylko poprawne numery) ---


def test_import_invalid_isbn_text_is_not_an_identity(conn):
    # Arkusz zapisał 13-cyfrowe numery w notacji naukowej – różne książki mają ten sam tekst.
    text = ("Tytuł;Autor;Seria;Tom;Status;ISBN;Wydawnictwo;Rok wydania;Liczba stron;Notatki\r\n"
            "Ostatnie życzenie;Andrzej Sapkowski;Wiedźmin;1;Mam;9,78838E+12;SuperNOWA;2014;330;\r\n"
            "Miecz przeznaczenia;Andrzej Sapkowski;Wiedźmin;2;Mam;9,78838E+12;SuperNOWA;2014;;od babci\r\n"
            "Solaris;Stanisław Lem;;;Mam;9,78838E+12;Wydawnictwo Literackie;2012;;\r\n"
            "Lalka;Bolesław Prus;;;Mam;9,78837E+12;Greg;;;\r\n")
    report = csvio.import_csv(conn, text)
    assert report == {"added": 4, "updated": 0, "skipped": 0, "errors": [], "errorCount": 0}
    rows = {r["title"]: r for r in all_books(conn)}
    assert set(rows) == {"Ostatnie życzenie", "Miecz przeznaczenia", "Solaris", "Lalka"}
    assert rows["Miecz przeznaczenia"]["notes"] == "od babci" and rows["Ostatnie życzenie"]["notes"] == ""
    assert rows["Solaris"]["isbn"] == "9,78838E+12"  # zapisany tekst się nie zmienia
    # Ponowny import niczego nie dubluje (dopasowanie po tytule i autorze).
    assert csvio.import_csv(conn, text)["skipped"] == 4
    assert len(all_books(conn)) == 4


def test_import_roundtrip_keeps_books_with_the_same_invalid_isbn(lib, conn):
    raw(conn, "Lalka", author_id=lib.find_or_create_author("Bolesław Prus"), isbn="brak")
    raw(conn, "Solaris", author_id=lib.find_or_create_author("Stanisław Lem"), isbn="brak", notes="moja")
    other = db.open_db(":memory:")
    report = csvio.import_csv(other, csvio.export_csv(conn))
    assert report["added"] == 2 and report["updated"] == 0
    rows = {r["title"]: r for r in all_books(other)}
    assert (rows["Lalka"]["notes"], rows["Solaris"]["notes"]) == ("", "moja")
    assert rows["Lalka"]["isbn"] == rows["Solaris"]["isbn"] == "brak"
    other.close()


def test_import_invalid_isbn_text_still_matches_by_title_and_author(lib, conn):
    lib.save_book({"title": "Ostatnie życzenie", "authorName": "Andrzej Sapkowski", "isbn": "9788375780635"})
    text = "Tytuł;Autor;ISBN;Wydawnictwo\nOstatnie życzenie;Andrzej Sapkowski;9,78838E+12;SuperNOWA"
    report = csvio.import_csv(conn, text)
    assert report == {"added": 0, "updated": 1, "skipped": 0, "errors": [], "errorCount": 0}
    [row] = all_books(conn)
    assert (row["isbn"], row["publisher"]) == ("9788375780635", "SuperNOWA")


def test_import_matches_stored_isbn_text_by_number(lib, conn):
    # Numer zapisany z kreskami (np. starsze dane) to ten sam ISBN co 13 cyfr w pliku.
    raw(conn, "Krew elfów", isbn="978-83-7578-063-5")
    report = csvio.import_csv(conn, "Tytuł;ISBN;Notatki\nInny tytuł;9788375780635;z CSV")
    assert report["updated"] == 1 and report["added"] == 0
    [row] = all_books(conn)
    assert (row["title"], row["isbn"], row["notes"]) == ("Krew elfów", "978-83-7578-063-5", "z CSV")


# --- Długie pola i numery wierszy ---


def test_field_size_limit_allows_long_notes():
    assert csv.field_size_limit() == 32 * 1024 * 1024


def test_import_roundtrip_of_very_long_notes(lib, conn):
    notes = ("Długa notatka.\nlinia „cytat” \"x\"\n" * 8000) + "Koniec"
    assert len(notes) > 131072  # domyślny limit pola modułu csv
    raw(conn, "Książka z notatką", author_id=lib.find_or_create_author("Jan Kowalski"), notes=notes)
    raw(conn, "Druga książka", author_id=lib.find_or_create_author("Anna Nowak"))
    other = db.open_db(":memory:")
    report = csvio.import_csv(other, csvio.export_csv(conn))
    assert report == {"added": 2, "updated": 0, "skipped": 0, "errors": [], "errorCount": 0}
    rows = {r["title"]: r for r in all_books(other)}
    assert set(rows) == {"Książka z notatką", "Druga książka"}
    assert rows["Książka z notatką"]["notes"] == notes
    other.close()


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_import_row_numbers_are_spreadsheet_rows(conn, newline):
    # Wiersz = numer rekordu w arkuszu (nagłówek to 1), także po notatkach z kilkoma liniami i po pustym wierszu.
    nl = newline
    text = ("\ufeffTytuł;Autor;Rok wydania;Notatki" + nl
            + f'Probna A;Jan;3000;"linia 1{nl}linia 2{nl}linia 3"' + nl
            + nl
            + "Probna B;Jan;3001;" + nl
            + f';Jan;;"bez{nl}tytułu"' + nl
            + "Probna C;Jan;3002;")
    report = csvio.import_csv(conn, text)
    assert report["errors"] == [
        "Wiersz 2: pominięto niepoprawny rok wydania „3000”.",
        "Wiersz 4: pominięto niepoprawny rok wydania „3001”.",
        "Wiersz 5: brak tytułu – pominięto.",
        "Wiersz 6: pominięto niepoprawny rok wydania „3002”.",
    ]
    assert report["added"] == 3 and report["skipped"] == 1


@pytest.fixture
def small_field_limit():
    old = csv.field_size_limit(1000)
    yield
    csv.field_size_limit(old)


def test_import_unreadable_record_uses_spreadsheet_row(conn, small_field_limit):
    text = ("Tytuł;Autor;Rok wydania;Notatki\n"
            'Probna A;Jan;;"linia 1\nlinia 2\nlinia 3"\n'
            + "X" * 2000 + ";Jan;;\n"
            "Probna B;Jan;3000;")
    report = csvio.import_csv(conn, text)
    assert report["errors"] == [
        "Wiersz 3: nie udało się odczytać – pominięto.",
        "Wiersz 4: pominięto niepoprawny rok wydania „3000”.",
    ]
    assert report["skipped"] == 1 and report["added"] == 2


# --- Autorzy i serie z pamięci podręcznej importu (jak Library._find_or_create_author/_series) ---


def _seed_series_cases(conn):
    """Serie bez autora (pusta i wspólna), serie o tej samej nazwie u różnych autorów
    i książki do uzupełnienia."""
    with db.transaction(conn):
        def author(name):
            return conn.execute("INSERT INTO author(name, created_at) VALUES (?, 'x')", (name,)).lastrowid

        def series(name, author_id):
            return conn.execute(
                "INSERT INTO series(name, planned_volume_count, notes, created_at, author_id)"
                " VALUES (?, NULL, '', 'x', ?)",
                (name, author_id),
            ).lastrowid

        def book(title, author_id, series_id, isbn=None):
            conn.execute(
                "INSERT INTO book(title, is_owned, added_at, author_id, series_id, isbn) VALUES (?, 1, 'x', ?, ?, ?)",
                (title, author_id, series_id, isbn),
            )

        kosik, nowak, kowalski = author("Rafał Kosik"), author("Anna Nowak"), author("Jan Kowalski")
        ids = {
            "kosik": kosik, "nowak": nowak, "kowalski": kowalski,
            "felix": series("Felix, Net i Nika", None),  # bez autora, pusta → przejmie ją pierwszy autor
            "antologia": series("Antologia", None),  # wspólna: książki dwóch autorów
            "kroniki_nowak": series("Kroniki", nowak),
            "kroniki_bez": series("kroniki", None),
            "saga_bez": series("Saga", None),
            "saga_kosik": series("SAGA", kosik),
        }
        book("Opowiadanie 1", kosik, ids["antologia"])
        book("Opowiadanie 2", nowak, ids["antologia"])
        book("Stara", nowak, None)
        book("Bez autora", None, None, isbn="9788375780635")
    return ids


_SERIES_CSV = "\n".join([
    "Tytuł;Autor;Seria;Tom;ISBN",
    "Felix 1;Rafał Kosik;Felix, Net i Nika;1",  # przejmuje serię bez autora
    "Felix obcy;Anna Nowak;felix, net i nika;2",  # seria ma już autora → nowa seria Nowak
    "Felix bez autora;;Felix, Net i Nika;3",  # bez autora → pierwsza seria o tej nazwie (Kosika)
    "Opowiadanie 3;Jan Kowalski;Antologia;3",  # wspólna seria – nie zmienia autora
    "Opowiadanie 4;rafał  KOSIK;antologia;4",
    "Kroniki 1;Anna Nowak;Kroniki;1",  # seria tego samego autora
    "Kroniki 2;Rafał Kosik;Kroniki;2",  # seria bez autora o tym kluczu → przejęta
    "Kroniki 3;Jan Kowalski;KRONIKI;3",  # nie ma już serii bez autora → nowa
    "Saga 1;Rafał Kosik;saga;1",  # seria tego autora ma pierwszeństwo przed wcześniejszą bez autora
    "Stara;Anna Nowak;Saga;5",  # istniejąca książka bez serii → przejmuje „Saga” bez autora
    # Istniejąca książka bez autora (ten sam ISBN) → nowy autor i nowa seria.
    "Bez autora;Nowy Autor;Nowa seria;1;9788375780635",
    "Nowa 2;nowy autor;nowa SERIA;2",
])


def _state(conn):
    return (
        [tuple(r) for r in conn.execute("SELECT id, name FROM author ORDER BY id")],
        [tuple(r) for r in conn.execute("SELECT id, name, author_id FROM series ORDER BY id")],
        [tuple(r) for r in conn.execute(
            "SELECT id, title, volume_number, author_id, series_id FROM book ORDER BY id")],
    )


def test_import_series_adoption_and_shared_series(conn):
    ids = _seed_series_cases(conn)
    report = csvio.import_csv(conn, _SERIES_CSV)
    assert report["errorCount"] == 0 and report["added"] == 10 and report["updated"] == 2
    series = {r["id"]: r["author_id"] for r in conn.execute("SELECT id, author_id FROM series")}
    books = {r["title"]: r for r in all_books(conn)}
    assert series[ids["felix"]] == ids["kosik"]
    assert books["Felix 1"]["series_id"] == ids["felix"]
    assert books["Felix obcy"]["series_id"] not in ids.values()
    assert series[books["Felix obcy"]["series_id"]] == ids["nowak"]
    assert (books["Felix bez autora"]["series_id"], books["Felix bez autora"]["author_id"]) == (
        ids["felix"], ids["kosik"])
    assert series[ids["antologia"]] is None
    assert books["Opowiadanie 3"]["series_id"] == books["Opowiadanie 4"]["series_id"] == ids["antologia"]
    assert books["Opowiadanie 4"]["author_id"] == ids["kosik"]
    assert books["Kroniki 1"]["series_id"] == ids["kroniki_nowak"]
    assert books["Kroniki 2"]["series_id"] == ids["kroniki_bez"] and series[ids["kroniki_bez"]] == ids["kosik"]
    assert books["Kroniki 3"]["series_id"] not in ids.values()
    assert series[books["Kroniki 3"]["series_id"]] == ids["kowalski"]
    assert books["Saga 1"]["series_id"] == ids["saga_kosik"]
    assert books["Stara"]["series_id"] == ids["saga_bez"] and series[ids["saga_bez"]] == ids["nowak"]
    assert books["Bez autora"]["author_name"] == "Nowy Autor"
    assert books["Nowa 2"]["author_id"] == books["Bez autora"]["author_id"]
    assert books["Nowa 2"]["series_id"] == books["Bez autora"]["series_id"]


def test_import_cached_lookups_match_library(monkeypatch):
    """Ten sam wynik co dotychczasowa ścieżka przez Library._find_or_create_author/_find_or_create_series."""
    cached = db.open_db(":memory:")
    _seed_series_cases(cached)
    cached_report = csvio.import_csv(cached, _SERIES_CSV)

    monkeypatch.setattr(csvio._Index, "author", lambda self, raw: self.library._find_or_create_author(raw))
    monkeypatch.setattr(csvio._Index, "series",
                        lambda self, raw, author_id: self.library._find_or_create_series(raw, author_id))
    reference = db.open_db(":memory:")
    _seed_series_cases(reference)
    reference_report = csvio.import_csv(reference, _SERIES_CSV)

    assert cached_report == reference_report
    assert _state(cached) == _state(reference)
    cached.close()
    reference.close()


def test_import_does_not_rescan_authors_and_series_per_row(conn):
    def full_scans(rows):
        c = db.open_db(":memory:")
        lines = ["Tytuł;Autor;Seria;Tom"] + [f"T{i};Autor {i % 20};Seria {i % 10};{i % 9 + 1}" for i in range(rows)]
        statements = []
        c.set_trace_callback(statements.append)
        assert csvio.import_csv(c, "\n".join(lines))["added"] == rows
        c.set_trace_callback(None)
        c.close()
        return [q for q in statements if ("FROM author" in q or "FROM series" in q) and "WHERE" not in q]

    assert len(full_scans(200)) == len(full_scans(5))
