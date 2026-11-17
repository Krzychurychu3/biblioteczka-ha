"""Testy parsera Biblioteki Narodowej na prawdziwych odpowiedziach i plikach syntetycznych."""

import json

import pytest

from conftest import FIXTURES_DIR

from biblioteczka.lookup import bn

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


BN = FIXTURES_DIR / "bn"


def parse_file(name, isbn):
    return bn.parse((BN / name).read_bytes(), make_isbn(isbn))


def parse_json(payload, isbn="9788375780635"):
    return bn.parse(json.dumps(payload).encode(), make_isbn(isbn))


def record(*fields, year=None):
    return {"publicationYear": year, "marc": {"fields": list(fields)}}


def fld(tag, *subfields):
    return {tag: {"ind1": " ", "ind2": " ", "subfields": [dict([s]) for s in subfields]}}


ISBN_FIELD = fld("020", ("a", "9788375780635"))


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
    )


# Prawdziwe odpowiedzi data.bn.org.pl (13 = zapytanie o ISBN-13, 10 = o ISBN-10).
REAL = [
    (
        "9788375780635.json",
        "9788375780635",
        ("Ostatnie życzenie", "Andrzej Sapkowski", "Wiedźmin", True, None, "SuperNOWA", 2014, 330),
    ),
    (
        "9788380083738.json",
        "9788380083738",
        ("Harry Potter i więzień Azkabanu", "J. K. Rowling", None, False, None, "Media Rodzina", 2017, 325),
    ),
    (
        "9788372780140.isbn10-8372780145.json",
        "9788372780140",
        ("Harry Potter i więzień Azkabanu", "J. K. Rowling", None, False, None, "Media Rodzina", 2001, 458),
    ),
    (
        "9788310139658.json",
        "9788310139658",
        (
            "Pucio zostaje kucharzem, czyli O radości z jedzenia",
            "Marta Galewska-Kustra",
            "Uczę się z Puciem",
            False,
            None,
            "Nasza Księgarnia",
            2023,
            30,
        ),
    ),
    (
        "9788308060254.json",
        "9788308060254",
        ("Krzyżacy", "Henryk Sienkiewicz", "Wielka kolekcja", True, 11, "Wydawnictwo Literackie", 2016, 367),
    ),
    (
        "9788308060162.json",
        "9788308060162",
        ("Ogniem i mieczem", "Henryk Sienkiewicz", "Wielka kolekcja", True, 2, "Wydawnictwo Literackie", 2015, 415),
    ),
    (
        "9788386530144.isbn10-8386530146.json",
        "9788386530144",
        ("Dziady", "Adam Mickiewicz", None, False, None, "Zysk i S-ka. Wydaw", 1994, 220),
    ),
    (
        "9788385841081.isbn10-8385841083.json",
        "9788385841081",
        # Poprawka §9.6: polska nazwa z 490 $a zamiast norweskiej „Sagaen om Isfolket” z 800 $t.
        ("Zęby smoka", "Margit Sandemo", "Saga o ludziach lodu", True, 19, "„Pol-Nordica”", 1993, 255),
    ),
    (
        "9788382400076.json",
        "9788382400076",
        # Poprawka §9.6: „Tomek Łebski” (490), a nie angielskie „Tom Gates” (800).
        (
            "Tomek Łebski ma (chrapkę na) smakołyki",
            "Liz Pichon",
            "Tomek Łebski",
            True,
            6,
            "Zielona Sowa",
            2021,
            221,
        ),
    ),
    (
        "9788372788313.json",
        "9788372788313",
        ("Kicia Kocia nie może zasnąć", "Anita Głowińska", None, False, None, "Media Rodzina", 2013, 24),
    ),
    (
        "9788328721166.json",
        "9788328721166",
        ("Tomek na Czarnym Lądzie", "Alfred Szklarski", None, False, None, "Muza", 2021, 317),
    ),
]


@pytest.mark.parametrize(("name", "isbn", "expected"), REAL, ids=[r[0] for r in REAL])
def test_real_responses(name, isbn, expected):
    info = parse_file(name, isbn)
    assert info is not None
    assert summary(info) == expected
    assert info.sources == ["Biblioteka Narodowa"]
    assert info.cover is None


