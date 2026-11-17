"""Okładki: pomniejszanie zdjęć do JPEG i magazyn plików adresowanych treścią (SHA-1)."""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import tempfile
import time
from pathlib import Path

from PIL import Image

__all__ = ["MAX_PIXEL_SIZE", "MIN_PIXEL_SIZE", "JPEG_QUALITY", "downscale", "prepare_decoding", "CoverStore"]

_LOGGER = logging.getLogger(__name__)

MAX_PIXEL_SIZE = 900
MIN_PIXEL_SIZE = 40
JPEG_QUALITY = 80
# Ochrona przed „bombami dekompresyjnymi” (mały plik, ogromny obraz), sprawdzana przed dekodowaniem.
# Największa klatka dekodowana w pełnej rozdzielczości: Pillow trzyma RGB/RGBA po 4 bajty na piksel,
# a skalowanie obrazu z przezroczystością robi drugą kopię – 25 Mpx to najwyżej ok. 300 MB
# na jedno zdjęcie (dwa naraz – IMAGE_WORKERS w server.py – mieszczą się na Raspberry Pi z 2 GB pamięci).
# Zdjęcie z telefonu (12–24 Mpx) wciąż przechodzi.
_MAX_DECODED_PIXELS = 25_000_000
# Dekodery WebP i AVIF trzymają jeszcze własne bufory całej klatki (WebP ok. 20 bajtów na piksel).
_MAX_PIXELS_BY_FORMAT = {"WEBP": 16_000_000, "AVIF": 16_000_000}
# JPEG (także MPO z telefonów) Pillow dekoduje od razu w skali 1/2–1/8 („draft”), więc większe
# zdjęcia (np. 48–50 Mpx) przechodzą, o ile po tym zmniejszeniu mieszczą się w limicie wyżej.
# Progresywny JPEG trzyma jednak w pamięci współczynniki całego obrazu (3–6 bajtów na piksel),
# więc dla niego liczy się rozmiar oryginału.
_MAX_JPEG_PIXELS = 100_000_000

# Orientacja EXIF → przekształcenie (to samo co `ImageOps.exif_transpose`).
_EXIF_TRANSPOSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}

_COVER_ID = re.compile(r"[0-9a-f]{40}")
_SUFFIX = ".jpg"
_TEMP_PREFIX = ".tmp-"


def prepare_decoding(source: Image.Image, mode: str | None, size: tuple[int, int]) -> bool:
    """Sprawdza wymiary otwartego (jeszcze niezdekodowanego) obrazu i dla JPEG włącza odczyt w mniejszej skali.

    `mode` i `size` jak w `Image.draft`: docelowy tryb i najmniejszy potrzebny rozmiar.
    Zwraca False dla obrazu pustego albo zbyt dużego, żeby go dekodować.
    """
    width, height = source.size
    if width <= 0 or height <= 0:
        return False
    if source.format in ("JPEG", "MPO"):
        if width * height > _MAX_JPEG_PIXELS:
            return False
        progressive = bool(source.info.get("progressive"))
        source.draft(mode, size)
        if not progressive:
            width, height = source.size  # wymiary po zmniejszeniu przy odczycie
    return width * height <= _MAX_PIXELS_BY_FORMAT.get(source.format, _MAX_DECODED_PIXELS)


def _to_srgb(image: Image.Image) -> Image.Image:
    """Przelicza kolory z osadzonego profilu ICC na sRGB (zdjęcia z telefonów bywają w Display P3)."""
    profile = image.info.get("icc_profile")
    if not profile or image.mode not in ("RGB", "RGBA", "CMYK"):
        return image
    try:
        from PIL import ImageCms

        source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        target = ImageCms.createProfile("sRGB")
        output_mode = "RGBA" if image.mode == "RGBA" else "RGB"
        converted = ImageCms.profileToProfile(image, source, target, outputMode=output_mode)
        return converted if converted is not None else image
    except Exception:  # brak lcms albo uszkodzony profil – zostają oryginalne kolory
        return image


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    """RGB bez kanału alfa; przezroczystość nakładana na białe tło."""
    if image.mode == "P" and "transparency" in image.info:
        image = image.convert("RGBA")
    if image.mode in ("RGBA", "LA", "PA", "RGBa", "La"):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    if image.mode in ("I", "I;16", "I;16B", "I;16L", "I;16N", "F"):
        # Obrazy 16-bitowe/zmiennoprzecinkowe: skalowanie do 8 bitów.
        image = image.convert("I").point(lambda value: value / 256).convert("L")
    return image.convert("RGB") if image.mode != "RGB" else image


