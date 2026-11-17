"""Testy kluczy tekstowych (spec logic.md §2) – wspólne wektory z oryginału Swift + reguły brzegowe."""

import json
import unicodedata

import pytest

from conftest import VECTORS_DIR
from biblioteczka import textmatch as tm

VECTORS = json.loads((VECTORS_DIR / "textmatch.json").read_text(encoding="utf-8"))
STRING_CASES = VECTORS["strings"]
RANK_CASES = VECTORS["matchRank"]

C = chr


def _id(case):
    return ascii(case.get("input", case.get("text")))[:40]


@pytest.mark.parametrize("case", STRING_CASES, ids=_id)
def test_string_vectors(case):
    s = case["input"]
    assert tm.cleaned_name(s) == case["cleanedName"]
    assert tm.name_key(s) == case["nameKey"]
    assert tm.search_key(s) == case["searchKey"]
    assert tm.loose_key(s) == case["looseKey"]
    assert tm.words_key(s) == case["wordsKey"]
    assert tm.nil_if_empty(s) == case["nilIfEmpty"]


@pytest.mark.parametrize("case", RANK_CASES, ids=lambda c: ascii((c["text"], c["query"]))[:50])
def test_match_rank_vectors(case):
    assert tm.match_rank(case["text"], case["query"]) == case["rank"]
    assert tm.matches(case["text"], case["query"]) is (case["rank"] is not None)


def test_vectors_cover_every_verified_example():
    inputs = {c["input"] for c in STRING_CASES}
    assert set(VECTORS["verifiedStrings"]) <= inputs
    pairs = {(c["text"], c["query"]) for c in RANK_CASES}
    assert {tuple(p) for p in VECTORS["verifiedPairs"]} <= pairs


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Wiedźmin", "wiedzmin"),
        ("  ŁÓDŹ   żółć ", "lodz zolc"),
        ("ĄĆĘŁŃÓŚŹŻ ąćęłńóśźż", "acelnoszz acelnoszz"),
        ("Pucio. Mówi!", "pucio. mowi!"),
        ("J.K. Rowling", "j.k. rowling"),
        ("Gęś", "ges"),
        ("Straße", "strasse"),
        ("ＡＢＣ１", "abc1"),
        ("ﬁlm", "film"),
        ("Æsop Œuvre ø", "æsop œuvre ø"),
        ("x²", "x²"),
        ("Ⅻ", "ⅻ"),
    ],
)
def test_search_key_spec_examples(text, expected):
    assert tm.search_key(text) == expected


def test_name_key_keeps_diacritics_and_sharp_s():
    assert tm.name_key("Wiedźmin") == "wiedźmin"
    assert tm.name_key("  ŁÓDŹ   żółć ") == "łódź żółć"
    assert tm.name_key("J.K. Rowling") == "j.k. rowling"
    assert tm.name_key("Straße") == "straße"


def test_name_key_lowercases_per_character_like_swift():
    # Swift `lowercased()` nie stosuje kontekstowej końcowej sigmy (Python `lower()` by ją zastosował).
    assert tm.name_key("ΟΔΟΣ") == "οδο" + C(0x3C3)


def test_loose_and_words_keys():
    assert tm.loose_key("J.K. Rowling") == tm.loose_key("J. K. Rowling") == "jkrowling"
    assert tm.loose_key("Felix, Net i Nika") == "felixnetinika"
    assert tm.loose_key("Tom 3–4") == "tom34"
    assert tm.loose_key("Ursula K. Le Guin") == "ursulakleguin"
    assert tm.words_key("Pucio. Mówi!") == "pucio mowi"
    assert tm.words_key("J.K. Rowling") == "j k rowling"
    assert tm.words_key("Tom 3–4") == "tom 3 4"
    assert tm.words_key("Felix, Net i Nika") == "felix net i nika"


def test_swift_letters_include_other_alphabetic_symbols():
    # „ⓐ” (U+24D0) ma właściwość Alphabetic, więc Swift `isLetter` go zostawia.
    assert tm.loose_key("ⓐ-1") == "ⓐ1"


@pytest.mark.parametrize("cp", [0x1C, 0x1D, 0x1E, 0x1F])
def test_information_separators_are_not_whitespace(cp):
    # Uwaga krytyka: Python str.split()/strip() traktują U+001C–U+001F jako białe znaki, Swift nie.
    s = "a" + C(cp) + "b"
    assert tm.cleaned_name(s) == s
    assert tm.cleaned_name(" " + s + " ") == s
    assert tm.words_key(s) == "a b"


@pytest.mark.parametrize("cp", [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0xA0, 0x1680, 0x2002, 0x200A, 0x2028, 0x2029,
                                0x202F, 0x205F, 0x3000])
def test_unicode_whitespace_is_collapsed(cp):
    assert tm.cleaned_name(C(cp) + "a" + C(cp) + C(cp) + "b" + C(cp)) == "a b"


def test_zero_width_space_is_not_whitespace():
    s = "a" + C(0x200B) + "b"
    assert tm.cleaned_name(s) == s


def test_space_with_combining_mark_disappears_as_one_grapheme():
    assert tm.cleaned_name("a " + C(0x301) + "b") == "a b"
    # Po znaku nowej linii akcent zaczyna osobny grafem – zostaje.
    assert tm.cleaned_name("a\n" + C(0x301) + "b") == "a " + C(0x301) + "b"


def test_decomposed_input_matches_composed():
    decomposed = unicodedata.normalize("NFD", "Ostatnie życzenie")
    assert decomposed != "Ostatnie życzenie"
    assert tm.cleaned_name(decomposed) == "Ostatnie życzenie"
    assert tm.name_key(decomposed) == tm.name_key("Ostatnie życzenie")
    assert tm.search_key(decomposed) == "ostatnie zyczenie"
    assert tm.match_rank(decomposed, "ŻYCZ") == 1


def test_nil_if_empty_does_not_trim():
    assert tm.nil_if_empty("") is None
    assert tm.nil_if_empty(None) is None
    assert tm.nil_if_empty(" ") == " "


def test_nfc():
    assert tm.nfc(None) is None
    assert tm.nfc("z" + C(0x307)) == "ż"


def test_match_rank_rules():
    assert tm.match_rank("Harry Potter", "") == 2
    assert tm.match_rank("", "a") is None
    assert tm.match_rank("Pan Tadeusz", "pan t") == 0
    assert tm.match_rank("J.K. Rowling", "k. row") == 2
    assert tm.matches("Łódź", "lodz")
    assert not tm.matches("Harry Potter", "xyz")


def test_match_rank_compares_whole_graphemes():
    # Swift `hasPrefix`/`contains` działają na grafemach: „कि” nie zaczyna się od „क”.
    assert tm.match_rank("कि", "क") is None
    assert tm.match_rank("Książka 👍🏽", "👍") is None
    assert tm.match_rank("Książka 👍", "👍") == 1


def test_clusters():
    assert tm.clusters("") == []
    assert tm.clusters("ab") == ["a", "b"]
    assert tm.clusters("e" + C(0x301) + "x") == ["e" + C(0x301), "x"]
    assert tm.clusters("\r\n") == ["\r\n"]
    assert tm.clusters("\n" + C(0x301)) == ["\n", C(0x301)]
    assert tm.clusters("🇵🇱🇩🇪") == ["🇵🇱", "🇩🇪"]
    assert tm.clusters(C(0x1100) + C(0x1161) + C(0x11A8)) == [C(0x1100) + C(0x1161) + C(0x11A8)]