@pytest.mark.parametrize(
    "name",
    [
        "9788375780635.isbn10-8375780634.json",
        "9788372780140.json",
        "9781593279509.json",
        "9788399999990.json",
        "9788399999990.isbn10-8399999997.json",
    ],
)
def test_empty_answers_give_none(name):
    assert parse_file(name, name[:13]) is None


def test_translations_that_only_mention_the_isbn_are_skipped():
    # Ukraińskie przekłady mają ten numer tylko w 020 $z „(oryginał)” – bierzemy rekord 1.
    payload = json.loads((BN / "9788375780635.json").read_bytes())
    payload["bibs"] = payload["bibs"][1:]
    assert parse_json(payload) is None


def test_isbn10_match_ignores_qualifier_glued_into_subfield_a():
    payload = json.loads((BN / "9788372780140.isbn10-8372780145.json").read_bytes())
    second = payload["bibs"][1:]  # rekord z „8372780145 (oprawa miękka)” w $a
    info = parse_json({"bibs": second}, "9788372780140")
    assert summary(info) == (
        "Harry Potter i więzień Azkabanu",
        "J. K. Rowling",
        "Harry Potter",
        True,
        3,
        "Media Rodzina",
        2001,
        458,
    )


def test_spec_example_one():
    info = parse_file("synthetic-verified-1.json", "9788375780635")
    assert summary(info) == ("Ostatnie życzenie", "Andrzej Sapkowski", "Wiedźmin", True, 1, "„SuperNOWA”", 2014, 330)


def test_spec_example_two():
    info = parse_file("synthetic-verified-2.json", "9788375780635")
    # Rok z publicationYear wygrywa; 260 bez $b jest pomijane; zakres tomów → brak numeru.
    assert summary(info) == ("Bez tytułu", "Anna Kowalska", "Seria z Kotem", False, None, "Znak", 2019, None)


def test_decomposed_unicode_is_normalised_before_parsing():
    info = parse_file("synthetic-decomposed.json", "9788375780635")
    assert info.title == "Zażółć gęślą jaźń"
    # „Ć.” po złożeniu jest inicjałem, więc kropka zostaje.
    assert info.author_name == "Ć. Żółkiewski"
    assert info.publisher == "„Świat Książki”"
    assert info.series_name == "Myśli"
    assert info.is_series_certain is False
    assert info.volume_number == 5
    assert info.page_count == 42
    assert info.year == 2010


def test_malformed_json_gives_none():
    assert parse_file("synthetic-malformed.json", "9788375780635") is None
    assert bn.parse(b"", make_isbn("9788375780635")) is None
    assert bn.parse(b"\xff\xfe", make_isbn("9788375780635")) is None


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"bibs": None},
        {"bibs": [{"publicationYear": 2014, "marc": {"fields": [ISBN_FIELD, fld("245", ("a", "T"))]}}]},
        {"bibs": [{"publicationYear": "2014"}]},
        {"bibs": [{"marc": {}}]},
        {"bibs": [record(ISBN_FIELD, {}, fld("245", ("a", "T")))]},  # puste pole MARC
        {"bibs": [record(ISBN_FIELD, "245", fld("245", ("a", "T")))]},  # pole nie jest obiektem
        [],
    ],
)
def test_structure_errors_fail_the_whole_response(payload):
    assert parse_json(payload) is None


def test_record_without_title_gives_none_and_does_not_try_next_record():
    payload = {
        "bibs": [
            record(ISBN_FIELD, fld("245", ("a", " / "))),
            record(ISBN_FIELD, fld("245", ("a", "Drugi rekord"))),
        ]
    }
    assert parse_json(payload) is None
    assert parse_json({"bibs": [record(ISBN_FIELD, fld("245", ("b", "Bez $a")))]}) is None


def test_control_fields_and_bad_subfields_are_tolerated():
    payload = {
        "bibs": [
            record(
                {"001": "b0000"},
                ISBN_FIELD,
                fld("245", ("a", "Tytuł /")),
                # Podpole z wartością liczbową unieważnia wszystkie podpola tego pola.
                {"100": {"subfields": [{"a": "Kowalski, Jan"}, {"d": 1950}]}},
                {"300": {"subfields": "nie lista"}},
            )
        ]
    }
    info = parse_json(payload)
    assert info.title == "Tytuł"
    assert info.author_name is None
    assert info.page_count is None


