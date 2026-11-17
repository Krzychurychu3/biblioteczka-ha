#!/usr/bin/env python3
"""Tworzy icon.png (128×128) i logo.png (250×100) aplikacji HA z ikony aplikacji iOS.

Uruchamianie (z katalogu głównego repozytorium):  .venv/bin/python tools/make_icons.py [--source IKONA.png]
Wymaga Pillow i czcionki systemowej macOS (SF Pro, awaryjnie Avenir Next / Helvetica Neue).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HA_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = HA_DIR.parent
SOURCE_ICON = REPO_DIR / "Biblioteczka" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon.png"
APP_DIR = HA_DIR / "biblioteczka"

ICON_SIZE = 128
LOGO_SIZE = (250, 100)
SCALE = 4  # rysowanie w powiększeniu i zmniejszanie = gładkie krawędzie
# Promień zaokrąglenia jak w masce ikon iOS (~22,4% boku).
CORNER_RATIO = 0.2237
WORDMARK = "Biblioteczka"
# Fiolet pomiędzy jasnym (#5B4BE8) i ciemnym (#8E84FF) wariantem AccentColor z aplikacji iOS:
# kontrast ok. 4:1 zarówno na jasnym, jak i na ciemnym motywie Home Assistanta.
WORDMARK_COLOR = (115, 100, 240, 255)

# (plik, indeks w kolekcji .ttc, nazwa wariantu fontu zmiennego)
FONT_CANDIDATES = [
    ("/System/Library/Fonts/SFNS.ttf", 0, b"Bold"),
    ("/System/Library/Fonts/Avenir Next.ttc", 0, None),  # Bold
    ("/System/Library/Fonts/HelveticaNeue.ttc", 1, None),  # Bold
    ("/Library/Fonts/Arial Bold.ttf", 0, None),
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0, None),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    """Pierwsza dostępna pogrubiona czcionka systemowa w danym rozmiarze."""
    for path, index, variation in FONT_CANDIDATES:
        if not Path(path).exists():
            continue
        try:
            font = ImageFont.truetype(path, size, index=index)
            if variation is not None:
                font.set_variation_by_name(variation)
            return font
        except (OSError, ValueError):
            continue
    raise SystemExit("Nie znaleziono żadnej z czcionek: " + ", ".join(p for p, _, _ in FONT_CANDIDATES))


def rounded(source: Image.Image, side: int) -> Image.Image:
    """Grafika ikony w rozmiarze side×side z maską zaokrąglonych rogów."""
    art = source.convert("RGBA").resize((side, side), Image.Resampling.LANCZOS)
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, side - 1, side - 1), radius=round(side * CORNER_RATIO), fill=255
    )
    art.putalpha(mask)
    return art


def rounded_icon(source: Image.Image, size: int) -> Image.Image:
    """Ikona size×size z gładko zaokrąglonymi rogami i przezroczystym tłem."""
    return downscale(rounded(source, size * SCALE), (size, size))


def downscale(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Zmniejsza obraz RGBA z premultiplikacją alfy (bez ciemnych obwódek)."""
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def make_logo(source: Image.Image) -> Image.Image:
    """Ikona + napis „Biblioteczka” na przezroczystym tle, ok. 250×100."""
    width, height = LOGO_SIZE[0] * SCALE, LOGO_SIZE[1] * SCALE
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    icon_side = 84 * SCALE
    margin = (height - icon_side) // 2
    canvas.alpha_composite(rounded(source, icon_side), (margin, margin))

    # Największy rozmiar napisu, który mieści się obok ikony.
    text_x = margin + icon_side + 10 * SCALE
    max_width = width - text_x - 4 * SCALE
    max_height = 40 * SCALE
    size = max_height
    while size > 8:
        font = load_font(size)
        left, top, right, bottom = font.getbbox(WORDMARK)
        if right - left <= max_width and bottom - top <= max_height:
            break
        size -= SCALE
    else:
        raise SystemExit("Napis nie mieści się w logo.")

    draw = ImageDraw.Draw(canvas)
    # Wyśrodkowanie w pionie według rzeczywistego obrysu liter (z „j” poniżej linii).
    y = (height - (bottom - top)) // 2 - top
    draw.text((text_x - left, y), WORDMARK, font=font, fill=WORDMARK_COLOR)

    return downscale(canvas, LOGO_SIZE)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=SOURCE_ICON, help="ikona źródłowa (PNG)")
    parser.add_argument("--out", type=Path, default=APP_DIR, help="katalog docelowy")
    args = parser.parse_args(argv)

    if not args.source.is_file():
        print(f"Brak pliku ikony: {args.source}", file=sys.stderr)
        return 1
    with Image.open(args.source) as opened:
        opened.load()
        source = opened.copy()

    args.out.mkdir(parents=True, exist_ok=True)
    icon = rounded_icon(source, ICON_SIZE)
    icon.save(args.out / "icon.png", optimize=True)
    logo = make_logo(source)
    logo.save(args.out / "logo.png", optimize=True)
    print(f"Zapisano {args.out / 'icon.png'} {icon.size} i {args.out / 'logo.png'} {logo.size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
