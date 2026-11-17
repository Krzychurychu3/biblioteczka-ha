// Okładki (CoverView), puste miejsca po tomach (PlaceholderCover) i awatary autorów.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { paletteIndex, personInitials, titleInitials } from '../core/palette.js';
import { Icon } from './icons.js';
import { coverFontSize } from './pure.js';

/** Szerokości okładek z aplikacji iOS (pt → px). */
export const COVER_SIZES = {
  xs: 34, // VolumeRow
  s: 38, // BookRow
  m: 42, // SeriesRow
  l: 68, // nagłówek serii
  xl: 72, // edytor książki
};

/** Adres zdjęcia okładki zapisanej na serwerze (względem `<base href>`). */
export function coverUrl(coverId) {
  return `api/covers/${encodeURIComponent(coverId)}.jpg`;
}

function widthOf(size, width) {
  if (Number.isFinite(width)) return width;
  if (Number.isFinite(size)) return size;
  return COVER_SIZES[size] ?? COVER_SIZES.m;
}

function safeIndex(seed) {
  try {
    return paletteIndex(String(seed ?? ''));
  } catch {
    return 0;
  }
}

/**
 * Okładka książki lub serii.
 * Cover({title, seed, label, coverId, src, size: 'xs'|'s'|'m'|'l'|'xl' (albo liczba), width,
 *        stack, dimmed, badge})
 * - `seed` wybiera gradient (domyślnie `title`), `label` – np. numer tomu (zamiast inicjałów tytułu);
 * - `coverId` – zdjęcie z serwera, `src` – dowolny adres (np. podgląd blob:);
 * - `stack` – seria jako stosik, `dimmed` – brakująca książka (szarość, 45 %);
 * - `badge` – element w prawym dolnym rogu (np. pieczęć „Seria kompletna”).
 */
export function Cover({ title, seed, label, coverId, src, size = 'm', width, stack = false, dimmed = false, badge, className = '' }) {
  const w = widthOf(size, width);
  const url = src || (coverId ? coverUrl(coverId) : null);
  // Stan wczytywania jest przypięty do adresu: zdarzenie `load` może przyjść (z pamięci podręcznej)
  // przed efektem po renderze, więc nie zerujemy go efektem, tylko porównujemy adresy.
  const [load, setLoad] = useState({ url: null, status: 'loading' });
  const state = !url ? 'none' : load.url === url ? load.status : 'loading';
  const imgRef = useRef(null);
  useEffect(() => {
    const img = imgRef.current;
    if (url && img && img.complete && img.naturalWidth > 0) setLoad({ url, status: 'loaded' });
  }, [url]);

  const hasLabel = label !== undefined && label !== null && label !== '';
  const text = hasLabel ? String(label) : titleInitials(title ?? seed ?? '');
  const showPhoto = url && state !== 'failed';
  const showText = !showPhoto || state !== 'loaded';
  const fontSize = coverFontSize(w, text, hasLabel).toFixed(2);
  const index = safeIndex(seed ?? title);

  return html`<span
    class=${`cover pal-${index} ${stack ? 'cover-stack' : ''} ${dimmed ? 'is-dimmed' : ''} ${showPhoto && state === 'loaded' ? 'has-photo' : ''} ${className}`}
    style=${`--w:${w}px`}
    aria-hidden=${badge ? undefined : 'true'}
  >
    ${stack &&
    html`<span class="cover-back cover-back-far" aria-hidden="true"></span
      ><span class="cover-back cover-back-near" aria-hidden="true"></span>`}
    <span class="cover-face" aria-hidden="true">
      ${showPhoto &&
      html`<img
        class="cover-img"
        src=${url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable=${false}
        ref=${imgRef}
        onLoad=${() => setLoad({ url, status: 'loaded' })}
        onError=${() => setLoad({ url, status: 'failed' })}
      />`}
      ${showText && html`<span class="cover-text" style=${`font-size:${fontSize}px`}>${text}</span>`}
    </span>
    ${badge && html`<span class="cover-badge">${badge}</span>`}
  </span>`;
}

/** Pieczęć „Seria kompletna” na okładce (przekazywana jako `badge`). */
export function CompleteBadge() {
  return html`<span class="seal-badge" role="img" aria-label="Seria kompletna">${Icon('seal')}</span>`;
}

/** Puste miejsce po tomie: przerywana ramka z numerem. */
export function PlaceholderCover({ label, size = 'xs', width }) {
  const w = widthOf(size, width);
  return html`<span class="cover-placeholder" style=${`--w:${w}px`} aria-hidden="true">
    <span class="cover-placeholder-text">${label}</span>
  </span>`;
}

/** Okrągły awatar autora z inicjałami (gradient z imienia i nazwiska). Rozmiary iOS: 32, 34, 42, 64. */
export function Avatar({ name, size = 42, className = '' }) {
  const index = safeIndex(name);
  return html`<span class=${`avatar pal-${index} ${className}`} style=${`--size:${size}px`} aria-hidden="true">
    <span class="avatar-text">${personInitials(name)}</span>
  </span>`;
}