def test_subfields_inside_one_object_are_ordered_by_code():
    payload = {"bibs": [record(ISBN_FIELD, {"245": {"subfields": [{"c": "Autor /", "a": "Tytuł /"}]}})]}
    assert parse_json(payload).title == "Tytuł"


def test_coauthor_from_700_with_author_role():
    payload = {
        "bibs": [
            record(
                ISBN_FIELD,
                fld("245", ("a", "T")),
                fld("700", ("a", "Kłos, Joanna"), ("e", "Ilustracje")),
                fld("700", ("a", "Nowak, Ewa"), ("e", "Tłumaczenie"), ("e", "AUTOR adaptacji")),
                fld("700", ("a", "Inny, Autor"), ("e", "Autor")),
            )
        ]
    }
    assert parse_json(payload).author_name == "Ewa Nowak"


def test_empty_main_author_counts_as_missing():
    # Poprawka §9.5: „,” w 100 $a dawało w iOS pusty tekst, który blokował inne źródła.
    payload = {"bibs": [record(ISBN_FIELD, fld("245", ("a", "T")), fld("100", ("a", ",")))]}
    assert parse_json(payload).author_name is None


def test_series_from_800_when_490_has_no_name():
    payload = {
        "bibs": [
            record(
                ISBN_FIELD,
                fld("245", ("a", "T")),
                fld("490", ("v", "t. 4")),
                fld("800", ("a", "X"), ("t", "Cykl ;")),
                fld("490", ("a", "Drugi 490 jest pomijany")),
            )
        ]
    }
    info = parse_json(payload)
    assert (info.series_name, info.is_series_certain, info.volume_number) == ("Cykl", True, 4)


def test_series_volume_falls_back_to_800_v():
    payload = {
        "bibs": [
            record(
                ISBN_FIELD,
                fld("245", ("a", "T")),
                fld("490", ("a", "Seria wydawnicza")),
                fld("800", ("t", "Cykl"), ("v", "t. 7")),
            )
        ]
    }
    info = parse_json(payload)
    assert (info.series_name, info.is_series_certain, info.volume_number) == ("Seria wydawnicza", True, 7)


def test_volume_fallback_is_presence_based():
    # Nieparsowalny 490 $v (zakres) nie sięga po 800 $v – jak w iOS.
    payload = {
        "bibs": [
            record(
                ISBN_FIELD,
                fld("245", ("a", "T")),
                fld("490", ("a", "Cykl / Autor"), ("v", "t. 1-8")),
                fld("800", ("t", "Cykl"), ("v", "t. 3")),
            )
        ]
    }
    assert parse_json(payload).volume_number is None


def test_publisher_series_without_author_is_uncertain_and_empty_name_is_dropped():
    payload = {"bibs": [record(ISBN_FIELD, fld("245", ("a", "T")), fld("490", ("a", "Mądra Mysz ;"), ("v", "5")))]}
    info = parse_json(payload)
    assert (info.series_name, info.is_series_certain, info.volume_number) == ("Mądra Mysz", False, 5)

    payload = {"bibs": [record(ISBN_FIELD, fld("245", ("a", "T")), fld("490", ("a", " ; "), ("v", "5")))]}
    info = parse_json(payload)
    # Pusta nazwa → brak serii; numer tomu nie jest czyszczony (jak w iOS).
    assert (info.series_name, info.volume_number) == (None, 5)


def test_imprint_year_is_used_when_publication_year_is_missing_or_unparseable():
    payload = {
        "bibs": [
            record(
                ISBN_FIELD,
                fld("245", ("a", "T")),
                fld("264", ("a", "Kraków :"), ("c", "2000")),  # bez $b – pomijane
                fld("260", ("b", "Znak,"), ("c", "cop. 1999")),
                year="b.r.",
            )
        ]
    }
    info = parse_json(payload)
    assert (info.publisher, info.year) == ("Znak", 1999)


def test_numbers_are_clamped():
    payload = {"bibs": [record(ISBN_FIELD, fld("245", ("a", "T")), fld("300", ("a", "12000 s.")), year="1600")]}
    info = parse_json(payload)
    assert info.page_count is None
    assert info.year == 1600
