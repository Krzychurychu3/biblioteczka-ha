"""Testy odczytu kodów EAN-13 ze zdjęć po stronie serwera."""

import importlib
import io
import random
import struct
import sys
import types
import warnings
import zlib

import pytest
from PIL import Image, ImageDraw, ImageFile, ImageFilter

zxingcpp = pytest.importorskip("zxingcpp")


def _install_isbn_double():
    """Prywatny dubler `biblioteczka.isbn`, gdy równolegle pisany moduł jeszcze nie istnieje."""

    class ISBN:
        def __init__(self, digits):
            self.digits = digits

        @classmethod
        def parse(cls, text):
            raw = "".join(c for c in text.upper() if c == "X" or c in "0123456789")
            if len(raw) == 13 and "X" not in raw and raw[:3] in ("978", "979") and _check13(raw[:12]) == raw[12]:
                return cls(raw)
            return None

    def _check13(first12):
        return str((10 - sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(first12)) % 10) % 10)

    def classify_barcode(payload):
        digits = "".join(c for c in payload if c in "0123456789")
        if len(digits) == 13 and ISBN.parse(digits) is not None:
            return ("book", ISBN.parse(digits))
        if digits.startswith("977"):
            return ("magazine", None)
        return ("other", None)

    module = types.ModuleType("biblioteczka.isbn")
    module.ISBN = ISBN
    module.classify_barcode = classify_barcode
    return module


@pytest.fixture(scope="module")
def barcode():
    injected = False
    try:
        importlib.import_module("biblioteczka.isbn")
    except ImportError:
        sys.modules["biblioteczka.isbn"] = _install_isbn_double()
        injected = True
    sys.modules.pop("biblioteczka.barcode", None)
    module = importlib.import_module("biblioteczka.barcode")
    yield module
    if injected:
        sys.modules.pop("biblioteczka.isbn", None)
        sys.modules.pop("biblioteczka.barcode", None)


# --- rysowanie kodu EAN-13 (bez zależności od API zapisu zxing-cpp) ---

_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
_R = ["".join("1" if bit == "0" else "0" for bit in code) for code in _L]
_G = [code[::-1] for code in _R]
_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]


def ean13_modules(code):
    assert len(code) == 13
    first, left, right = int(code[0]), code[1:7], code[7:]
    bits = "101"
    for digit, parity in zip(left, _PARITY[first]):
        bits += (_L if parity == "L" else _G)[int(digit)]
    bits += "01010"
    for digit in right:
        bits += _R[int(digit)]
    return bits + "101"


def ean13_image(code, module=3, height=160, quiet=12):
    bits = ean13_modules(code)
    width = (len(bits) + 2 * quiet) * module
    image = Image.new("L", (width, height + 2 * quiet * module), 255)
    draw = ImageDraw.Draw(image)
    for index, bit in enumerate(bits):
        if bit == "1":
            x = (quiet + index) * module
            draw.rectangle([x, quiet * module, x + module - 1, quiet * module + height], fill=0)
    return image


