"""Odczyt kodu EAN-13 ze zdjęcia po stronie serwera (zapasowo, gdy przeglądarka nie umie).

Korzysta z zxing-cpp: w kontenerze z pakietu Alpine `py3-zxing-cpp` (API 2.3),
lokalnie z PyPI `zxing-cpp` (API 3.x). Bez biblioteki funkcja jest po prostu niedostępna.
Zdjęcie jest przetwarzane wyłącznie w pamięci i nigdzie nie jest zapisywane.
"""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Any

from PIL import Image, ImageOps

from . import covers
from .isbn import classify_barcode

try:  # opcjonalna zależność
    import zxingcpp as _zxing
except ImportError:  # pragma: no cover - zależy od środowiska
    _zxing = None

__all__ = ["available", "decode", "decode_async", "MAX_IMAGE_BYTES"]

_LOGGER = logging.getLogger(__name__)

# Zdjęcia z aparatu mają kilka MB; większych nie ma sensu dekodować. Limit wymiarów
# (bomby dekompresyjne) jest wspólny z okładkami: `covers.prepare_decoding`.
MAX_IMAGE_BYTES = 20 * 1024 * 1024
# Dłuższy bok obrazu przekazywanego do dekodera (większe zdjęcia tylko spowalniają).
_MAX_SIDE = 2000
_KIND_PRIORITY = {"book": 0, "magazine": 1, "other": 2}


def available() -> bool:
    """Czy serwer potrafi odczytywać kody kreskowe."""
    return _zxing is not None


def _empty() -> dict[str, Any]:
    return {"kind": "none", "isbn": None, "codes": []}


def _read_options() -> list[dict[str, Any]]:
    """Zestawy argumentów od najpełniejszego; starsze API nie zna części z nich."""
    base: dict[str, Any] = {"formats": _zxing.BarcodeFormat.EAN13}
    full = dict(base, try_rotate=True, try_downscale=True)
    add_on = getattr(_zxing, "EanAddOnSymbol", None)
    options = []
    if add_on is not None and hasattr(add_on, "Ignore"):
        options.append(dict(full, ean_add_on_symbol=add_on.Ignore))
    options.append(full)
    options.append(base)
    return options


def _read(image: Image.Image) -> list[str]:
    """Teksty odczytanych kodów EAN-13 (w kolejności znalezienia)."""
    results = None
    last_error: Exception | None = None
    for options in _read_options():
        try:
            results = _zxing.read_barcodes(image, **options)
            break
        except TypeError as error:  # nieznany argument w tej wersji biblioteki
            last_error = error
    if results is None:
        raise RuntimeError("zxing-cpp nie przyjął żadnego zestawu argumentów") from last_error
    expected = _zxing.BarcodeFormat.EAN13
    codes = []
    for result in results:
        if not getattr(result, "valid", True):
            continue
        result_format = getattr(result, "format", expected)
        if result_format != expected:
            continue
        text = getattr(result, "text", "") or ""
        if text:
            codes.append(text)
    return codes


def _candidates(image: Image.Image):
    """Kolejne próby: obraz w rozsądnej wielkości, z podbitym kontrastem, mniejszy."""
    base = image.copy()
    base.thumbnail((_MAX_SIDE, _MAX_SIDE), Image.Resampling.LANCZOS)
    yield base
    yield ImageOps.autocontrast(base, cutoff=1)
    longest = max(base.size)
    for side in (1000, 600):
        if longest > side * 1.2:
            smaller = base.copy()
            smaller.thumbnail((side, side), Image.Resampling.LANCZOS)
            yield smaller


def _load(image_bytes: bytes) -> Image.Image | None:
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            source.seek(0)
            # Wymiary sprawdzane przed dekodowaniem (bomby dekompresyjne). Dekoder pracuje
            # w odcieniach szarości; „draft” zmniejsza duże JPEG-i już przy odczycie.
            if not covers.prepare_decoding(source, "L", (_MAX_SIDE, _MAX_SIDE)):
                return None
            image: Image.Image = source
            transparent = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
            if transparent:
                if image.mode not in ("RGBA", "LA"):
                    image = image.convert("RGBA")
            elif image.mode not in ("L", "RGB"):
                # Paleta skalowałaby się „najbliższym sąsiadem” – najpierw odcienie szarości.
                image = image.convert("L")
            # Zmniejszenie zaraz po zdekodowaniu: obrót, białe tło i szarość
            # powstają już na obrazie ≤ 2000 px, a nie na kopiach w pełnej rozdzielczości.
            image.thumbnail((_MAX_SIDE, _MAX_SIDE), Image.Resampling.LANCZOS)
            image = ImageOps.exif_transpose(image)
            if transparent:
                rgba = image.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (255, 255, 255))
                flat.paste(rgba, mask=rgba.getchannel("A"))
                image = flat
            return image.convert("L")
    except Exception as error:  # uszkodzony albo nieobsługiwany plik
        _LOGGER.debug("Nie udało się odczytać zdjęcia kodu: %s", error)
        return None


def decode(image_bytes: bytes) -> dict[str, Any]:
    """Szuka kodów EAN-13 na zdjęciu.

    Wynik: `{"kind": "book"|"magazine"|"other"|"none", "isbn": "978…"|None, "codes": [...]}`;
    `none` = nie znaleziono żadnego kodu (albo dekoder jest niedostępny).
    """
    result = _empty()
    if _zxing is None or not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        return result
    image = _load(image_bytes)
    if image is None:
        return result

    codes: list[str] = []
    try:
        for candidate in _candidates(image):
            for code in _read(candidate):
                if code not in codes:
                    codes.append(code)
            if codes:
                break
    except Exception:
        _LOGGER.exception("Błąd dekodera kodów kreskowych")
        return result
    if not codes:
        return result

    best_kind, best_isbn = "other", None
    for code in codes:
        kind, isbn = classify_barcode(code)
        if _KIND_PRIORITY.get(kind, 2) < _KIND_PRIORITY[best_kind]:
            best_kind, best_isbn = kind, isbn
    result["kind"] = best_kind
    result["isbn"] = best_isbn.digits if best_kind == "book" and best_isbn is not None else None
    result["codes"] = codes
    return result


async def decode_async(image_bytes: bytes) -> dict[str, Any]:
    """`decode` w wątku roboczym, żeby nie blokować pętli serwera."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, decode, image_bytes)
