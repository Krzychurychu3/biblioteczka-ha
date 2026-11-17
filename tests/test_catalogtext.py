"""Testy porządkowania tekstów katalogowych (spec logic.md §10.9 – zweryfikowane przykłady)."""

import pytest

from biblioteczka.lookup import catalogtext as ct


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Ostatnie życzenie /", "Ostatnie życzenie"),
        ("Tytuł :", "Tytuł"),
        ("Kraków ;", "Kraków"),
        ("  x , ", "x"),
        ("Dzieci z Bullerbyn =", "Dzieci z Bullerbyn"),
        ("Abc.", "Abc"),
        ("Tom 1.", "Tom 1"),
        ("Pucio. Mówi.", "Pucio. Mówi"),
        ("Opowieść. ", "Opowieść"),
        ("a,b,", "a,b"),
        ("J. K.", "J. K."),
        ("Rowling, J. K.", "Rowling, J. K."),
        ("A.", "A."),
        ("Ab C.", "Ab C."),
        ("Ab c.", "Ab c."),
        ("Ab Ć.", "Ab Ć."),
        ("X. Y. Z.", "X. Y. Z."),
        ("Tytuł...", "Tytuł..."),
        ("Książka ...", "Książka ..."),
        ("Uwaga!", "Uwaga!"),
        ("... .", "..."),
        ("[Tytuł]", "Tytuł"),
        ("[Tytuł] :", "Tytuł"),
        ("[Wiedźmin] /", "Wiedźmin"),
        ("Seria [2].", "Seria [2]"),
        ("[  ]", ""),
        ("[A] i [B]", "A] i [B"),  # znane dziwactwo iOS
        ("\n Tytuł /\n", "Tytuł"),
        ("", ""),
        (" / ", ""),
    ],
)
def test_trimmed(raw, expected):
    assert ct.trimmed(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Sapkowski, Andrzej", "Andrzej Sapkowski"),
        ("Rowling, J. K.", "J. K. Rowling"),
        ("Le Guin, Ursula K.", "Ursula K. Le Guin"),
        ("Kowalski , Jan .", "Jan Kowalski"),
        ("Homer", "Homer"),
        ("Kowalski,", "Kowalski"),
        (", Jan", ", Jan"),
        ("Sapkowski, Andrzej (1948- ).", "Andrzej (1948- ) Sapkowski"),
        ("Sapkowski, Andrzej, 1948-", "Andrzej, 1948- Sapkowski"),
        ("Rowling, J. K", "J. K Rowling"),
        # Swiftowe split pomija puste kawałki: przecinek na początku nie liczy się jako podział.
        (",Nowak,Anna", "Anna Nowak"),
        ("Anita Głowińska", "Anita Głowińska"),
    ],
)
def test_person_name(raw, expected):
    assert ct.person_name(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Wiedźmin / Andrzej Sapkowski ;", "Wiedźmin"),
        ("Seria ; t. 2", "Seria"),
        ("A / B ; C", "A"),
        ("Kot / pies / mysz", "Kot"),
        ("Mądra Mysz ;", "Mądra Mysz"),
        ("Seria/bez spacji", "Seria/bez spacji"),
        ("Wielka kolekcja ;", "Wielka kolekcja"),
        ("Pucio / seria ; 2", "Pucio"),
    ],
)
def test_series_name(raw, expected):
    assert ct.series_name(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"Nasza Księgarnia",', "„Nasza Księgarnia”"),
        ('Wydawnictwo "Znak" :', "Wydawnictwo „Znak”"),
        ('"A" i "B"', "„A” i „B”"),
        ("©Media Rodzina", "Media Rodzina"),
        ("© 2015 Egmont ;", "2015 Egmont"),
        ("[Wydawnictwo Dwie Siostry]", "Wydawnictwo Dwie Siostry"),
        ("Egmont Polska,", "Egmont Polska"),
        ('"Nasza Księgarnia', "„Nasza Księgarnia"),
        ("©", ""),
        ("Zysk i S-ka. Wydaw.,", "Zysk i S-ka. Wydaw"),
    ],
)
def test_publisher(raw, expected):
    assert ct.publisher(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("t. 18", 18),
        ("[1]", 1),
        ("Bd. 3", 3),
        ("t. II", 2),
        ("t.3", 3),
        ("t.12,", 12),
        ("t. 05", 5),
        ("t. 999", 999),
        ("+3", 3),
        ("1.", 1),
        ("No. 7", 7),
        ("Seria 2", 2),
        ("tom 3, cz. 2", 3),
        ("[t. 4]", 4),
        ("IV", 4),
        ("Vol. XIV", 14),
        ("Część I", 1),
        ("Księga V. Pani", 5),
        ("LXX", 70),
        ("t. 1-8", None),
        ("t. 1 - 8", None),
        ("t. 1–8", None),
        ("t. 3-4", None),
        ("t. II-III", None),
        ("cz. 0", None),
        ("t. 1000", None),
        ("t. -2", None),
        ("nr 12a", None),
        ("2a", None),
        ("t. 1/2", None),
        ("tom pierwszy", None),
        ("vi", None),
        ("MMX", None),
        ("t. IIIIIII", None),
        ("IL", 49),
        ("VX", 5),
        ("IIV", 5),
        ("LLLLLL", 300),
        ("t. IIII", 4),
        ("Harry-Potter 3", None),
        ("t. 1 — 8", 1),  # pauza (—) nie oznacza zakresu
        ("t. 7", 7),  # twarda spacja to też biały znak
        ("t. ٣", None),  # tylko cyfry ASCII
        ("3_0", None),
        ("", None),
        # Liczba poza zakresem Int64 nie jest w Swifcie liczbą – decyduje kolejny token.
        ("99999999999999999999 4", 4),
    ],
)
def test_volume_number(raw, expected):
    assert ct.volume_number(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("330, [6] stron ;", 330),
        ("330, [6] s.", 330),
        ("157, [3] s.", 157),
        ("[42] strony :", 42),
        ("1 tom (286 s.)", 286),
        ("286 s. :", 286),
        ("[32] s. : il. kolor. ; 24 cm", 32),
        ("123 pages", 123),
        ("200 p.", 200),
        ("XII, 300 s.", 300),
        ("48 k.", 48),
        ("24 karty", 24),
        ("[24] k. ; 30 cm", 24),
        ("300 str.", 300),
        ("350stron", 350),
        ("96 S.", 96),
        ("100 s", 100),
        ("2 v. 300 p.", 300),
        ("367 stron;", 367),
        ("458, [1] strona :", 458),
        ("10 cm", None),
        ("0 s.", None),
        ("s. 30", None),
        ("1 tom (nienumerowane) ; 20 cm", None),
        ("12 sztuk", None),
        ("5 tomów", None),
        ("", None),
    ],
)
def test_page_count(raw, expected):
    assert ct.page_count(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("copyright 2014.", 2014),
        ("[2015]", 2015),
        ("cop. 1999", 1999),
        ("2014-2015", 2014),
        ("druk 2009, cop. 2008", 2009),
        ("ok. 1850", 1850),
        ("1500", 1500),
        ("rok 2099", 2099),
        ("May 2, 2010", 2010),
        ("c2020", None),
        ("1999r.", None),
        ("1499", None),
        ("2100", None),
        ("20145", None),
        ("MMXIV", None),
        ("", None),
    ],
)
def test_year(raw, expected):
    assert ct.year(raw) == expected


