// Pasek postępu kompletowania serii i kafelki statystyk.

import { html } from '../../vendor/preact-htm.js';
import { paletteIndex } from '../core/palette.js';
import { Icon } from './icons.js';
import { useChangePulse } from './a11y.js';

/**
 * ProgressBar({fraction, complete, seed, tint, height=6})
 * Kolor: zielony, gdy seria kompletna; w przeciwnym razie końcowy kolor gradientu serii (`seed`)
 * albo podany `tint` ('accent', 'green', 'orange', 'indigo', 'red'). Pusty pasek bez wypełnienia.
 */
export function ProgressBar({ fraction = 0, complete = false, seed, tint, height = 6, className = '' }) {
  const value = Math.min(Math.max(Number(fraction) || 0, 0), 1);
  const percent = Math.round(value * 100);
  let tintClass = 'tint-accent';
  if (complete) tintClass = 'tint-green';
  else if (tint) tintClass = `tint-${tint}`;
  else if (seed !== undefined && seed !== null) {
    let index = 0;
    try {
      index = paletteIndex(String(seed));
    } catch {
      index = 0;
    }
    tintClass = `pal-${index} tint-palette`;
  }
  return html`<div
    class=${`progress ${tintClass} ${className}`}
    style=${`--h:${height}px;--f:${value}`}
    role="progressbar"
    aria-label="Postęp"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${percent}
    aria-valuetext=${`${percent} %`}
  >
    ${value > 0 && html`<span class="progress-fill"></span>`}
  </div>`;
}

/** Pojedynczy kafelek: ikona w kółku, liczba, podpis. `tint`: 'indigo' | 'green' | 'orange' | … */
export function StatTile({ value, title, icon, tint = 'accent' }) {
  const text = Number.isFinite(value) ? value.toLocaleString('pl-PL') : String(value ?? '');
  const pulse = useChangePulse(text);
  return html`<div class=${`stat-tile tint-${tint}`} role="group" aria-label=${`${title}: ${text}`}>
    <span class="stat-icon" aria-hidden="true">${Icon(icon)}</span>
    <span class=${`stat-value ${pulse ? 'is-pulsing' : ''}`} aria-hidden="true">${text}</span>
    <span class="stat-title" aria-hidden="true">${title}</span>
  </div>`;
}

/**
 * StatTiles({tiles: [{value, title, icon, tint}], label})
 * Rząd równych kafelków (iOS LibraryStatsView: „Na półce”, „Pełne serie”, „Brakuje”).
 */
export function StatTiles({ tiles = [], label = 'Statystyki biblioteczki' }) {
  return html`<div class="stat-tiles" role="list" aria-label=${label} style=${`--count:${tiles.length || 1}`}>
    ${tiles.map((tile) => html`<div role="listitem" key=${tile.title}><${StatTile} ...${tile} /></div>`)}
  </div>`;
}
