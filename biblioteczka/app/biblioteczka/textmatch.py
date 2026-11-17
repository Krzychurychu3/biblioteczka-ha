"""Klucze tekstowe do porównywania i wyszukiwania nazw – port `TextMatching.swift`.

Zachowanie odtworzono zgodnie z kodem Swift (sprawdzone na oryginale dla każdego znaku Unicode):
- Swift działa na grafemach (`Character`), nie na pojedynczych skalarach – stąd `clusters()`;
- `searchKey` używa `folding(...)` z Foundation, które usuwa akcenty tylko w „pełnym” zakresie
  dla alfabetów łacińskiego, greckiego i cyrylicy (baza < U+0510), a w innych pismach jedynie
  znaki łączące z bloków < U+0510;
- `isLetter` w Swift to właściwość Unicode Alphabetic (np. „ⓐ” jest literą).
Bliźniaczy moduł JS: `static/js/core/text.js` (te same reguły, wspólne wektory testowe).
"""

from __future__ import annotations

import bisect
import functools
import unicodedata

# Białe znaki Unicode (White_Space) – jak Swift `Character.isWhitespace`.
# Python `str.split()`/`str.strip()` uznają też U+001C–U+001F, Swift nie – stąd własna lista.
_WHITESPACE = frozenset(
    [*range(0x09, 0x0E), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B),
     0x2028, 0x2029, 0x202F, 0x205F, 0x3000]
)

# Znaki Mc, które NIE doklejają się do poprzedniego grafemu (wyjątki od SpacingMark w UAX #29).
_MC_NOT_SPACING = frozenset(
    [0x102B, 0x102C, 0x1038, 0x1062, 0x1063, 0x1064, *range(0x1067, 0x106E), 0x1083,
     *range(0x1087, 0x108D), 0x108F, 0x109A, 0x109B, 0x109C, 0x1A61, 0x1A63, 0x1A64,
     0xAA7B, 0xAA7D, 0x11720, 0x11721]
)

# Znaki Mc z właściwością Grapheme_Extend (stan Unicode 17) – Foundation usuwa je jak znaki diakrytyczne.
_MC_EXTEND = frozenset(
    [0x09BE, 0x09D7, 0x0B3E, 0x0B57, 0x0BBE, 0x0BD7, 0x0CC0, 0x0CC2, 0x0CC7, 0x0CC8,
     0x0CCA, 0x0CCB, 0x0CD5, 0x0CD6, 0x0D3E, 0x0D57, 0x0DCF, 0x0DDF, 0x1715, 0x1734,
     0x1B35, 0x1B3B, 0x1B3D, 0x1B43, 0x1B44, 0x1BAA, 0x1BF2, 0x1BF3, 0x302E, 0x302F,
     0xA953, 0xA9C0, 0x111C0, 0x11235, 0x1133E, 0x1134D, 0x11357, 0x113B8, 0x113C2,
     0x113C5, 0x113C7, 0x113C8, 0x113C9, 0x113CF, 0x114B0, 0x114BD, 0x115AF, 0x116B6,
     0x11930, 0x1193D, 0x11F41, 0x16FF0, 0x16FF1, 0x1D165, 0x1D166, *range(0x1D16D, 0x1D173)]
)

# Znaki, które starsze bazy Unicode (Python 3.10) mają jako Mn, a obecnie są zwykłymi Mc (bez Grapheme_Extend).
_NOW_SPACING_MC = frozenset([0x1171E])

# Znaki spoza kategorii M, które też „rozszerzają” grafem: ZWNJ, półszerokie znaki dźwięczności, tagi.
_OTHER_EXTEND = frozenset([0x200C, 0xFF9E, 0xFF9F, *range(0xE0020, 0xE0080)])

