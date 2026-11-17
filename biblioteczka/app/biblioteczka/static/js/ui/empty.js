// Pusty stan ekranu (ContentUnavailableView) i przełącznik segmentowy.

import { html, useRef } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { Button } from './buttons.js';
import { uid } from './a11y.js';

function renderAction(action, variant) {
  if (!action) return null;
  if (action.label !== undefined && !action.type) {
    return html`<${Button} variant=${action.variant || variant} size=${action.size || 'l'} icon=${action.icon} onClick=${action.onClick}>
      ${action.label}
    <//>`;
  }
  return action;
}

/**
 * EmptyState({icon, title, message, action, secondaryAction, children, compact})
 * `action` / `secondaryAction`: `{label, onClick, icon?}` (przycisk wyróżniony / z obwódką)
 * albo gotowy element. `children` – dodatkowa treść pod przyciskami.
 */
export function EmptyState({ icon, title, message, action, secondaryAction, children, compact = false, className = '' }) {
  return html`<div class=${`empty-state ${compact ? 'is-compact' : ''} ${className}`} role="region" aria-label=${title}>
    ${icon && html`<span class="empty-icon" aria-hidden="true">${Icon(icon)}</span>`}
    ${title && html`<h2 class="empty-title">${title}</h2>`}
    ${message && html`<p class="empty-message">${message}</p>`}
    ${(action || secondaryAction) &&
    html`<div class="empty-actions">
      ${renderAction(action, 'prominent')} ${renderAction(secondaryAction, 'bordered')}
    </div>`}
    ${children}
  </div>`;
}

/**
 * Segmented({options, value, onChange, label})
 * `options`: tablica napisów albo `{value, label}`. Strzałki zmieniają wybór (radiogroup).
 */
export function Segmented({ options = [], value, onChange, label, className = '' }) {
  const name = useRef(uid('seg')).current;
  const items = options.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  const index = Math.max(0, items.findIndex((o) => o.value === value));

  const select = (i, focus) => {
    const item = items[(i + items.length) % items.length];
    if (!item) return;
    if (item.value !== value) onChange?.(item.value);
    if (focus) {
      // Fokus na opcji zaznaczonej po przerysowaniu – także gdy rodzic nie przyjął zmiany (radiogroup:
      // fokus i zaznaczenie zawsze razem).
      requestAnimationFrame(() => {
        const chosen = document.getElementById(`${name}-${items.indexOf(item)}`);
        const checked = chosen?.parentElement?.querySelector('[role="radio"][aria-checked="true"]');
        (checked || chosen)?.focus();
      });
    }
  };

  const onKeyDown = (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (event.key in keys) {
      event.preventDefault();
      select(index + keys[event.key], true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(0, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(items.length - 1, true);
    }
  };

  return html`<div
    class=${`segmented ${className}`}
    role="radiogroup"
    aria-label=${label}
    style=${`--count:${items.length || 1};--index:${index}`}
    onKeyDown=${onKeyDown}
  >
    <span class="segmented-thumb" aria-hidden="true"></span>
    ${items.map(
      (item, i) => html`<button
        type="button"
        key=${String(item.value)}
        id=${`${name}-${i}`}
        class=${`segment ${i === index ? 'is-selected' : ''}`}
        role="radio"
        aria-checked=${i === index ? 'true' : 'false'}
        tabindex=${i === index ? '0' : '-1'}
        onClick=${() => select(i, false)}
      >
        ${item.label}
      </button>`,
    )}
  </div>`;
}
