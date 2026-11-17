"""Testy parsera Open Library na prawdziwych odpowiedziach i plikach syntetycznych."""

import json
import unicodedata

import pytest

from conftest import FIXTURES_DIR

from biblioteczka.lookup import openlibrary

try:
    from biblioteczka.isbn import ISBN

    def make_isbn(text):
        return ISBN.parse(text)

except ImportError:  # moduł isbn pisany równolegle – prywatny dubler na potrzeby testów
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class _IsbnDouble:
        digits: str
        isbn10: object = None

    def make_isbn(text):
        return _IsbnDouble(text)


OL = FIXTURES_DIR / "openlibrary"


def parse_file(name, isbn="9788375780635"):
    return openlibrary.parse((OL / name).read_bytes(), make_isbn(isbn))


def parse_entry(entry):
    return openlibrary.parse(json.dumps({"ISBN:9788375780635": entry}).encode(), make_isbn("9788375780635"))


def summary(info):
    return (info.title, info.author_name, info.series_name, info.publisher, info.year, info.page_count)


REAL = [
    ("9788375780635.json", ("Ostatnie życzenie", "Andrzej Sapkowski", None, "SuperNOWA", 2014, None)),
    ("9788380083738.json", ("Harry Potter i więzień Azkabanu", "J. K. Rowling", None, "Media Rodzina", 2017, 328)),
    ("9788372780140.json", ("Harry Potter i więzień Azkabanu", "J. K. Rowling", None, "Media Rodzina", 2001, None)),
    # Podtytuł nie jest używany (jak w iOS); rok z „Dec 04, 2018”.
    ("9781593279509.json", ("Eloquent JavaScript", "Marijn Haverbeke", None, "No Starch Press", 2018, 472)),
    ("9780140328721.json", ("Fantastic Mr. Fox", "Roald Dahl", None, "Puffin", 1988, 96)),
]


@pytest.mark.parametrize(("name", "expected"), REAL, ids=[r[0] for r in REAL])
def test_real_responses(name, expected):
    info = parse_file(name, name[:13])
    assert info is not None
    assert summary(info) == expected
    assert info.sources == ["Open Library"]
    assert info.is_series_certain is False and info.volume_number is None


def test_real_decomposed_title_is_composed():
    raw = json.loads((OL / "9788375780635.json").read_bytes())["ISBN:9788375780635"]["title"]
    assert not unicodedata.is_normalized("NFC", raw)  # Open Library naprawdę wysyła NFD
    info = parse_file("9788375780635.json")
    assert info.title == "Ostatnie życzenie"
    assert unicodedata.is_normalized("NFC", info.title)


@pytest.mark.parametrize(
    "name",
    ["9788310139658.json", "9788308060254.json", "9788399999990.json", "9788328721166.json"],
)
def test_empty_object_is_not_found(name):
    assert parse_file(name, name[:13]) is None


def test_synthetic_decomposed_and_edition_suffix():
    info = parse_file("synthetic-decomposed.json")
    assert summary(info) == ("Ostatnie życzenie", "Andrzej Sapkowski", None, "Wydawnictwo Łódzkie", 2010, 320)


def test_malformed_and_wrong_types_give_none():
    assert parse_file("synthetic-malformed.json") is None
    assert parse_file("synthetic-wrong-type.json") is None
    assert openlibrary.parse(b"", make_isbn("9788375780635")) is None
    assert openlibrary.parse(b"[]", make_isbn("9788375780635")) is None
    assert openlibrary.parse(b'{"ISBN:1": "x"}', make_isbn("9788375780635")) is None


@pytest.mark.parametrize(
    "entry",
    [
        {},
        {"title": None},
        {"title": 5},
        {"title": "T", "authors": {"name": "x"}},
        {"title": "T", "authors": [{"url": "bez nazwy"}]},
        {"title": "T", "publishers": [{"name": 1}]},
        {"title": "T", "publish_date": 2010},
        {"title": "T", "number_of_pages": True},
        {"title": "T", "number_of_pages": 12.5},
        {"title": " (Polish Edition)"},
    ],
)
def test_entry_decoding_rules(entry):
    assert parse_entry(entry) is None


def test_edition_suffix_is_case_sensitive_and_anchored():
    assert parse_entry({"title": "Pan Tadeusz (Polish Edition)"}).title == "Pan Tadeusz"
    assert parse_entry({"title": "Pan Tadeusz (Polish edition)"}).title == "Pan Tadeusz (Polish edition)"
    assert parse_entry({"title": "X (Polish Edition) – wydanie"}).title == "X (Polish Edition) – wydanie"


def test_empty_values_count_as_missing_and_numbers_are_clamped():
    info = parse_entry(
        {
            "title": "T",
            "authors": [{"name": ""}],
            "publishers": [],
            "number_of_pages": 12000,
            "publish_date": "2100",
        }
    )
    assert (info.author_name, info.publisher, info.page_count, info.year) == (None, None, None, None)
    assert parse_entry({"title": "T", "number_of_pages": -5}).page_count is None
    assert parse_entry({"title": "T", "number_of_pages": 0}).page_count is None
    assert parse_entry({"title": "T", "number_of_pages": 12.0}).page_count == 12


def test_first_entry_is_used():
    payload = {"ISBN:9788375780635": {"title": "Pierwszy"}, "ISBN:8375780634": {"title": "Drugi"}}
    assert openlibrary.parse(json.dumps(payload).encode(), make_isbn("9788375780635")).title == "Pierwszy"


def test_cover_url():
    assert (
        openlibrary.cover_url(make_isbn("9788375780635"))
        == "https://covers.openlibrary.org/b/isbn/9788375780635-L.jpg?default=false"
    )