# Pełne składanie wielkości liter (CaseFolding.txt) tam, gdzie Foundation odchodzi od `lower()`:
# ß → ss, ligatury, greckie warianty liter. Cherokee i U+1C80–U+1C88 Foundation zostawia jak `lower()`.
_FOLD_EXCEPTIONS: dict[str, str] = {
    chr(k): "".join(map(chr, v))
    for k, v in {
        0x00B5: (0x03BC,), 0x00DF: (0x0073, 0x0073,), 0x0149: (0x02BC, 0x006E,), 0x017F: (0x0073,),
        0x0345: (0x03B9,), 0x03C2: (0x03C3,), 0x03D0: (0x03B2,), 0x03D1: (0x03B8,), 0x03D5: (0x03C6,),
        0x03D6: (0x03C0,), 0x03F0: (0x03BA,), 0x03F1: (0x03C1,), 0x03F5: (0x03B5,),
        0x0587: (0x0565, 0x0582,), 0x1E9A: (0x0061, 0x02BE,), 0x1E9E: (0x0073, 0x0073,),
        0xFB00: (0x0066, 0x0066,), 0xFB01: (0x0066, 0x0069,), 0xFB02: (0x0066, 0x006C,),
        0xFB03: (0x0066, 0x0066, 0x0069,), 0xFB04: (0x0066, 0x0066, 0x006C,),
        0xFB05: (0x0073, 0x0074,), 0xFB06: (0x0073, 0x0074,), 0xFB13: (0x0574, 0x0576,),
        0xFB14: (0x0574, 0x0565,), 0xFB15: (0x0574, 0x056B,), 0xFB16: (0x057E, 0x0576,),
        0xFB17: (0x0574, 0x056D,),
    }.items()
}

