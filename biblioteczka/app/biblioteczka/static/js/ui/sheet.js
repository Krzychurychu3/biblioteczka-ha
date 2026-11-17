// Arkusz modalny z paskiem „Anuluj – tytuł – Zapisz” (jak formularze iOS).
// Na telefonie wysuwa się od dołu na prawie całą wysokość, od 700 px szerokości
// to wyśrodkowana karta. Esc = Anuluj, Ctrl/⌘+Enter = Zapisz.

import { html, useEffect, useRef } from '../../vendor/preact-htm.js';
import { useLayer } from './overlay.js';
import { Spinner } from './buttons.js';
import { uid } from './a11y.js';

/**
 * Sheet({title, onCancel, onSave, saveLabel='Zapisz', saveDisabled, busy, cancelLabel='Anuluj',
 *        leading, trailing, variant, children})
 * - `onCancel` domyślnie zamyka warstwę; `onSave` brak → bez przycisku po prawej.
 * - `busy` – zapis w toku: kręciołek zamiast „Zapisz”, przyciski zablokowane.
 * - `leading` / `trailing` – własna zawartość boków paska (zamiast Anuluj/Zapisz).
 * - `variant`: 'form' (domyślnie, tło grupowane), 'plain', 'camera' (pełnoekranowy podgląd,
 *   przezroczysty pasek z jasną treścią).
 */
export function Sheet({
  title,
  onCancel,
  onSave,
  saveLabel = 'Zapisz',
  saveDisabled = false,
  busy = false,
  cancelLabel = 'Anuluj',
  leading,
  trailing,
  variant = 'form',
  className = '',
  children,
}) {
  const layer = useLayer();
  const titleId = useRef(uid('sheet-title')).current;
  const handlers = useRef({});
  handlers.current = { onCancel, onSave, saveDisabled, busy };

  const cancel = () => {
    const h = handlers.current;
    if (h.busy) return;
    if (h.onCancel) h.onCancel();
    else layer?.close();
  };
  const save = () => {
    const h = handlers.current;
    if (h.onSave && !h.saveDisabled && !h.busy) h.onSave();
  };

  useEffect(() => {
    layer?.setEscape(cancel);
    return () => layer?.setEscape(null);
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      save();
    }
  };

  const leadingNode =
    leading !== undefined
      ? leading
      : html`<button type="button" class="bar-btn" onClick=${cancel} disabled=${busy}>${cancelLabel}</button>`;
  const trailingNode =
    trailing !== undefined
      ? trailing
      : onSave
        ? html`<button
            type="button"
            class="bar-btn bar-btn-primary"
            onClick=${save}
            disabled=${saveDisabled || busy}
            aria-busy=${busy ? 'true' : undefined}
          >
            ${busy ? html`<${Spinner} size=${18} label="Zapisuję…" />` : saveLabel}
          </button>`
        : null;

  return html`<div
    class=${`sheet sheet-${variant} ${className}`}
    role="dialog"
    aria-modal="true"
    aria-labelledby=${title ? titleId : undefined}
    aria-busy=${busy ? 'true' : undefined}
    tabindex="-1"
    data-layer-focus
    onKeyDown=${onKeyDown}
  >
    <header class="sheet-bar">
      <div class="sheet-bar-side">${leadingNode}</div>
      <h2 class="sheet-title" id=${titleId}>${title}</h2>
      <div class="sheet-bar-side sheet-bar-trailing">${trailingNode}</div>
    </header>
    <div class="sheet-body">${children}</div>
  </div>`;
}
