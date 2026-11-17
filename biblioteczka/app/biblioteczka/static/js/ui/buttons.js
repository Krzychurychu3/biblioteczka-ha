// Przyciski w stylu iOS: wyróżniony (kapsuła w kolorze akcentu), z obwódką, zwykły, ikonowy.

import { html } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';

/** Kręciołek aktywności (ProgressView). */
export function Spinner({ size = 20, label, className = '' }) {
  return html`<span
    class=${`spinner ${className}`}
    style=${`--spinner-size:${size}px`}
    role=${label ? 'status' : undefined}
    aria-label=${label || undefined}
    aria-hidden=${label ? undefined : 'true'}
  ></span>`;
}

/**
 * Przycisk. `variant`: 'prominent' | 'bordered' | 'plain' | 'destructive';
 * `size`: 's' | 'm' | 'l'; `full` – na całą szerokość; `icon` – nazwa ikony z lewej;
 * `busy` – kręciołek zamiast ikony i blokada.
 */
export function Button({
  variant = 'bordered',
  size = 'm',
  icon,
  full = false,
  busy = false,
  disabled = false,
  type = 'button',
  onClick,
  children,
  label,
  className = '',
  ...rest
}) {
  const classes = ['btn', `btn-${variant}`, `btn-${size}`, full ? 'btn-full' : '', className].join(' ');
  return html`<button
    type=${type}
    class=${classes}
    disabled=${disabled || busy}
    aria-busy=${busy ? 'true' : undefined}
    onClick=${onClick}
    ...${rest}
  >
    ${busy ? html`<${Spinner} size=${16} />` : icon ? Icon(icon) : null}
    <span class="btn-label">${children ?? label}</span>
  </button>`;
}

/**
 * Przycisk z samą ikoną (pasek nawigacji, wiersze). `label` jest wymagane –
 * staje się etykietą dostępności i podpowiedzią.
 */
export function IconButton({ icon, label, onClick, disabled = false, tint, className = '', size, ...rest }) {
  return html`<button
    type="button"
    class=${`icon-btn ${tint ? `tint-${tint}` : ''} ${className}`}
    aria-label=${label}
    title=${label}
    disabled=${disabled}
    onClick=${onClick}
    ...${rest}
  >
    ${Icon(icon, { size })}
  </button>`;
}

/** Przycisk paska nawigacji: ikona w kółku (styl iOS 26). */
export function ToolbarButton(props) {
  return IconButton({ ...props, className: `toolbar-btn ${props.className || ''}` });
}
