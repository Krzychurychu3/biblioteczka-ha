"""Polska odmiana rzeczowników po liczebnikach: 1 książka, 2 książki, 5 książek (port `Polish` z Swift).

Bliźniaczy moduł JS: `static/js/core/polish.js` (te same identyfikatory rzeczowników).
"""

from __future__ import annotations

# Formy (jedna / kilka / wiele) – identyfikatory jak przypadki `Polish.Noun` w Swift.
NOUNS: dict[str, tuple[str, str, str]] = {
    "book": ("książka", "książki", "książek"),
    "series": ("seria", "serie", "serii"),
    "volume": ("tom", "tomy", "tomów"),
    "author": ("autor", "autorzy", "autorów"),
}


def form(n: int, noun: str) -> str:
    """Forma rzeczownika po liczbie `n` (bez liczby), np. `form(3, "book")` → „książki”.

    Liczby ujemne zawsze dają formę „wiele” – jak w Swift, gdzie reszta z dzielenia zachowuje znak.
    """
    try:
        one, few, many = NOUNS[noun]
    except KeyError:
        raise ValueError(f"Nieznany rzeczownik: {noun!r}") from None
    if n == 1:
        return one
    if n > 0 and 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def count(n: int, noun: str) -> str:
    """Liczba z odmienionym rzeczownikiem, np. `count(5, "book")` → „5 książek”."""
    return f"{n} {form(n, noun)}"