def test_swift_int():
    assert ct.swift_int("+3") == 3
    assert ct.swift_int("-2") == -2
    assert ct.swift_int("007") == 7
    assert ct.swift_int("3a") is None
    assert ct.swift_int("٣") is None
    assert ct.swift_int(" 3") is None
    assert ct.swift_int("9223372036854775807") == 2**63 - 1
    assert ct.swift_int("9223372036854775808") is None


@pytest.mark.parametrize(
    ("function", "value", "expected"),
    [
        (ct.clamp_volume, 1, 1),
        (ct.clamp_volume, 999, 999),
        (ct.clamp_volume, 0, None),
        (ct.clamp_volume, 1000, None),
        (ct.clamp_year, 1000, 1000),
        (ct.clamp_year, 2100, 2100),
        (ct.clamp_year, 999, None),
        (ct.clamp_year, 2101, None),
        (ct.clamp_pages, 1, 1),
        (ct.clamp_pages, 9999, 9999),
        (ct.clamp_pages, 12000, None),
        (ct.clamp_pages, -5, None),
        (ct.clamp_pages, 0, None),
        (ct.clamp_pages, None, None),
        (ct.clamp_pages, True, None),
    ],
)
def test_clamps(function, value, expected):
    assert function(value) == expected


def test_whitespace_helpers_follow_swift_sets():
    # `.whitespaces` nie obejmuje nowej linii, `.whitespacesAndNewlines` – tak.
    assert ct.strip_whitespace("\t a \n") == "a \n"
    assert ct.strip_whitespace_and_newlines("  a\u0085\r\n") == "a"
    # Separatory U+001C…U+001F nie są białymi znakami w Swifcie (Python `strip()` by je usunął).
    assert ct.strip_whitespace_and_newlines("\x1ca\x1f") == "\x1ca\x1f"
