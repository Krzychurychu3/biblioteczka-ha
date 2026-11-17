// Dialogi: arkusz akcji iOS (confirmDialog) i alert z jednym przyciskiem (alertDialog).

import { html, useRef } from '../../vendor/preact-htm.js';
import { openLayer, useLayer } from './overlay.js';
import { uid } from './a11y.js';

function ActionSheet({ title, message, actions, resolve }) {
  const layer = useLayer();
  const ids = useRef({ title: uid('dlg-title'), message: uid('dlg-msg') }).current;
  const cancelAction = actions.find((a) => a.role === 'cancel') || { label: 'Anuluj', role: 'cancel' };
  const others = actions.filter((a) => a.role !== 'cancel');

  const choose = (action) => {
    if (layer.closing) return;
    layer.close();
    resolve(action.role === 'cancel' ? null : action);
    try {
      action.onClick?.();
    } catch (error) {
      console.error(error);
    }
  };

  layer.setEscape(() => choose(cancelAction));

  return html`<div
    class="action-sheet"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby=${title ? ids.title : undefined}
    aria-describedby=${message ? ids.message : undefined}
  >
    <div class="action-group">
      ${(title || message) &&
      html`<div class="action-head">
        ${title && html`<h2 class="action-title" id=${ids.title}>${title}</h2>`}
        ${message && html`<p class="action-message" id=${ids.message}>${message}</p>`}
      </div>`}
      ${others.map(
        (action) => html`<button
          type="button"
          class=${`action-btn ${action.role === 'destructive' ? 'is-destructive' : ''}`}
          disabled=${action.disabled}
          onClick=${() => choose(action)}
        >
          ${action.label}
        </button>`,
      )}
    </div>
    <div class="action-group action-cancel">
      <button type="button" class="action-btn is-cancel" data-autofocus onClick=${() => choose(cancelAction)}>
        ${cancelAction.label}
      </button>
    </div>
  </div>`;
}

/**
 * Arkusz akcji iOS: tytuł, komunikat, przyciski (role 'destructive' – na czerwono)
 * i zawsze „Anuluj”. Zwraca Promise z wybraną akcją albo `null` po anulowaniu;
 * `onClick` akcji jest też wywoływane.
 */
export function confirmDialog({ title, message, actions = [] }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    openLayer({
      kind: 'dialog',
      className: 'dialog-actions',
      dismissOnBackdrop: true,
      onClose: () => settle(null),
      render: () => html`<${ActionSheet} title=${title} message=${message} actions=${actions} resolve=${settle} />`,
    });
  });
}

function Alert({ title, message, okLabel, resolve }) {
  const layer = useLayer();
  const ids = useRef({ title: uid('alert-title'), message: uid('alert-msg') }).current;
  const ok = () => {
    if (layer.closing) return;
    layer.close();
    resolve();
  };
  layer.setEscape(ok);
  return html`<div
    class="alert"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby=${ids.title}
    aria-describedby=${message ? ids.message : undefined}
  >
    <div class="alert-body">
      <h2 class="alert-title" id=${ids.title}>${title}</h2>
      ${message && html`<p class="alert-message" id=${ids.message}>${message}</p>`}
    </div>
    <button type="button" class="alert-btn" data-autofocus onClick=${ok}>${okLabel}</button>
  </div>`;
}

/** Alert iOS z jednym przyciskiem (np. „Katalog bajek dla dzieci” – „OK”). Promise po zamknięciu. */
export function alertDialog({ title, message, okLabel = 'OK' }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    openLayer({
      kind: 'dialog',
      className: 'dialog-alert',
      dismissOnBackdrop: false,
      onClose: settle,
      render: () => html`<${Alert} title=${title} message=${message} okLabel=${okLabel} resolve=${settle} />`,
    });
  });
}
