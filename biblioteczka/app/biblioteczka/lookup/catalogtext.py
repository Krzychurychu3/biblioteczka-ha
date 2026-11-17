"""Porządkowanie tekstów z katalogów bibliotecznych (port `CatalogText` z aplikacji iOS).

Reguły są przeniesione 1:1 ze Swifta (łącznie z udokumentowanymi dziwactwami),
bo od nich zależą dane podpowiadane użytkownikowi po zeskanowaniu ISBN.
"""

from __future__ import annotations

import re
import unicodedata

__all__ = [
    "trimmed",
    "person_name",
    "series_name",
    "publisher",
    "volume_number",
    "page_count",
    "year",
    "swift_int",
    "clamp",
    "clamp_volume",
    "clamp_year",
    "clamp_pages",
    "strip_whitespace",
    "strip_whitespace_and_newlines",
]

# Zakresy liczb przyjmowanych z katalogów i formularzy (poprawka §9.7).
VOLUME_RANGE = (1, 999)
YEAR_RANGE = (1000, 2100)
PAGES_RANGE = (1, 9999)

_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1

# Unicode White_Space – odpowiednik Swiftowego `Character.isWhitespace`.
_WHITE_SPACE = frozenset(
    "\u0009\u000a\u000b\u000c\u000d \u0085  "
    "           "
    "    　"
)

_TRAILING_PUNCTUATION = " /:;,=."
_SWIFT_INT = re.compile(r"[+-]?[0-9]+")
_PAGE_COUNT = re.compile(
    r"\[?([0-9]+)\]?(?:\s*,\s*\[?[0-9]+\]?)*\s*(?:s\.|s\b|str|stron|k\.|kart|p\.|pages)",
    re.IGNORECASE,
)
_YEAR = re.compile(r"\b(1[5-9][0-9][0-9]|20[0-9][0-9])\b")


def _is_whitespace(ch: str) -> bool:
    """`CharacterSet.whitespaces`: separatory spacji (Zs) i tabulator."""
    return ch == "\t" or unicodedata.category(ch) == "Zs"


def _is_whitespace_or_newline(ch: str) -> bool:
    """`CharacterSet.whitespacesAndNewlines`: Z*, U+0009…U+000D i U+0085."""
    return ch in "\t\n\x0b\x0c\r\x85" or unicodedata.category(ch) in ("Zs", "Zl", "Zp")


def _strip(text: str, predicate) -> str:
    start, end = 0, len(text)
    while start < end and predicate(text[start]):
        start += 1
    while end > start and predicate(text[end - 1]):
        end -= 1
    return text[start:end]


def strip_whitespace(text: str) -> str:
    """Obcina spacje i tabulatory z obu stron (Swift `.whitespaces`)."""
    return _strip(text, _is_whitespace)


def strip_whitespace_and_newlines(text: str) -> str:
    """Obcina białe znaki i znaki nowej linii z obu stron (Swift `.whitespacesAndNewlines`)."""
    return _strip(text, _is_whitespace_or_newline)


def swift_int(text: str) -> int | None:
    """Odpowiednik Swiftowego `Int(String)`: opcjonalny znak, same cyfry ASCII, zakres Int64."""
    if not _SWIFT_INT.fullmatch(text):
        return None
    value = int(text)
    if value < _INT64_MIN or value > _INT64_MAX:
        return None
    return value


def _ends_with_initial(text: str) -> bool:
    """„… K.” – pojedyncza litera przed kropką na końcu."""
    characters = text[:-1]
    if not characters or not characters[-1].isalpha():
        return False
    return len(characters) == 1 or characters[-2] == " "


def trimmed(text: str) -> str:
    """Usuwa interpunkcję katalogową z końca pola: „Ostatnie życzenie /” → „Ostatnie życzenie”.

    Kropka po inicjale („J. K.”) i wielokropek zostają; jedna para nawiasów
    kwadratowych obejmująca całość jest zdejmowana.
    """
    result = strip_whitespace_and_newlines(text)
    while result and result[-1] in _TRAILING_PUNCTUATION:
        if result[-1] == "." and (result.endswith("...") or _ends_with_initial(result)):
            break
        result = strip_whitespace(result[:-1])
    if result.startswith("[") and result.endswith("]"):
        result = strip_whitespace(result[1:-1])
    return result