# Znaki z właściwością Alphabetic, które nie są literami (L*) ani liczbami (N*) – pary [od, do].
# Swift `Character.isLetter` uznaje je za litery (np. „ⓐ”, „🅐”, samodzielne znaki samogłoskowe).
_OTHER_ALPHABETIC = (
    0x345, 0x345, 0x363, 0x36F, 0x5B0, 0x5BD, 0x5BF, 0x5BF, 0x5C1, 0x5C2, 0x5C4, 0x5C5, 0x5C7,
    0x5C7, 0x610, 0x61A, 0x64B, 0x657, 0x659, 0x65F, 0x670, 0x670, 0x6D6, 0x6DC, 0x6E1, 0x6E4,
    0x6E7, 0x6E8, 0x6ED, 0x6ED, 0x711, 0x711, 0x730, 0x73F, 0x7A6, 0x7B0, 0x816, 0x817, 0x81B,
    0x823, 0x825, 0x827, 0x829, 0x82C, 0x897, 0x897, 0x8D4, 0x8DF, 0x8E3, 0x8E9, 0x8F0, 0x903,
    0x93A, 0x93B, 0x93E, 0x94C, 0x94E, 0x94F, 0x955, 0x957, 0x962, 0x963, 0x981, 0x983, 0x9BE,
    0x9C4, 0x9C7, 0x9C8, 0x9CB, 0x9CC, 0x9D7, 0x9D7, 0x9E2, 0x9E3, 0xA01, 0xA03, 0xA3E, 0xA42,
    0xA47, 0xA48, 0xA4B, 0xA4C, 0xA51, 0xA51, 0xA70, 0xA71, 0xA75, 0xA75, 0xA81, 0xA83, 0xABE,
    0xAC5, 0xAC7, 0xAC9, 0xACB, 0xACC, 0xAE2, 0xAE3, 0xAFA, 0xAFC, 0xB01, 0xB03, 0xB3E, 0xB44,
    0xB47, 0xB48, 0xB4B, 0xB4C, 0xB56, 0xB57, 0xB62, 0xB63, 0xB82, 0xB82, 0xBBE, 0xBC2, 0xBC6,
    0xBC8, 0xBCA, 0xBCC, 0xBD7, 0xBD7, 0xC00, 0xC04, 0xC3E, 0xC44, 0xC46, 0xC48, 0xC4A, 0xC4C,
    0xC55, 0xC56, 0xC62, 0xC63, 0xC81, 0xC83, 0xCBE, 0xCC4, 0xCC6, 0xCC8, 0xCCA, 0xCCC, 0xCD5,
    0xCD6, 0xCE2, 0xCE3, 0xCF3, 0xCF3, 0xD00, 0xD03, 0xD3E, 0xD44, 0xD46, 0xD48, 0xD4A, 0xD4C,
    0xD57, 0xD57, 0xD62, 0xD63, 0xD81, 0xD83, 0xDCF, 0xDD4, 0xDD6, 0xDD6, 0xDD8, 0xDDF, 0xDF2,
    0xDF3, 0xE31, 0xE31, 0xE34, 0xE3A, 0xE4D, 0xE4D, 0xEB1, 0xEB1, 0xEB4, 0xEB9, 0xEBB, 0xEBC,
    0xECD, 0xECD, 0xF71, 0xF83, 0xF8D, 0xF97, 0xF99, 0xFBC, 0x102B, 0x1036, 0x1038, 0x1038, 0x103B,
    0x103E, 0x1056, 0x1059, 0x105E, 0x1060, 0x1062, 0x1064, 0x1067, 0x106D, 0x1071, 0x1074, 0x1082,
    0x108D, 0x108F, 0x108F, 0x109A, 0x109D, 0x1712, 0x1713, 0x1732, 0x1733, 0x1752, 0x1753, 0x1772,
    0x1773, 0x17B6, 0x17C8, 0x1885, 0x1886, 0x18A9, 0x18A9, 0x1920, 0x192B, 0x1930, 0x1938, 0x1A17,
    0x1A1B, 0x1A55, 0x1A5E, 0x1A61, 0x1A74, 0x1ABF, 0x1AC0, 0x1ACC, 0x1ACE, 0x1B00, 0x1B04, 0x1B35,
    0x1B43, 0x1B80, 0x1B82, 0x1BA1, 0x1BA9, 0x1BAC, 0x1BAD, 0x1BE7, 0x1BF1, 0x1C24, 0x1C36, 0x1DD3,
    0x1DF4, 0x24B6, 0x24E9, 0x2DE0, 0x2DFF, 0xA674, 0xA67B, 0xA69E, 0xA69F, 0xA802, 0xA802, 0xA80B,
    0xA80B, 0xA823, 0xA827, 0xA880, 0xA881, 0xA8B4, 0xA8C3, 0xA8C5, 0xA8C5, 0xA8FF, 0xA8FF, 0xA926,
    0xA92A, 0xA947, 0xA952, 0xA980, 0xA983, 0xA9B4, 0xA9BF, 0xA9E5, 0xA9E5, 0xAA29, 0xAA36, 0xAA43,
    0xAA43, 0xAA4C, 0xAA4D, 0xAA7B, 0xAA7D, 0xAAB0, 0xAAB0, 0xAAB2, 0xAAB4, 0xAAB7, 0xAAB8, 0xAABE,
    0xAABE, 0xAAEB, 0xAAEF, 0xAAF5, 0xAAF5, 0xABE3, 0xABEA, 0xFB1E, 0xFB1E, 0x10376, 0x1037A,
    0x10A01, 0x10A03, 0x10A05, 0x10A06, 0x10A0C, 0x10A0F, 0x10D24, 0x10D27, 0x10D69, 0x10D69,
    0x10EAB, 0x10EAC, 0x10EFA, 0x10EFC, 0x11000, 0x11002, 0x11038, 0x11045, 0x11073, 0x11074,
    0x11080, 0x11082, 0x110B0, 0x110B8, 0x110C2, 0x110C2, 0x11100, 0x11102, 0x11127, 0x11132,
    0x11145, 0x11146, 0x11180, 0x11182, 0x111B3, 0x111BF, 0x111CE, 0x111CF, 0x1122C, 0x11234,
    0x11237, 0x11237, 0x1123E, 0x1123E, 0x11241, 0x11241, 0x112DF, 0x112E8, 0x11300, 0x11303,
    0x1133E, 0x11344, 0x11347, 0x11348, 0x1134B, 0x1134C, 0x11357, 0x11357, 0x11362, 0x11363,
    0x113B8, 0x113C0, 0x113C2, 0x113C2, 0x113C5, 0x113C5, 0x113C7, 0x113CA, 0x113CC, 0x113CD,
    0x11435, 0x11441, 0x11443, 0x11445, 0x114B0, 0x114C1, 0x115AF, 0x115B5, 0x115B8, 0x115BE,
    0x115DC, 0x115DD, 0x11630, 0x1163E, 0x11640, 0x11640, 0x116AB, 0x116B5, 0x1171D, 0x1172A,
    0x1182C, 0x11838, 0x11930, 0x11935, 0x11937, 0x11938, 0x1193B, 0x1193C, 0x11940, 0x11940,
    0x11942, 0x11942, 0x119D1, 0x119D7, 0x119DA, 0x119DF, 0x119E4, 0x119E4, 0x11A01, 0x11A0A,
    0x11A35, 0x11A39, 0x11A3B, 0x11A3E, 0x11A51, 0x11A5B, 0x11A8A, 0x11A97, 0x11B60, 0x11B67,
    0x11C2F, 0x11C36, 0x11C38, 0x11C3E, 0x11C92, 0x11CA7, 0x11CA9, 0x11CB6, 0x11D31, 0x11D36,
    0x11D3A, 0x11D3A, 0x11D3C, 0x11D3D, 0x11D3F, 0x11D41, 0x11D43, 0x11D43, 0x11D47, 0x11D47,
    0x11D8A, 0x11D8E, 0x11D90, 0x11D91, 0x11D93, 0x11D96, 0x11EF3, 0x11EF6, 0x11F00, 0x11F01,
    0x11F03, 0x11F03, 0x11F34, 0x11F3A, 0x11F3E, 0x11F40, 0x1611E, 0x1612E, 0x16F4F, 0x16F4F,
    0x16F51, 0x16F87, 0x16F8F, 0x16F92, 0x16FF0, 0x16FF1, 0x1BC9E, 0x1BC9E, 0x1E000, 0x1E006,
    0x1E008, 0x1E018, 0x1E01B, 0x1E021, 0x1E023, 0x1E024, 0x1E026, 0x1E02A, 0x1E08F, 0x1E08F,
    0x1E6E3, 0x1E6E3, 0x1E6E6, 0x1E6E6, 0x1E6EE, 0x1E6EF, 0x1E6F5, 0x1E6F5, 0x1E947, 0x1E947,
    0x1F130, 0x1F149, 0x1F150, 0x1F169, 0x1F170, 0x1F189,
)