def photo_of(code, size=(1600, 1200), rotate=0, blur=0.0, fmt="JPEG"):
    """Kod wklejony w „zdjęcie” z szumem, opcjonalnie obrócone i rozmyte."""
    rng = random.Random(code)
    background = Image.new("RGB", size, (170, 160, 150))
    pixels = background.load()
    for _ in range(size[0] * size[1] // 50):
        x, y = rng.randrange(size[0]), rng.randrange(size[1])
        pixels[x, y] = (rng.randrange(256),) * 3
    label = ean13_image(code).convert("RGB")
    background.paste(label, ((size[0] - label.width) // 2, (size[1] - label.height) // 2))
    if rotate:
        background = background.rotate(rotate, expand=True, fillcolor=(170, 160, 150))
    if blur:
        background = background.filter(ImageFilter.GaussianBlur(blur))
    buffer = io.BytesIO()
    background.save(buffer, format=fmt, quality=85) if fmt == "JPEG" else background.save(buffer, format=fmt)
    return buffer.getvalue()


def test_available(barcode):
    assert barcode.available() is True


def test_renderer_produces_valid_ean13():
    # Sprawdzenie samego rysownika na dekoderze zxing-cpp.
    results = zxingcpp.read_barcodes(ean13_image("9788375780635"))
    assert [r.text for r in results] == ["9788375780635"]


@pytest.mark.parametrize(
    ("code", "kind", "isbn"),
    [
        ("9788375780635", "book", "9788375780635"),
        ("9791032305690", "book", "9791032305690"),
        ("9771234567003", "magazine", None),
        ("5901234123457", "other", None),
    ],
)
def test_classification(barcode, code, kind, isbn):
    result = barcode.decode(photo_of(code))
    assert result == {"kind": kind, "isbn": isbn, "codes": [code]}


def test_rotated_photo(barcode):
    assert barcode.decode(photo_of("9788375780635", rotate=90))["isbn"] == "9788375780635"


def test_exif_rotated_photo(barcode):
    image = Image.open(io.BytesIO(photo_of("9788380083738", rotate=90)))
    exif = Image.Exif()
    exif[0x0112] = 8
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif.tobytes(), quality=90)
    assert barcode.decode(buffer.getvalue())["isbn"] == "9788380083738"


def test_large_photo_is_downscaled(barcode):
    data = photo_of("9788372780140", size=(4000, 3000))
    assert barcode.decode(data)["kind"] == "book"


def test_png_input(barcode):
    assert barcode.decode(photo_of("9788310139658", fmt="PNG"))["isbn"] == "9788310139658"


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_transparent_background_is_flattened_on_white(barcode):
    """Czarne kreski na przezroczystym (czarnym) tle: bez białego podkładu obraz byłby cały czarny."""
    for size, module, height in (((360, 240), 3, 160), ((2600, 1400), 8, 400)):
        mask = Image.new("L", size, 0)
        mask.paste(ean13_image("9788375780635", module=module, height=height).point(lambda v: 255 - v), (0, 0))
        rgba = Image.new("RGBA", size, (0, 0, 0, 0))
        rgba.putalpha(mask)
        # Drugi obraz (2600 px) jest zmniejszany jeszcze przed nałożeniem białego tła.
        assert barcode.decode(_png(rgba))["isbn"] == "9788375780635"


@pytest.mark.parametrize("transparent", [False, True])
def test_palette_png(barcode, transparent):
    image = ean13_image("9788310139658").convert("RGB").quantize(colors=4)
    if transparent:
        image.info["transparency"] = 0
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", **({"transparency": 0} if transparent else {}))
    assert Image.open(io.BytesIO(buffer.getvalue())).mode == "P"
    assert barcode.decode(buffer.getvalue())["isbn"] == "9788310139658"


def png_bomb(width, height):
    """Poprawny PNG w odcieniach szarości o ogromnych wymiarach i małym rozmiarze (same zera)."""

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    row = b"\x00" * (1 + width)
    compressor = zlib.compressobj(9)
    idat = b"".join(compressor.compress(row) for _ in range(height)) + compressor.flush()
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def test_decompression_bomb_is_rejected_before_decoding(barcode, monkeypatch):
    """Przegląd lookup-1/sec-2: PNG 10000×10000 (100 Mpx, ok. 100 kB) przechodził limit i zajmował ~1,6 GB."""
    data = png_bomb(10_000, 10_000)
    assert len(data) < 1_000_000
    loads = []
    original_load = ImageFile.ImageFile.load

    def spy(self):
        loads.append(self.size)
        return original_load(self)

    monkeypatch.setattr(ImageFile.ImageFile, "load", spy)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", Image.DecompressionBombWarning)
        assert barcode.decode(data) == {"kind": "none", "isbn": None, "codes": []}
    assert loads == []  # odrzucone na podstawie nagłówka, bez dekodowania


def test_jpeg_limit_counts_size_after_reduced_decoding(barcode, monkeypatch):
    """Duży JPEG jest czytany od razu w skali 1/2 (mieści się w limicie), PNG tej samej wielkości nie."""
    from biblioteczka import covers

    monkeypatch.setattr(covers, "_MAX_DECODED_PIXELS", 4_000_000)
    canvas = Image.new("L", (4000, 4000), 255)
    canvas.paste(ean13_image("9788372780140", module=8, height=400), (1200, 1600))
    buffer = io.BytesIO()
    canvas.save(buffer, format="JPEG", quality=90)
    assert barcode.decode(buffer.getvalue())["isbn"] == "9788372780140"
    assert barcode.decode(_png(canvas))["kind"] == "none"


def test_book_wins_over_other_codes(barcode):
    canvas = Image.new("L", (900, 900), 255)
    canvas.paste(ean13_image("5901234123457"), (20, 20))
    canvas.paste(ean13_image("9788375780635"), (20, 500))
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG")
    result = barcode.decode(buffer.getvalue())
    assert result["kind"] == "book"
    assert result["isbn"] == "9788375780635"
    assert sorted(result["codes"]) == ["5901234123457", "9788375780635"]


def test_nothing_found(barcode):
    buffer = io.BytesIO()
    Image.new("RGB", (640, 480), (200, 200, 200)).save(buffer, format="JPEG")
    assert barcode.decode(buffer.getvalue()) == {"kind": "none", "isbn": None, "codes": []}


@pytest.mark.parametrize("data", [b"", b"to nie jest obraz", b"\xff\xd8\xff\xe0uszkodzony"])
def test_garbage(barcode, data):
    assert barcode.decode(data) == {"kind": "none", "isbn": None, "codes": []}


def test_oversized_upload_is_rejected(barcode, monkeypatch):
    monkeypatch.setattr(barcode, "MAX_IMAGE_BYTES", 10)
    assert barcode.decode(photo_of("9788375780635"))["kind"] == "none"


def test_unavailable_decoder(barcode, monkeypatch):
    monkeypatch.setattr(barcode, "_zxing", None)
    assert barcode.available() is False
    assert barcode.decode(photo_of("9788375780635")) == {"kind": "none", "isbn": None, "codes": []}


class _FakeResult:
    def __init__(self, text, fmt, valid=True):
        self.text, self.format, self.valid = text, fmt, valid


def _fake_module(read_barcodes):
    module = types.SimpleNamespace()
    module.BarcodeFormat = types.SimpleNamespace(EAN13="EAN13")
    module.read_barcodes = read_barcodes
    return module


def test_alpine_2_3_style_api(barcode, monkeypatch):
    """Starsze API: bez `ean_add_on_symbol`, wynik z polami `text`, `format`, `valid`."""
    calls = []

    def read_barcodes(image, formats=None, try_rotate=True, try_downscale=True, text_mode=None, binarizer=None, is_pure=False):
        calls.append((formats, try_rotate, try_downscale))
        return [_FakeResult("9788375780635", "EAN13"), _FakeResult("9771234567003", "EAN13", valid=False),
                _FakeResult("12345", "EAN8")]

    fake = _fake_module(read_barcodes)
    fake.EanAddOnSymbol = types.SimpleNamespace(Ignore="ignore")
    monkeypatch.setattr(barcode, "_zxing", fake)
    result = barcode.decode(photo_of("9788375780635"))
    assert result == {"kind": "book", "isbn": "9788375780635", "codes": ["9788375780635"]}
    assert calls == [("EAN13", True, True)]


def test_minimal_api_fallback(barcode, monkeypatch):
    def read_barcodes(image, formats=None):
        return [_FakeResult("9771234567003", "EAN13")]

    monkeypatch.setattr(barcode, "_zxing", _fake_module(read_barcodes))
    assert barcode.decode(photo_of("9771234567003"))["kind"] == "magazine"


def test_decoder_crash_is_contained(barcode, monkeypatch):
    def read_barcodes(image, **kwargs):
        raise RuntimeError("awaria dekodera")

    monkeypatch.setattr(barcode, "_zxing", _fake_module(read_barcodes))
    assert barcode.decode(photo_of("9788375780635"))["kind"] == "none"


@pytest.mark.asyncio
async def test_decode_async(barcode):
    result = await barcode.decode_async(photo_of("9788375780635"))
    assert result["isbn"] == "9788375780635"
