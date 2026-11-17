"""Testy pomniejszania okładek i magazynu plików okładek."""

import hashlib
import io
import os
import struct
import time
import warnings
import zlib

import pytest
from PIL import Image, ImageFile

from conftest import FIXTURES_DIR

from biblioteczka import covers
from biblioteczka.covers import CoverStore, downscale


def encode(image, fmt="PNG", **params):
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **params)
    return buffer.getvalue()


def decoded(data):
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


@pytest.mark.parametrize(
    ("size", "expected"),
    [
        ((2000, 1000), (900, 450)),
        ((1000, 2000), (450, 900)),
        ((500, 300), (500, 300)),
        ((100, 50), (100, 50)),
        ((40, 40), (40, 40)),
        ((900, 900), (900, 900)),
        ((39, 100), None),
        ((1800, 30), None),  # po pomniejszeniu 900×15
        ((100, 39), None),
    ],
)
def test_verified_sizes(size, expected):
    result = downscale(encode(Image.new("RGB", size, (200, 30, 30))))
    if expected is None:
        assert result is None
    else:
        image = decoded(result)
        assert image.format == "JPEG"
        assert image.size == expected
        assert image.mode == "RGB"


@pytest.mark.parametrize("data", [b"", b"garbage", b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, b"\xff\xd8\xff\xe0broken"])
def test_garbage_gives_none(data):
    assert downscale(data) is None


def test_custom_limit_and_quality():
    data = encode(Image.new("RGB", (1000, 500), (10, 120, 200)))
    assert decoded(downscale(data, max_pixel_size=300, quality=50)).size == (300, 150)


def test_exif_orientation_is_applied_and_metadata_dropped():
    exif = Image.Exif()
    exif[0x0112] = 6  # obrót o 90° w prawo
    exif[0x010F] = "Producent aparatu"
    source = Image.new("RGB", (1200, 600), (255, 255, 255))
    source.paste((0, 0, 0), (0, 0, 100, 100))  # czarny róg: lewy górny przed obrotem
    data = encode(source, "JPEG", exif=exif.tobytes(), quality=95)

    image = decoded(downscale(data))
    assert image.size == (450, 900)
    # Po obrocie o 90° w prawo czarny róg trafia w prawy górny róg.
    assert image.getpixel((440, 10))[0] < 60
    assert image.getpixel((10, 10))[0] > 200
    assert not image.getexif()


def test_transparency_is_flattened_on_white():
    source = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    source.paste((255, 0, 0, 255), (0, 0, 50, 100))
    image = decoded(downscale(encode(source)))
    assert image.mode == "RGB"
    red, green, blue = image.getpixel((90, 50))
    assert min(red, green, blue) > 240
    assert image.getpixel((10, 50))[0] > 200 and image.getpixel((10, 50))[1] < 60


@pytest.mark.parametrize(
    "image",
    [
        Image.new("L", (300, 200), 128),
        Image.new("1", (300, 200), 1),
        Image.new("P", (300, 200), 3),
        Image.new("CMYK", (300, 200), (0, 255, 255, 0)),
        Image.new("LA", (300, 200), (100, 128)),
        Image.new("I;16", (300, 200), 40000),
    ],
    ids=["L", "1", "P", "CMYK", "LA", "I16"],
)
def test_various_modes(image):
    fmt = "TIFF" if image.mode in ("CMYK", "I;16") else "PNG"
    result = downscale(encode(image, fmt))
    assert decoded(result).size == (300, 200)


def test_first_frame_of_animation():
    frames = [Image.new("RGB", (120, 80), colour) for colour in ((255, 0, 0), (0, 0, 255))]
    data = encode(frames[0], "GIF", save_all=True, append_images=frames[1:])
    image = decoded(downscale(data))
    assert image.size == (120, 80)
    assert image.getpixel((60, 40))[0] > 200


def test_webp_input():
    data = encode(Image.new("RGB", (1200, 1800), (0, 128, 0)), "WEBP")
    assert decoded(downscale(data)).size == (600, 900)


