"""Testy odmiany polskich rzeczowników (spec logic.md §2.8) – wektory z oryginału Swift."""

import json

import pytest

from conftest import VECTORS_DIR
from biblioteczka import polish

CASES = json.loads((VECTORS_DIR / "polish.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['noun']}-{c['n']}")
def test_vectors(case):
    assert polish.form(case["n"], case["noun"]) == case["form"]
    assert polish.count(case["n"], case["noun"]) == case["count"]


def test_verified_book_sequence():
    expected = {
        0: "książek", 1: "książka", 2: "książki", 3: "książki", 4: "książki", 5: "książek",
        11: "książek", 12: "książek", 13: "książek", 14: "książek", 15: "książek", 21: "książek",
        22: "książki", 24: "książki", 25: "książek", 101: "książek", 102: "książki", 104: "książki",
        105: "książek", 111: "książek", 112: "książek", 122: "książki", 1000: "książek",
    }
    for n, word in expected.items():
        assert polish.form(n, "book") == word, n


def test_all_nouns():
    assert polish.count(1, "series") == "1 seria"
    assert polish.count(3, "series") == "3 serie"
    assert polish.count(5, "series") == "5 serii"
    assert polish.count(1, "volume") == "1 tom"
    assert polish.count(2, "volume") == "2 tomy"
    assert polish.count(0, "volume") == "0 tomów"
    assert polish.count(1, "author") == "1 autor"
    assert polish.count(4, "author") == "4 autorzy"
    assert polish.count(12, "author") == "12 autorów"


def test_negative_numbers_use_many_like_swift():
    assert polish.count(-1, "book") == "-1 książek"
    assert polish.count(-2, "book") == "-2 książek"


def test_unknown_noun():
    with pytest.raises(ValueError):
        polish.form(1, "magazine")
