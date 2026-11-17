// Krótkie komunikaty u dołu ekranu (np. błędy zapisu, „Cofnij” po usunięciu).

import { html, useEffect, useReducer } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';

const MAX_VISIBLE = 3;
const LEAVE_MS = 220;

let toasts = [];
let nextId = 1;
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function schedule(item) {
  clearTimeout(item.timer);
  if (item.duration > 0 && !item.paused) {
    item.timer = setTimeout(() => dismissToast(item.id), item.duration);
  }
}

/**
 * Pokazuje komunikat. Opcje: `tone` ('default' | 'error' | 'success'),
 * `action: {label, onClick}` (np. „Cofnij”), `duration` w ms (0 = do zamknięcia).
 * Ten sam widoczny tekst nie jest dublowany – odświeża się tylko jego czas.
 * Zwraca `{id, dismiss}`.
 */
export function toast(text, { tone = 'default', action, duration } = {}) {
  const message = String(text ?? '').trim();
  if (!message) return { id: 0, dismiss() {} };
  const existing = toasts.find((t) => t.text === message && !t.leaving);
  if (existing) {
    schedule(existing);
    return { id: existing.id, dismiss: () => dismissToast(existing.id) };
  }
  const item = {
    id: nextId++,
    text: message,
    tone,
    action,
    duration: duration ?? (action ? 6000 : 4000),
    leaving: false,
    paused: false,
    timer: 0,
  };
  toasts = [...toasts, item];
  const active = toasts.filter((t) => !t.leaving);
  for (const extra of active.slice(0, Math.max(0, active.length - MAX_VISIBLE))) dismissToast(extra.id);
  schedule(item);
  emit();
  return { id: item.id, dismiss: () => dismissToast(item.id) };
}

/** Zamyka komunikat o danym id. */
export function dismissToast(id) {
  const item = toasts.find((t) => t.id === id);
  if (!item || item.leaving) return;
  clearTimeout(item.timer);
  item.leaving = true;
  toasts = [...toasts];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t !== item);
    emit();
  }, LEAVE_MS);
}

function pause(item, paused) {
  item.paused = paused;
  if (paused) clearTimeout(item.timer);
  else schedule(item);
}

const TONE_ICON = { error: 'warning', success: 'check-circle' };

/** Host komunikatów – renderowany raz w app.js (poza powłoką, żeby działał nad arkuszami). */
export function ToastHost() {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);

  return html`<div class="toast-host" role="status" aria-live="polite" aria-relevant="additions text">
    ${toasts.map(
      (item) => html`<div
        key=${item.id}
        class=${`toast tone-${item.tone} ${item.leaving ? 'is-leaving' : ''}`}
        onMouseEnter=${() => pause(item, true)}
        onMouseLeave=${() => pause(item, false)}
        onfocusin=${() => pause(item, true)}
        onfocusout=${() => pause(item, false)}
      >
        ${TONE_ICON[item.tone] ? Icon(TONE_ICON[item.tone], { className: 'toast-icon' }) : null}
        <span class="toast-text">${item.text}</span>
        ${item.action &&
        html`<button
          type="button"
          class="toast-action"
          onClick=${() => {
            dismissToast(item.id);
            item.action.onClick?.();
          }}
        >
          ${item.action.label}
        </button>`}
        <button type="button" class="toast-close" aria-label="Zamknij" onClick=${() => dismissToast(item.id)}>
          ${Icon('xmark')}
        </button>
      </div>`,
    )}
  </div>`;
}
