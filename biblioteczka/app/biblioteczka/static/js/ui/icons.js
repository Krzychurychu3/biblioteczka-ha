// Zestaw ikon (inline SVG, siatka 24×24) odpowiadających symbolom SF z aplikacji iOS.
// Ikony konturowe dziedziczą kolor tekstu (`currentColor`), warianty „-fill” są pełne.
// Użycie: Icon('book'), Icon('trash', {size: 20, label: 'Usuń'}) albo <${Icon} name="book"/>.

import { html } from '../../vendor/preact-htm.js';

// Wnętrze białych znaków na pełnych ikonach (koło z ptaszkiem itd.).
const ON = 'class="i-on"';

function sealPath() {
  // Pieczęć (checkmark.seal.fill): wielokąt z falistą krawędzią.
  const points = [];
  const teeth = 12;
  for (let i = 0; i < teeth * 2; i += 1) {
    const angle = (Math.PI * i) / teeth - Math.PI / 2;
    const radius = i % 2 === 0 ? 10.2 : 8.6;
    points.push(`${(12 + radius * Math.cos(angle)).toFixed(2)} ${(12 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

function gearPath() {
  const points = [];
  const teeth = 8;
  for (let i = 0; i < teeth; i += 1) {
    const base = (Math.PI * 2 * i) / teeth;
    for (const [offset, radius] of [[-0.24, 7.2], [-0.15, 9.6], [0.15, 9.6], [0.24, 7.2]]) {
      const angle = base + offset;
      points.push(`${(12 + radius * Math.cos(angle)).toFixed(2)} ${(12 + radius * Math.sin(angle)).toFixed(2)}`);
    }
  }
  return `M${points.join('L')}Z`;
}

const filledCircle = (inner) => `<circle cx="12" cy="12" r="10" class="i-fill"/>${inner}`;

const ICONS = {
  // Książki, serie, osoby
  book: '<path d="M6.5 3H18a1 1 0 0 1 1 1v13H6.5a2 2 0 0 0-2 2V5a2 2 0 0 1 2-2Z"/><path d="M4.5 19a2 2 0 0 0 2 2H19v-4"/><path d="M8.5 3v14"/>',
  'book-fill': '<path class="i-fill" d="M6.5 2.5H18A1.5 1.5 0 0 1 19.5 4v12.5H6.5A2.5 2.5 0 0 0 4 18.6V5a2.5 2.5 0 0 1 2.5-2.5Z"/><path d="M4.75 19.2a1.8 1.8 0 0 0 1.8 1.8H19.5"/>',
  'book-text': '<path d="M6.5 3H18a1 1 0 0 1 1 1v13H6.5a2 2 0 0 0-2 2V5a2 2 0 0 1 2-2Z"/><path d="M4.5 19a2 2 0 0 0 2 2H19v-4"/><path d="M9.5 7.5h6M9.5 11h4"/>',
  books: '<rect x="3.5" y="4" width="4.5" height="16" rx="1"/><rect x="9.5" y="4" width="4.5" height="16" rx="1"/><rect x="15.3" y="4.4" width="4.3" height="15.6" rx="1" transform="rotate(-13 17.45 12.2)"/><path d="M3.5 8h4.5M9.5 8h4.5"/>',
  'books-fill': '<rect class="i-fill" x="3" y="3.5" width="5" height="17" rx="1.2"/><rect class="i-fill" x="9.3" y="3.5" width="5" height="17" rx="1.2"/><rect class="i-fill" x="15.4" y="4" width="4.6" height="16.4" rx="1.2" transform="rotate(-13 17.7 12.2)"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>',
  'person-fill': '<circle class="i-fill" cx="12" cy="7.8" r="4.3"/><path class="i-fill" d="M3.8 20.2c0-4.4 3.7-7.2 8.2-7.2s8.2 2.8 8.2 7.2a.8.8 0 0 1-.8.8H4.6a.8.8 0 0 1-.8-.8Z"/>',
  persons: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="16.8" cy="8.6" r="2.8"/><path d="M17.5 13.6c2.6.3 4.3 2.4 4.3 5.4"/>',
  'persons-fill': '<circle class="i-fill" cx="9" cy="7.8" r="3.8"/><path class="i-fill" d="M2 19.4c0-3.9 3.1-6.4 7-6.4s7 2.5 7 6.4a.6.6 0 0 1-.6.6H2.6a.6.6 0 0 1-.6-.6Z"/><circle class="i-fill" cx="17" cy="8.4" r="3"/><path class="i-fill" d="M17.6 13.2c2.7.2 4.6 2.3 4.6 5.6a.6.6 0 0 1-.6.6h-4.2a8 8 0 0 0-1.8-5.8 5 5 0 0 1 2-.4Z"/>',
  'person-plus': '<circle cx="10" cy="8" r="3.8"/><path d="M3 20c0-3.8 3.1-6.3 7-6.3 1.6 0 3 .4 4.2 1.1"/><path d="M18.5 14v6M15.5 17h6"/>',
  series: '<rect x="3.5" y="4" width="4.5" height="16" rx="1"/><rect x="9.5" y="4" width="4.5" height="16" rx="1"/><rect x="15.3" y="4.4" width="4.3" height="15.6" rx="1" transform="rotate(-13 17.45 12.2)"/><path d="M3.5 8h4.5M9.5 8h4.5"/>',

  // Nawigacja i akcje
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  ellipsis: '<circle class="i-fill" cx="5.5" cy="12" r="1.7"/><circle class="i-fill" cx="12" cy="12" r="1.7"/><circle class="i-fill" cx="18.5" cy="12" r="1.7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  xmark: '<path d="M6 6l12 12M18 6 6 18"/>',
  circle: '<circle cx="12" cy="12" r="9.2"/>',
  'check-circle': filledCircle(`<path ${ON} d="m7.6 12.4 3 3 5.9-6.4"/>`),
  'xmark-circle': filledCircle(`<path ${ON} d="m8.7 8.7 6.6 6.6M15.3 8.7l-6.6 6.6"/>`),
  'plus-circle': filledCircle(`<path ${ON} d="M12 7.5v9M7.5 12h9"/>`),
  'minus-circle': '<circle cx="12" cy="12" r="9.2"/><path d="M8 12h8"/>',
  'download-circle': filledCircle(`<path ${ON} d="M12 7v9M8.3 12.5 12 16.2l3.7-3.7"/>`),
  'question-circle': filledCircle(`<path ${ON} d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.6.3-1 .8-1 1.5v.6M12 17h.01"/>`),
  'number-circle': filledCircle(`<path ${ON} d="M10.2 7.5 9.3 16.5M14.7 7.5l-.9 9M7.8 10.2h9M7.3 13.8h9"/>`),
  'info-circle': filledCircle(`<path ${ON} d="M12 11v5.5M12 7.6h.01"/>`),
  seal: `<path class="i-fill" stroke-linejoin="round" d="${sealPath()}"/><path ${ON} d="m8.3 12.2 2.6 2.6 4.9-5.3"/>`,
  'arrow-up-left': '<path d="M17 17 7 7M7 15V7h8"/>',
  sort: '<path d="M7.5 20V4M4 7.5 7.5 4 11 7.5M16.5 4v16M13 16.5l3.5 3.5 3.5-3.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.5v4.2h-4.2"/>',
  merge: '<path d="M6 3.5v4c0 3.2 6 4.6 6 8.5v4.5M18 3.5v4c0 3.2-6 4.6-6 8.5"/><path d="M3.6 5.9 6 3.5l2.4 2.4M15.6 5.9 18 3.5l2.4 2.4"/>',
  'stack-plus': '<rect x="8" y="8" width="13" height="13" rx="2.2"/><path d="M16 8V5.2A2.2 2.2 0 0 0 13.8 3H5.2A2.2 2.2 0 0 0 3 5.2v8.6A2.2 2.2 0 0 0 5.2 16H8M14.5 11.5v6M11.5 14.5h6"/>',
  pencil: '<path d="M15.6 4.4a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L8.4 19.6 4 20.5l.9-4.4Z"/><path d="m13.8 6.2 4 4"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.8c0-.4.3-.8.8-.8h3.4c.5 0 .8.4.8.8v1.7M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4l1-13M10 10.5v6M14 10.5v6"/>',
  export: '<path d="M8.5 9.5H7A1.5 1.5 0 0 0 5.5 11v8.5A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V11A1.5 1.5 0 0 0 17 9.5h-1.5"/><path d="M12 3v11M8.5 6.5 12 3l3.5 3.5"/>',
  import: '<path d="M8.5 9.5H7A1.5 1.5 0 0 0 5.5 11v8.5A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V11A1.5 1.5 0 0 0 17 9.5h-1.5"/><path d="M12 3v11M8.5 10.5 12 14l3.5-3.5"/>',
  'download-fill': '<path class="i-fill" d="M7 9.5h3V14a2 2 0 0 0 4 0V9.5h3a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 17 21H7a1.5 1.5 0 0 1-1.5-1.5V11A1.5 1.5 0 0 1 7 9.5Z"/><path d="M12 3v10.5M9 10.5l3 3 3-3"/>',
  sparkles: '<path d="M10 3.5 11.6 8l4.4 1.6-4.4 1.6L10 15.6 8.4 11.2 4 9.6 8.4 8Z"/><path d="m17.5 13.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6 9.8h.01M9.3 9.8h.01M12.6 9.8h.01M15.9 9.8h.01M6 13.2h.01M18 9.8h.01M18 13.2h.01M8.8 14.3h6.4"/>',
  warning: `<path class="i-fill" stroke-linejoin="round" d="M10.4 4a1.8 1.8 0 0 1 3.2 0l7.6 13.6a1.8 1.8 0 0 1-1.6 2.7H4.4a1.8 1.8 0 0 1-1.6-2.7Z"/><path ${ON} d="M12 9.2v4.6M12 16.9h.01"/>`,
  cart: '<path d="M3 4h2.2l2.1 10.4a1.6 1.6 0 0 0 1.6 1.3h8.3a1.6 1.6 0 0 0 1.5-1.1L20.6 8H6.1"/><circle class="i-fill" cx="9.6" cy="19.6" r="1.4"/><circle class="i-fill" cx="17" cy="19.6" r="1.4"/>',
  'cart-fill': '<path class="i-fill" d="M2.3 3.8c0-.5.4-.8.8-.8h2.1c.6 0 1.1.4 1.2 1l.3 1.5h14.2c.6 0 1 .5.9 1.1l-1.3 6.9a2 2 0 0 1-2 1.6H8.4l.3 1.4h9.9a.9.9 0 0 1 0 1.8H8c-.5 0-.9-.3-1-.8L4.6 4.7H3.1a.8.8 0 0 1-.8-.9Z"/><circle class="i-fill" cx="9.4" cy="20.2" r="1.5"/><circle class="i-fill" cx="17.4" cy="20.2" r="1.5"/>',
  party: '<path d="M4 20.2 8.6 8.1l7.3 7.3Z"/><path d="M13.8 4.2c.6 1.6.1 3.1-1.4 4.2M19.8 10.2c-1.6-.5-3.1-.1-4.2 1.4M17 3.5v.01M20.5 6.5v.01M20.4 14.6v.01M10.5 13.5l-1.6 4"/>',
  hourglass: '<path d="M6.5 3h11M6.5 21h11M7.5 3c0 4.6 4.5 6 4.5 9s-4.5 4.4-4.5 9M16.5 3c0 4.6-4.5 6-4.5 9s4.5 4.4 4.5 9"/>',
  textformat: '<path d="M2.5 18 7 6l4.5 12M4.2 14h5.6"/><path d="M14.4 11.6c.6-.8 1.5-1.3 2.7-1.3 1.9 0 3.1 1.1 3.1 3V18M20.2 14.8c-.8-.3-1.8-.4-2.8-.3-1.5.2-2.6 1-2.6 2.1s.9 1.6 2.1 1.6c1.5 0 2.7-.9 3.3-2.1"/>',
  clock: '<circle cx="12" cy="12" r="9.2"/><path d="M12 7v5.2l3.3 2"/>',

  // Aparat, zdjęcia, kody
  barcode: '<path d="M3 7.5V5.2A2.2 2.2 0 0 1 5.2 3h2.3M16.5 3h2.3A2.2 2.2 0 0 1 21 5.2v2.3M21 16.5v2.3a2.2 2.2 0 0 1-2.2 2.2h-2.3M7.5 21H5.2A2.2 2.2 0 0 1 3 18.8v-2.3"/><path d="M7 8v8M9.6 8v8M12 8v8M14.6 8v8M17 8v8"/>',
  camera: '<path d="M4 8.2a2 2 0 0 1 2-2h1.7l1.5-2.2h5.6l1.5 2.2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.4"/>',
  'camera-fill': `<path class="i-fill" d="M3.5 8.4a2.4 2.4 0 0 1 2.4-2.4h1.5l1.4-2c.3-.4.8-.6 1.3-.6h3.8c.5 0 1 .2 1.3.6l1.4 2h1.5a2.4 2.4 0 0 1 2.4 2.4v8.8a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4Z"/><circle ${ON} cx="12" cy="12.8" r="3.3"/>`,
  'camera-slash': '<path d="M4 8.2a2 2 0 0 1 2-2h1.2M10 4h4.8l1.5 2.2H18a2 2 0 0 1 2 2v8.3M18.4 19H6a2 2 0 0 1-2-2V8.6"/><path d="M10 10.4a3.4 3.4 0 0 0 4.6 4.6M3 3l18 18"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><circle cx="8.6" cy="10" r="1.6"/><path d="m21 15.2-4.6-4.6L8 19"/>',
  'wifi-slash': '<path d="M2.5 9a14 14 0 0 1 4.3-2.7M10 5.2A14 14 0 0 1 21.5 9M5.5 12.5a9.5 9.5 0 0 1 3.8-2.3M14.8 10.4a9.5 9.5 0 0 1 3.7 2.1M8.8 16a5 5 0 0 1 6.4 0M12 19.5h.01M3.5 3.5l17 17"/>',
  gear: `<path stroke-linejoin="round" d="${gearPath()}"/><circle cx="12" cy="12" r="3"/>`,
};

/** Nazwy dostępnych ikon. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Ikona SVG. `Icon('book')`, `Icon('book', {size, label, className})` albo jako komponent
 * `<${Icon} name="book" size=${20}/>`. Bez `label` ikona jest dekoracyjna (aria-hidden).
 */
export function Icon(nameOrProps, options = {}) {
  const props = typeof nameOrProps === 'string' ? { ...options, name: nameOrProps } : nameOrProps || {};
  const { name, size, label, className = '', class: cls = '' } = props;
  const markup = ICONS[name];
  if (!markup) {
    console.warn(`Brak ikony „${name}”`);
    return null;
  }
  const style = size ? `width:${size}px;height:${size}px` : undefined;
  return html`<svg
    class=${`icon icon-${name} ${className} ${cls}`.trim()}
    viewBox="0 0 24 24"
    style=${style}
    role=${label ? 'img' : undefined}
    aria-label=${label || undefined}
    aria-hidden=${label ? undefined : 'true'}
    focusable="false"
    dangerouslySetInnerHTML=${{ __html: markup }}
  ></svg>`;
}