def downscale(data: bytes, max_pixel_size: int = MAX_PIXEL_SIZE, quality: int = JPEG_QUALITY) -> bytes | None:
    """Pomniejsza zdjęcie okładki (dłuższy bok ≤ `max_pixel_size`, bez powiększania) do JPEG.

    Uwzględnia obrót z EXIF, nie kopiuje metadanych. Zwraca None dla danych, których
    nie da się odczytać, i dla zaślepek mniejszych niż 40 px w którymkolwiek wymiarze.
    """
    if not data:
        return None
    try:
        with Image.open(io.BytesIO(data)) as source:
            source.seek(0)  # pierwsza klatka (GIF, WebP, wielostronicowe TIFF)
            # Miniatura liczona z pełnego obrazu, nie z osadzonej miniaturki; JPEG Pillow dekoduje
            # od razu w mniejszej skali, z zapasem jakości (jak `thumbnail` z `reducing_gap=2`).
            if not prepare_decoding(source, None, (max_pixel_size * 2, max_pixel_size * 2)):
                return None
            orientation = source.getexif().get(0x0112, 1)
            image: Image.Image = source
            if image.mode in ("1", "P"):
                # Paleta skalowałaby się „najbliższym sąsiadem” – najpierw pełne kolory.
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            image.thumbnail((max_pixel_size, max_pixel_size), Image.Resampling.LANCZOS)
            method = _EXIF_TRANSPOSE.get(orientation)
            if method is not None:
                image = image.transpose(method)
            if image.width < MIN_PIXEL_SIZE or image.height < MIN_PIXEL_SIZE:
                return None
            image = _flatten_to_rgb(_to_srgb(image))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            return output.getvalue()
    except Exception as error:  # Pillow zgłasza różne wyjątki dla uszkodzonych plików
        _LOGGER.debug("Nie udało się przetworzyć okładki: %s", error)
        return None


class CoverStore:
    """Pliki `covers/<sha1>.jpg`; ta sama treść → ten sam identyfikator."""

    def __init__(self, directory: str | os.PathLike[str]) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def is_valid_id(value: object) -> bool:
        return isinstance(value, str) and _COVER_ID.fullmatch(value) is not None

    def path(self, cover_id: str) -> Path:
        if not self.is_valid_id(cover_id):
            raise ValueError(f"Niepoprawny identyfikator okładki: {cover_id!r}")
        return self.directory / f"{cover_id}{_SUFFIX}"

    def exists(self, cover_id: str) -> bool:
        return self.is_valid_id(cover_id) and self.path(cover_id).is_file()

    def read(self, cover_id: str) -> bytes | None:
        """Treść pliku okładki albo None, gdy go nie ma."""
        if not self.is_valid_id(cover_id):
            return None
        try:
            return self.path(cover_id).read_bytes()
        except FileNotFoundError:
            return None

    def put(self, jpeg_bytes: bytes) -> str:
        """Zapisuje JPEG atomowo i zwraca jego SHA-1 (hex)."""
        cover_id = hashlib.sha1(jpeg_bytes).hexdigest()
        target = self.path(cover_id)
        if target.is_file():
            # Odświeżenie czasu chroni świeżo użyty plik przed sprzątaniem osieroconych okładek.
            try:
                os.utime(target)
                return cover_id
            except FileNotFoundError:
                pass
        descriptor, temp_name = tempfile.mkstemp(prefix=_TEMP_PREFIX, suffix=_SUFFIX, dir=self.directory)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(jpeg_bytes)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_name, 0o644)
            os.replace(temp_name, target)
        except BaseException:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise
        return cover_id

    def gc(self, referenced: set[str], min_age_seconds: float = 86400) -> int:
        """Usuwa okładki, do których nic się nie odwołuje i które są starsze niż `min_age_seconds`."""
        cutoff = time.time() - min_age_seconds
        removed = 0
        try:
            entries = list(os.scandir(self.directory))
        except FileNotFoundError:
            return 0
        for entry in entries:
            name = entry.name
            if name.startswith(_TEMP_PREFIX):
                orphan = True  # pozostałość po przerwanym zapisie
            elif name.endswith(_SUFFIX) and self.is_valid_id(name[: -len(_SUFFIX)]):
                orphan = name[: -len(_SUFFIX)] not in referenced
            else:
                continue
            if not orphan:
                continue
            try:
                if not entry.is_file(follow_symlinks=False) or entry.stat().st_mtime > cutoff:
                    continue
                os.unlink(entry.path)
                removed += 1
            except FileNotFoundError:
                continue
            except OSError as error:
                _LOGGER.warning("Nie udało się usunąć okładki %s: %s", name, error)
        if removed:
            _LOGGER.info("Usunięto nieużywane okładki: %d", removed)
        return removed