def _split_once(text: str, separator: str) -> list[str]:
    """Swiftowe `split(separator:maxSplits: 1)` – puste kawałki są pomijane."""
    parts: list[str] = []
    start = 0
    for index, ch in enumerate(text):
        if ch != separator:
            continue
        if index > start:
            parts.append(text[start:index])
            start = index + 1
            break
        start = index + 1
    if start < len(text):
        parts.append(text[start:])
    return parts


def person_name(raw: str) -> str:
    """„Sapkowski, Andrzej” → „Andrzej Sapkowski”."""
    cleaned = trimmed(raw)
    parts = [strip_whitespace(part) for part in _split_once(cleaned, ",")]
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return cleaned
    return f"{parts[1]} {parts[0]}"


def series_name(raw: str) -> str:
    """„Wiedźmin / Andrzej Sapkowski ;” → „Wiedźmin”."""
    name = raw
    for separator in (" / ", " ; "):
        position = name.find(separator)
        if position >= 0:
            name = name[:position]
    return trimmed(name)


def publisher(raw: str) -> str:
    """Wydawca bez interpunkcji, z polskimi cudzysłowami: `"Nasza Księgarnia",` → „Nasza Księgarnia”."""
    cleaned = trimmed(raw.replace("©", ""))
    result: list[str] = []
    opening = True
    for ch in cleaned:
        if ch == '"':
            result.append("„" if opening else "”")
            opening = not opening
        else:
            result.append(ch)
    return "".join(result)


def _volume_tokens(raw: str) -> list[str]:
    text = raw.replace("[", " ").replace("]", " ")
    tokens: list[str] = []
    current: list[str] = []
    for ch in text:
        if ch in _WHITE_SPACE or ch in ".,":
            if current:
                tokens.append("".join(current))
                current = []
        else:
            current.append(ch)
    if current:
        tokens.append("".join(current))
    return tokens


def _roman_number(token: str) -> int | None:
    values = {"I": 1, "V": 5, "X": 10, "L": 50}
    if not 1 <= len(token) <= 6 or any(ch not in values for ch in token):
        return None
    numbers = [values[ch] for ch in token]
    total = 0
    for index, value in enumerate(numbers):
        following = numbers[index + 1] if index + 1 < len(numbers) else 0
        total += -value if value < following else value
    return total if total > 0 else None


def volume_number(raw: str) -> int | None:
    """Numer tomu: „t. 18” → 18, „[1]” → 1, „Bd. 3” → 3, „t. II” → 2. Zakres „t. 1-8” → None.

    O wyniku decyduje pierwszy token liczbowy.
    """
    tokens = _volume_tokens(raw)
    for index, token in enumerate(tokens):
        number = swift_int(token)
        if number is not None:
            is_range = index + 1 < len(tokens) and tokens[index + 1][0] in "-–"
            if is_range or number <= 0 or number > 999:
                return None
            return number
        if "-" in token or "–" in token:
            return None
        roman = _roman_number(token)
        if roman is not None:
            return roman
    return None


def page_count(raw: str) -> int | None:
    """Liczba stron z opisu fizycznego: „330, [6] stron ;” → 330, „1 tom (286 s.)” → 286."""
    match = _PAGE_COUNT.search(raw)
    if match is None:
        return None
    number = swift_int(match.group(1))
    return number if number is not None and number > 0 else None


def year(raw: str) -> int | None:
    """Pierwszy rok 1500–2099 w tekście: „copyright 2014.” → 2014."""
    match = _YEAR.search(raw)
    return int(match.group(1)) if match else None


def clamp(value: int | None, bounds: tuple[int, int]) -> int | None:
    """Liczba spoza zakresu (albo nie-liczba) → None."""
    if value is None or isinstance(value, bool) or not isinstance(value, int):
        return None
    low, high = bounds
    return value if low <= value <= high else None


def clamp_volume(value: int | None) -> int | None:
    return clamp(value, VOLUME_RANGE)


def clamp_year(value: int | None) -> int | None:
    return clamp(value, YEAR_RANGE)


def clamp_pages(value: int | None) -> int | None:
    return clamp(value, PAGES_RANGE)