# Granica alfabetów łacińskiego, greckiego i cyrylicy w CoreFoundation („Roman, Greek, Cyrillic”).
_LGC_LIMIT = 0x0510

_REGIONAL_INDICATORS = range(0x1F1E6, 0x1F200)

# Znaki Cf, które nie są „Control” w UAX #29: ZWNJ, ZWJ i znaki Prepend.
_CF_NOT_CONTROL = frozenset(
    [0x200C, 0x200D, *range(0x0600, 0x0606), 0x06DD, 0x070F, 0x0890, 0x0891, 0x08E2, 0x110BD, 0x110CD]
)

# Tryby usuwania znaków niebazowych po znaku bazowym.
_STRIP_ALL, _STRIP_LOW, _STRIP_NONE = 0, 1, 2


def nfc(s: str | None) -> str | None:
    """Postać NFC tekstu (None przechodzi bez zmian)."""
    if s is None:
        return None
    return unicodedata.normalize("NFC", s)


def _is_extend(o: int) -> bool:
    """Znak rozszerzający grafem (Grapheme_Extend): dokleja się do poprzedniego i znika jak akcent."""
    if o in _OTHER_EXTEND or o in _MC_EXTEND:
        return True
    if o in _NOW_SPACING_MC:
        return False
    cat = unicodedata.category(chr(o))
    return cat == "Mn" or cat == "Me"


def _hangul_type(o: int) -> str | None:
    """Typ jamo/sylaby Hangul dla reguł GB6–GB8."""
    if 0x1100 <= o <= 0x115F or 0xA960 <= o <= 0xA97C:
        return "L"
    if 0x1160 <= o <= 0x11A7 or 0xD7B0 <= o <= 0xD7C6:
        return "V"
    if 0x11A8 <= o <= 0x11FF or 0xD7CB <= o <= 0xD7FB:
        return "T"
    if 0xAC00 <= o <= 0xD7A3:
        return "LV" if (o - 0xAC00) % 28 == 0 else "LVT"
    return None


_HANGUL_JOINS = {
    "L": ("L", "V", "LV", "LVT"),
    "LV": ("V", "T"),
    "V": ("V", "T"),
    "LVT": ("T",),
    "T": ("T",),
}


def _is_control(c: str) -> bool:
    """Znak sterujący w sensie podziału na grafemy (GB4/GB5): po nim zawsze jest granica."""
    cat = unicodedata.category(c)
    if cat in ("Cc", "Zl", "Zp"):
        return True
    return cat == "Cf" and ord(c) not in _CF_NOT_CONTROL and not 0xE0020 <= ord(c) <= 0xE007F


