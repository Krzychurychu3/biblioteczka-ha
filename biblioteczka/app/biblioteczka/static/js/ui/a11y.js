// Drobne narzędzia dostępności i interakcji.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';

let counter = 0;

/** Unikalny identyfikator elementu (Preact bez `useId`). */
export function uid(prefix = 'id') {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Tekst tylko dla czytników ekranu. */
export function VisuallyHidden({ children, id }) {
  return html`<span class="visually-hidden" id=${id}>${children}</span>`;
}

/**
 * Wibracja jako odpowiednik haptyki iOS: 'selection' | 'success' | 'warning'.
 * Bez wsparcia (iOS Safari, komputer) nic nie robi.
 */
export function haptic(kind = 'selection') {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  if (prefersReducedMotion()) return;
  const patterns = { selection: 8, success: [12, 60, 18], warning: [24, 50, 24] };
  try {
    navigator.vibrate(patterns[kind] ?? 8);
  } catch {
    // Wibracja zablokowana przez przeglądarkę – bez znaczenia.
  }
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Hook: czy pasuje zapytanie mediów (np. '(min-width: 900px)'). */
export function useMediaQuery(query) {
  const get = () => typeof matchMedia === 'function' && matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Hook: `true` przez chwilę po zmianie wartości (nie przy pierwszym renderze) –
 * do krótkiej animacji, np. zmiany liczby na kafelku albo przełączenia statusu.
 */
export function useChangePulse(value, duration = 360) {
  const previous = useRef(value);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (Object.is(previous.current, value)) return undefined;
    previous.current = value;
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), duration);
    return () => clearTimeout(timer);
  }, [value]);
  return pulse;
}