@pytest.mark.parametrize(("name", "size"), [("synthetic-182x276.jpg", (182, 276)), ("synthetic-378x500.jpg", (378, 500))])
def test_baseline_jfif_cover_keeps_size(name, size):
    result = downscale((FIXTURES_DIR / "covers" / name).read_bytes())
    assert decoded(result).size == size


def test_too_many_pixels_rejected(monkeypatch):
    monkeypatch.setattr(covers, "_MAX_DECODED_PIXELS", 10_000)
    assert downscale(encode(Image.new("RGB", (200, 200)))) is None
    assert downscale(encode(Image.new("RGB", (100, 100)))) is not None  # dokładnie na granicy


def png_bomb(width, height):
    """Poprawny PNG w odcieniach szarości o ogromnych wymiarach i małym rozmiarze (same zera)."""

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    row = b"\x00" * (1 + width)
    compressor = zlib.compressobj(9)
    idat = b"".join(compressor.compress(row) for _ in range(height)) + compressor.flush()
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def test_decompression_bomb_is_rejected_before_decoding(monkeypatch):
    """Przegląd lookup-1/sec-2: PNG 10000×10000 (100 Mpx, ok. 100 kB) przechodził limit i zajmował ~0,8 GB."""
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
        assert downscale(data) is None
    assert loads == []  # odrzucone na podstawie nagłówka, bez dekodowania


def test_jpeg_limit_counts_size_after_reduced_decoding(monkeypatch):
    """JPEG dekodowany od razu w skali 1/4 mieści się w limicie, PNG tej samej wielkości nie."""
    monkeypatch.setattr(covers, "_MAX_DECODED_PIXELS", 1_000_000)
    image = Image.new("RGB", (1600, 1600), (40, 90, 160))
    baseline = encode(image, "JPEG", quality=90)
    assert decoded(downscale(baseline, max_pixel_size=200)).size == (200, 200)  # 2,56 Mpx → 400×400 przy odczycie
    assert downscale(encode(image), max_pixel_size=200) is None
    # Progresywny JPEG trzyma w pamięci współczynniki całego obrazu – liczy się oryginał.
    assert downscale(encode(image, "JPEG", quality=90, progressive=True), max_pixel_size=200) is None
    # Bez względu na zmniejszanie przy odczycie oryginał JPEG ma własny górny limit.
    monkeypatch.setattr(covers, "_MAX_JPEG_PIXELS", 2_000_000)
    assert downscale(baseline, max_pixel_size=200) is None


def test_webp_has_lower_limit(monkeypatch):
    monkeypatch.setitem(covers._MAX_PIXELS_BY_FORMAT, "WEBP", 10_000)
    image = Image.new("RGB", (200, 200), (0, 128, 0))
    assert downscale(encode(image, "WEBP")) is None
    assert downscale(encode(image)) is not None
    assert covers._MAX_PIXELS_BY_FORMAT["AVIF"] < covers._MAX_DECODED_PIXELS


