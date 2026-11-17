// Wspólne drobiazgi edytorów: arkusz stylów, fokus, powrót z ekranu usuniętego obiektu.

import { APP_VERSION } from '../api.js';
import { getRoute, goBack } from '../ui/index.js';

let stylesLoaded = false;

/** Dołącza `static/css/editors.css` (raz, przy pierwszym otwarciu edytora lub skanera). */
export function ensureEditorStyles() {
  if (stylesLoaded || typeof document === 'undefined') return;
  stylesLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `static/css/editors.css${APP_VERSION ? `?v=${encodeURIComponent(APP_VERSION)}` : ''}`;
  link.dataset.editors = '';
  document.head.appendChild(link);
}

/** Zdejmuje fokus z pola (iOS `focus = nil` – chowa klawiaturę). */
export function blurActive() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}

/** Identyfikator z parametru (liczba albo tekst z adresu) albo null. */
export function toId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Po usunięciu (lub połączeniu) obiektu: wywołuje `onDelete` z ekranu szczegółów, a bez niego –
 * cofa się, jeśli na wierzchu stosu jest właśnie ten obiekt (iOS `onDelete` zamyka jego ekran).
 */
export function leaveDeletedEntry(type, id, onDelete) {
  if (typeof onDelete === 'function') {
    try {
      onDelete();
    } catch (error) {
      console.error(error);
    }
    return;
  }
  const route = getRoute();
  const top = route && route.stack.length ? route.stack[route.stack.length - 1] : null;
  if (top && top.type === type && top.id === id) goBack();
}

/** Uruchamia `fn` przy następnej klatce (fokus po przerysowaniu). */
export function nextFrame(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 0);
}