def _joins(prev: str, c: str, cluster: str) -> bool:
    """Czy między znakiem `prev` a `c` nie ma granicy grafemu (uproszczone UAX #29)."""
    o = ord(c)
    if o == 0x200D or 0x1F3FB <= o <= 0x1F3FF or _is_extend(o):
        return True
    cat = unicodedata.category(c)
    if cat == "Mc" or o in _NOW_SPACING_MC:
        return o not in _MC_NOT_SPACING
    p = ord(prev)
    if p == 0x200D:
        # GB11: sekwencje emoji łączone ZWJ.
        return cat == "So" and unicodedata.category(cluster[0]) == "So"
    if o in _REGIONAL_INDICATORS and p in _REGIONAL_INDICATORS:
        # GB12/13: flagi to pary wskaźników regionalnych.
        count = sum(1 for ch in cluster if ord(ch) in _REGIONAL_INDICATORS)
        return count % 2 == 1
    hp, hc = _hangul_type(p), _hangul_type(o)
    return hp is not None and hc is not None and hc in _HANGUL_JOINS[hp]


def clusters(s: str) -> list[str]:
    """Podział tekstu na grafemy – odpowiednik kolejnych `Character` w Swift.

    Uproszczenie względem UAX #29: brak reguł Prepend (GB9b) i zbitek indyjskich (GB9c).
    """
    result: list[str] = []
    for c in s:
        if result:
            last = result[-1]
            prev = last[-1]
            if prev == "\r":
                if c == "\n" and last == "\r":
                    result[-1] = "\r\n"
                    continue
            elif not _is_control(prev) and _joins(prev, c, last):
                result[-1] = last + c
                continue
        result.append(c)
    return result


def _is_letter_or_number(cluster: str) -> bool:
    """Swift `isLetter || isNumber` – decyduje pierwszy skalar grafemu (Alphabetic lub wartość liczbowa)."""
    c = cluster[0]
    if unicodedata.category(c)[0] == "L" or c.isnumeric():
        return True
    o = ord(c)
    i = bisect.bisect_right(_OTHER_ALPHABETIC, o)
    return i % 2 == 1 or (i > 0 and _OTHER_ALPHABETIC[i - 1] == o)


def cleaned_name(s: str) -> str:
    """Tekst bez nadmiarowych białych znaków (na początku, na końcu i podwójnych w środku).

    Wynik jest w NFC. Grafem zaczynający się od białego znaku (np. spacja + akcent) znika w całości – jak w Swift.
    """
    words: list[str] = []
    current: list[str] = []
    for cl in clusters(unicodedata.normalize("NFC", s)):
        if ord(cl[0]) in _WHITESPACE:
            if current:
                words.append("".join(current))
                current = []
        else:
            current.append(cl)
    if current:
        words.append("".join(current))
    return " ".join(words)


def nil_if_empty(s: str | None) -> str | None:
    """None zamiast pustego tekstu (bez przycinania spacji)."""
    if s is None or s == "":
        return None
    return s


def _lower(s: str) -> str:
    """Małe litery znak po znaku – jak Swift `lowercased()` (bez kontekstowej reguły końcowej sigmy)."""
    return "".join(c.lower() for c in s)


def name_key(s: str) -> str:
    """Klucz tożsamości nazw: bez nadmiarowych spacji i bez wielkości liter (znaki diakrytyczne zostają)."""
    return unicodedata.normalize("NFC", _lower(cleaned_name(s)))


def _is_nonbase(c: str) -> bool:
    """Znak niebazowy w sensie CoreFoundation (też złożony, którego rozkład zaczyna się od takiego znaku)."""
    o = ord(c)
    if _is_extend(o) or 0x1F3FB <= o <= 0x1F3FF:
        return True
    decomposed = unicodedata.normalize("NFD", c)
    return decomposed != c and _is_extend(ord(decomposed[0]))