def test_limits_fit_phone_photos():
    """Zdjęcie z telefonu 12–24 Mpx (także WebP) i JPEG 50 Mpx (8160×6120) wciąż przechodzą."""
    assert 5712 * 4284 <= covers._MAX_DECODED_PIXELS
    assert 4032 * 3024 <= covers._MAX_PIXELS_BY_FORMAT["WEBP"]
    assert 8160 * 6120 <= covers._MAX_JPEG_PIXELS
    assert (8160 // 2) * (6120 // 2) <= covers._MAX_DECODED_PIXELS
    assert 10_000 * 10_000 > covers._MAX_DECODED_PIXELS


def test_animated_png_and_mpo_first_frame():
    frames = [Image.new("RGB", (120, 80), colour) for colour in ((255, 0, 0), (0, 0, 255))]
    data = encode(frames[0], "PNG", save_all=True, append_images=frames[1:])
    assert decoded(downscale(data)).getpixel((60, 40))[0] > 200
    mpo = encode(frames[0], "MPO", save_all=True, append_images=frames[1:])
    assert Image.open(io.BytesIO(mpo)).format == "MPO"
    image = decoded(downscale(mpo))
    assert image.size == (120, 80) and image.getpixel((60, 40))[0] > 200


# --- CoverStore ---


def test_is_valid_id():
    assert CoverStore.is_valid_id("a" * 40)
    assert CoverStore.is_valid_id(hashlib.sha1(b"x").hexdigest())
    for value in ("A" * 40, "a" * 39, "a" * 41, "../" + "a" * 37, "g" * 40, None, 5, "a" * 40 + "\n"):
        assert not CoverStore.is_valid_id(value)


def test_put_is_content_addressed_and_atomic(tmp_path):
    store = CoverStore(tmp_path / "covers")
    data = downscale(encode(Image.new("RGB", (100, 100), (1, 2, 3))))
    cover_id = store.put(data)
    assert cover_id == hashlib.sha1(data).hexdigest()
    assert store.exists(cover_id)
    assert store.path(cover_id) == tmp_path / "covers" / f"{cover_id}.jpg"
    assert store.path(cover_id).read_bytes() == data
    assert store.read(cover_id) == data
    assert store.put(data) == cover_id
    assert sorted(p.name for p in (tmp_path / "covers").iterdir()) == [f"{cover_id}.jpg"]


def test_invalid_ids(tmp_path):
    store = CoverStore(tmp_path)
    with pytest.raises(ValueError):
        store.path("../etc/passwd")
    assert not store.exists("../etc/passwd")
    assert store.read("zzz") is None
    assert store.read("b" * 40) is None
    assert not store.exists("b" * 40)


def set_age(path, seconds):
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def test_gc_removes_only_old_orphans(tmp_path):
    store = CoverStore(tmp_path)
    kept = store.put(b"kept")
    old_orphan = store.put(b"old orphan")
    young_orphan = store.put(b"young orphan")
    for cover_id in (kept, old_orphan):
        set_age(store.path(cover_id), 2 * 86400)
    set_age(store.path(young_orphan), 3600)
    unrelated = tmp_path / "notatka.txt"
    unrelated.write_text("nie ruszać")
    set_age(unrelated, 5 * 86400)
    stale_temp = tmp_path / ".tmp-abc.jpg"
    stale_temp.write_bytes(b"przerwany zapis")
    set_age(stale_temp, 2 * 86400)

    assert store.gc({kept}) == 2
    assert store.exists(kept)
    assert not store.exists(old_orphan)
    assert store.exists(young_orphan)
    assert unrelated.exists()
    assert not stale_temp.exists()
    assert store.gc({kept}, min_age_seconds=0) == 1
    assert not store.exists(young_orphan)


def test_put_of_existing_file_refreshes_its_age(tmp_path):
    store = CoverStore(tmp_path)
    cover_id = store.put(b"same")
    set_age(store.path(cover_id), 3 * 86400)
    store.put(b"same")
    assert store.gc(set()) == 0
    assert store.exists(cover_id)


def test_embedded_icc_profile_is_converted_to_srgb():
    ImageCms = pytest.importorskip("PIL.ImageCms")
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    data = encode(Image.new("RGB", (200, 300), (200, 100, 50)), "JPEG", icc_profile=profile, quality=95)
    image = decoded(downscale(data))
    assert image.size == (200, 300)
    assert "icc_profile" not in image.info
    red, green, blue = image.getpixel((100, 150))
    assert abs(red - 200) < 8 and abs(green - 100) < 8 and abs(blue - 50) < 8


def test_broken_icc_profile_is_ignored():
    data = encode(Image.new("RGB", (100, 100), (10, 20, 30)), "JPEG", icc_profile=b"to nie jest profil")
    assert decoded(downscale(data)).size == (100, 100)
