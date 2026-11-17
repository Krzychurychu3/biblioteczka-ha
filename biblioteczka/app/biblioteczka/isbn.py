"""Numer ISBN (13 cyfr, jak w kodzie EAN-13) i rozpoznawanie kodów kreskowych – port `ISBN.swift`.

Bliźniaczy moduł JS: `static/js/core/isbn.js`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Tuple, Union

from .textmatch import clusters

_DIGITS = "0123456789"


def _is_ascii_digits(s: str, length: int) -> bool:
    return len(s) == length and all(c in _DIGITS for c in s)


def check_digit13(first12: str) -> str:
    """Cyfra kontrolna ISBN-13 / EAN-13 dla 12 pierwszych cyfr, np. „978837578063” → „5”."""
    if not _is_ascii_digits(first12, 12):
        raise ValueError("Cyfra kontrolna ISBN-13 wymaga dokładnie 12 cyfr.")
    total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(first12))
    return str((10 - total % 10) % 10)


def check_digit10(first9: str) -> str:
    """Cyfra kontrolna ISBN-10 dla 9 pierwszych cyfr („0”–„9” albo „X”), np. „080442957” → „X”."""
    if not _is_ascii_digits(first9, 9):
        raise ValueError("Cyfra kontrolna ISBN-10 wymaga dokładnie 9 cyfr.")
    total = sum(int(d) * (10 - i) for i, d in enumerate(first9))
    check = (11 - total % 11) % 11
    return "X" if check == 10 else str(check)


def _is_valid13(digits: str) -> bool:
    return (
        _is_ascii_digits(digits, 13)
        and digits[:3] in ("978", "979")
        and check_digit13(digits[:12]) == digits[12]
    )


@dataclass(frozen=True)
class ISBN:
    """Poprawny numer ISBN w postaci 13 cyfr bez kresek, np. „9788375780635”. Równość po cyfrach."""

    digits: str

    def __post_init__(self) -> None:
        if not isinstance(self.digits, str) or not _is_valid13(self.digits):
            raise ValueError(f"Niepoprawny ISBN-13: {self.digits!r}")

    @classmethod
    def parse(cls, text: Optional[str]) -> Optional["ISBN"]:
        """ISBN-13 albo ISBN-10, z kreskami, spacjami czy napisem „ISBN”; None przy złej długości lub cyfrze kontrolnej.

        Liczą się tylko cyfry ASCII i litera X (jak w Swift: na poziomie grafemów, więc „1” z akcentem się nie liczy).
        """
        if not text:
            return None
        raw = "".join(
            "X" if cl in ("X", "x") else cl for cl in clusters(text) if cl in ("X", "x") or (len(cl) == 1 and cl in _DIGITS)
        )
        if len(raw) == 13:
            return cls(raw) if "X" not in raw and _is_valid13(raw) else None
        if len(raw) == 10:
            if "X" in raw[:9] or check_digit10(raw[:9]) != raw[9]:
                return None
            body = "978" + raw[:9]
            return cls(body + check_digit13(body))
        return None

    @property
    def isbn10(self) -> Optional[str]:
        """Postać dziesięciocyfrowa (tylko dla prefiksu 978) – tak BN zapisuje książki sprzed 2007 r."""
        if not self.digits.startswith("978"):
            return None
        body = self.digits[3:12]
        return body + check_digit10(body)

    def __str__(self) -> str:
        return self.digits


BarcodeKind = Literal["book", "magazine", "other"]


def classify_barcode(payload: str) -> Union[Tuple[Literal["book"], ISBN], Tuple[Literal["magazine", "other"], None]]:
    """Co jest w zeskanowanym kodzie EAN-13: („book”, ISBN), („magazine”, None) dla ISSN 977 albo („other”, None).

    Z kodu kreskowego przyjmujemy tylko 13 cyfr – ISBN-10 nie jest kodem książki.
    """
    digits = "".join(cl for cl in clusters(payload or "") if len(cl) == 1 and cl in _DIGITS)
    if len(digits) == 13:
        isbn = ISBN.parse(digits)
        if isbn is not None:
            return ("book", isbn)
    if digits.startswith("977"):
        return ("magazine", None)
    return ("other", None)