def _fold_base(c: str) -> tuple[str, int]:
    """Składa znak bazowy (szerokość, rozkład, wielkość liter).

    Zwraca wynik i tryb usuwania kolejnych znaków niebazowych: `_STRIP_ALL`, `_STRIP_LOW` albo `_STRIP_NONE`.
    """
    changed = False
    if 0xFF00 <= ord(c) <= 0xFFEF:
        # Formy pełno- i półszerokie: zamiana na zwykłą postać, gdy jest jednym znakiem (U+FFE3 zostaje).
        wide = unicodedata.normalize("NFKD", c)
        if len(wide) == 1:
            c = wide
        changed = True
    decomposed = unicodedata.normalize("NFD", c)
    if decomposed != c and ord(decomposed[0]) < _LGC_LIMIT:
        c = decomposed[0]
        changed = True
    folded = _FOLD_EXCEPTIONS.get(c)
    if folded is None:
        folded = c.lower()
    if folded != c:
        changed = True
    if ord(folded[0]) < _LGC_LIMIT:
        return folded, _STRIP_ALL
    # Znak spoza LGC: niezmieniony traci tylko akcenty z bloków < U+0510, zmieniony – żadnych.
    return folded, (_STRIP_NONE if changed else _STRIP_LOW)


def _fold(s: str) -> str:
    """Odpowiednik `folding([.caseInsensitive, .diacriticInsensitive, .widthInsensitive])` z Foundation.

    Tekst dzielony jest na odcinki: znak bazowy + następujące po nim znaki niebazowe. Baza jest składana,
    znaki niebazowe usuwane zależnie od trybu bazy, a wynik odcinka porządkowany stabilnie wg klasy
    łączenia (tak robi CoreFoundation, również dla znaków o klasie 0).
    """
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        folded, mode = _fold_base(s[i])
        run = list(folded)
        i += 1
        first = True
        while i < n and _is_nonbase(s[i]):
            c = s[i]
            i += 1
            if mode == _STRIP_NONE or (mode == _STRIP_LOW and (not first or ord(c) >= _LGC_LIMIT)):
                # Poza LGC Foundation sprawdza tylko pierwszy znak niebazowy po bazie.
                run.append(c)
            first = False
        if len(run) > 1:
            run.sort(key=unicodedata.combining)
        out.extend(run)
    return unicodedata.normalize("NFC", "".join(out))


@functools.lru_cache(maxsize=8192)
def search_key(s: str) -> str:
    """Klucz wyszukiwania: bez wielkości liter, polskich znaków i różnic szerokości („Łódź” → „lodz”)."""
    cleaned = cleaned_name(s)
    if cleaned.isascii():
        return cleaned.lower()
    return _fold(cleaned).replace("\u0142", "l")


def loose_key(s: str) -> str:
    """Same litery i cyfry z `search_key` („J. K. Rowling” → „jkrowling”)."""
    kept = "".join(cl for cl in clusters(search_key(s)) if _is_letter_or_number(cl))
    return unicodedata.normalize("NFC", kept)


def words_key(s: str) -> str:
    """Słowa bez interpunkcji z `search_key` („Pucio. Mówi!” → „pucio mowi”)."""
    return cleaned_name("".join(cl if _is_letter_or_number(cl) else " " for cl in clusters(search_key(s))))


def _starts_with(hay: list[str], needle: list[str]) -> bool:
    return len(needle) <= len(hay) and hay[: len(needle)] == needle


def _contains(hay: list[str], needle: list[str]) -> bool:
    n = len(needle)
    return any(hay[i : i + n] == needle for i in range(len(hay) - n + 1))


def match_rank(text: str, query: str) -> int | None:
    """0 – tekst zaczyna się od zapytania, 1 – któreś słowo, 2 – zawiera je w środku, None – nie pasuje.

    Porównanie po grafemach, jak `hasPrefix`/`contains` w Swift („कि” nie zaczyna się od „क”).
    """
    needle_key = search_key(query)
    if needle_key == "":
        return 2
    hay_key = search_key(text)
    # Szybka ścieżka: bez dopasowania na poziomie skalarów nie ma go też na poziomie grafemów.
    if needle_key not in hay_key:
        return None
    needle = clusters(needle_key)
    hay = clusters(hay_key)
    if _starts_with(hay, needle):
        return 0
    word: list[str] = []
    for cl in [*hay, " "]:
        if cl == " ":
            if _starts_with(word, needle):
                return 1
            word = []
        else:
            word.append(cl)
    return 2 if _contains(hay, needle) else None


def matches(text: str, query: str) -> bool:
    """Czy tekst pasuje do zapytania."""
    return match_rank(text, query) is not None
