// Dekoracyjna ramka celownika skanera (iOS: 270×150, zaokrąglenie 22, kreska 26/12).
// Użycie w skanerze: wewnątrz `.scanner` obok `<video class="scanner-video">`.

import { html } from '../../vendor/preact-htm.js';

export function Viewfinder({ width = 270, height = 150 }) {
  return html`<div class="scanner-frame" style=${`--vf-w:${width}px;--vf-h:${height}px`} aria-hidden="true">
    <svg viewBox=${`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <rect
        x="1.5"
        y="1.5"
        width=${width - 3}
        height=${height - 3}
        rx="22"
        ry="22"
        fill="none"
        stroke="rgba(255,255,255,.85)"
        stroke-width="3"
        stroke-dasharray="26 12"
        stroke-linecap="round"
      />
    </svg>
  </div>`;
}
