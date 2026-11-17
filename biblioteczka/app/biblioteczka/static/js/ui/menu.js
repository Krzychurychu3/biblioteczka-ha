// Menu wyskakujące (iOS Menu / menu kontekstowe).
//
// Pozycje: {label, icon, onClick, disabled, role: 'destructive', checked, hidden, subtitle}
// oraz {divider: true} (przerwa między grupami) i {header: 'Sortowanie'} (nagłówek grupy).
// Fałszywe wartości na liście są pomijane, więc można pisać `warunek && {...}`.

import { html, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { openLayer, useLayer } from './overlay.js';
import { Icon } from './icons.js';
import { placeMenu } from './pure.js';

function normalizeItems(items) {
  const list = (typeof items === 'function' ? items() : items) || [];
  const visible = list.filter((item) => item && !item.hidden);
  // Bez podwójnych, początkowych i końcowych separatorów.
  const result = [];
  for (const item of visible) {
    if (item.divider && (!result.length || result[result.length - 1].divider)) continue;
    result.push(item);
  }
  while (result.length && result[result.length - 1].divider) result.pop();
  return result;
}

function MenuPopover({ anchor, point, items, label, align, focusFirst }) {
  const layer = useLayer();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const hasChecks = items.some((item) => item.checked !== undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    const rect = point
      ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
      : anchor && anchor.isConnected
        ? anchor.getBoundingClientRect()
        : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3 };
    const size = { width: el.offsetWidth, height: el.scrollHeight };
    const place = placeMenu(rect, size, { width: innerWidth, height: innerHeight }, {
      align: point ? 'start' : align,
      gap: point ? 2 : 6,
    });
    setPos(place);
  }, []);

  useLayoutEffect(() => {
    if (!pos) return;
    const items = ref.current.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])');
    if (focusFirst && items.length) items[0].focus({ preventScroll: true });
    else ref.current.focus({ preventScroll: true });
  }, [pos]);

  // Przewinięcie strony lub zmiana rozmiaru okna zamyka menu.
  useLayoutEffect(() => {
    const close = (event) => {
      if (event.type === 'scroll' && ref.current && ref.current.contains(event.target)) return;
      layer.close();
    };
    addEventListener('resize', close);
    addEventListener('scroll', close, true);
    return () => {
      removeEventListener('resize', close);
      removeEventListener('scroll', close, true);
    };
  }, []);

  const activate = (item) => {
    if (item.disabled || layer.closing) return;
    layer.close();
    try {
      item.onClick?.();
    } catch (error) {
      console.error(error);
    }
  };

  const onKeyDown = (event) => {
    const nodes = [...ref.current.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')];
    const index = nodes.indexOf(document.activeElement);
    const move = (to) => {
      event.preventDefault();
      if (nodes.length) nodes[(to + nodes.length) % nodes.length].focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index < 0 ? nodes.length - 1 : index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(nodes.length - 1);
        break;
      case 'Tab':
        layer.close();
        break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          // Skok do pozycji zaczynającej się od wpisanej litery.
          const key = event.key.toLocaleLowerCase('pl');
          const start = index + 1;
          for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[(start + i) % nodes.length];
            if (node.textContent.trim().toLocaleLowerCase('pl').startsWith(key)) {
              event.preventDefault();
              node.focus();
              break;
            }
          }
        }
    }
  };

  const style = pos
    ? `left:${pos.left}px;top:${pos.top}px;max-height:${pos.maxHeight}px;transform-origin:${pos.originX} ${pos.originY}`
    : 'left:0;top:0;visibility:hidden';

  return html`<div
    class=${`menu ${pos ? 'is-placed' : ''}`}
    role="menu"
    aria-label=${label || undefined}
    tabindex="-1"
    ref=${ref}
    style=${style}
    onKeyDown=${onKeyDown}
  >
    ${items.map((item, i) => {
      if (item.divider) return html`<div key=${'d' + i} class="menu-divider" role="separator"></div>`;
      if (item.header) return html`<div key=${'h' + i} class="menu-header" role="presentation">${item.header}</div>`;
      const checkable = item.checked !== undefined;
      return html`<button
        key=${i}
        type="button"
        class=${`menu-item ${item.role === 'destructive' ? 'is-destructive' : ''} ${hasChecks ? 'has-check-col' : ''}`}
        role=${checkable ? 'menuitemradio' : 'menuitem'}
        aria-checked=${checkable ? String(Boolean(item.checked)) : undefined}
        aria-disabled=${item.disabled ? 'true' : undefined}
        tabindex="-1"
        onClick=${() => activate(item)}
      >
        ${hasChecks && html`<span class="menu-check" aria-hidden="true">${item.checked ? Icon('check') : null}</span>`}
        <span class="menu-text">
          <span class="menu-label">${item.label}</span>
          ${item.subtitle && html`<span class="menu-subtitle">${item.subtitle}</span>`}
        </span>
        ${item.icon ? Icon(item.icon, { className: 'menu-icon' }) : null}
      </button>`;
    })}
  </div>`;
}

/**
 * Otwiera menu przy elemencie `anchor` albo w punkcie `point: {x, y}` (menu kontekstowe).
 * `align`: 'end' (prawa krawędź kotwicy, domyślnie) albo 'start'. Zwraca uchwyt `{close}`
 * albo `null`, gdy lista pozycji jest pusta.
 */
export function openMenu({ anchor, point, items, label, align = 'end', focusFirst = false, onClose }) {
  const list = normalizeItems(items);
  if (!list.length) return null;
  return openLayer({
    kind: 'menu',
    modal: false,
    dismissOnBackdrop: true,
    onClose,
    render: () => html`<${MenuPopover}
      anchor=${anchor}
      point=${point}
      items=${list}
      label=${label}
      align=${align}
      focusFirst=${focusFirst}
    />`,
  });
}

/**
 * Przycisk otwierający menu. `trigger` – zawartość przycisku (domyślnie ikona „…”),
 * `label` – etykieta dostępności (np. „Dodaj”, „Więcej”), `items` – tablica albo funkcja
 * zwracająca tablicę (wywoływana przy każdym otwarciu, więc zawsze ma świeże dane).
 */
export function Menu({ trigger, label, items, align = 'end', disabled = false, className = 'toolbar-btn', title }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);

  const show = (focusFirst) => {
    if (open) return;
    const handle = openMenu({
      anchor: ref.current,
      items,
      label,
      align,
      focusFirst,
      onClose: () => setOpen(false),
    });
    if (handle) setOpen(true);
  };

  return html`<button
    ref=${ref}
    type="button"
    class=${`menu-trigger ${className}`}
    aria-label=${label}
    title=${title ?? label}
    aria-haspopup="menu"
    aria-expanded=${open ? 'true' : 'false'}
    disabled=${disabled}
    onClick=${(event) => show(event.detail === 0)}
    onKeyDown=${(event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        show(true);
      }
    }}
  >
    ${trigger ?? Icon('ellipsis')}
  </button>`;
}
