"""Testy ISBN i rozpoznawania kodów kreskowych (spec logic.md §9) – wektory z oryginału Swift."""

import dataclasses
import json

import pytest

from conftest import VECTORS_DIR
from biblioteczka.isbn import ISBN, check_digit10, check_digit13, classify_barcode

VECTORS = json.loads((VECTORS_DIR / "isbn.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", VECTORS["parse"], ids=lambda c: ascii(c["input"]))
def test_parse_vectors(case):
    isbn = ISBN.parse(case["input"])
    if case["digits"] is None:
        assert isbn is None
    else:
        assert isbn is not None
        assert isbn.digits == case["digits"]
        assert isbn.isbn10 == case["isbn10"]
        assert str(isbn) == case["digits"]


@pytest.mark.parametrize("case", VECTORS["classify"], ids=lambda c: ascii(c["input"]))
def test_classify_vectors(case):
    kind, isbn = classify_barcode(case["input"])
    assert kind == case["kind"]
    if kind == "book":
        assert isbn == ISBN(case["digits"])
    else:
        assert isbn is None


@pytest.mark.parametrize("case", VECTORS["check13"], ids=lambda c: c["in"])
def test_check13_vectors(case):
    assert check_digit13(case["in"]) == case["out"]


@pytest.mark.parametrize("case", VECTORS["check10"], ids=lambda c: c["in"])
def test_check10_vectors(case):
    assert check_digit10(case["in"]) == case["out"]


def test_verified_examples():
    assert check_digit13("978837578063") == "5"
    assert check_digit10("837054061") == "9"
    assert check_digit10("080442957") == "X"
    assert ISBN.parse("0-8044-2957-x").isbn10 == "080442957X"
    assert ISBN.parse("979-10-90636-07-1").isbn10 is None
    assert ISBN.parse(None) is None


def test_barcode_does_not_accept_isbn10():
    assert classify_barcode("8370540619") == ("other", None)
    assert classify_barcode("977") == ("magazine", None)


def test_isbn_value_semantics():
    a = ISBN.parse("83-7054-061-9")
    b = ISBN("9788370540616")
    assert a == b
    assert hash(a) == hash(b)
    assert len({a, b}) == 1
    with pytest.raises(dataclasses.FrozenInstanceError):
        a.digits = "9788375780635"


@pytest.mark.parametrize("bad", ["9788375780636", "978837578063", "9771234567003", "978837578063X", 9788375780635])
def test_constructor_validates(bad):
    with pytest.raises(ValueError):
        ISBN(bad)


@pytest.mark.parametrize("bad", ["12345678901", "1234567890123", "97883757806a", ""])
def test_check_digit13_rejects_bad_input(bad):
    with pytest.raises(ValueError):
        check_digit13(bad)


@pytest.mark.parametrize("bad", ["12345678", "1234567890", "12345678X"])
def test_check_digit10_rejects_bad_input(bad):
    with pytest.raises(ValueError):
        check_digit10(bad)
