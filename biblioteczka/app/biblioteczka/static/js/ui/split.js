// Dwa panele (widok na komputerze): w szerokim oknie lista karty po lewej, szczegóły wybranej
// pozycji po prawej. Ten moduł daje ekranom i wierszom wiedzę o panelu, w którym są rysowane,
// a app.js – kilka pomocników DOM (tytuły paneli, przewinięcie do wybranego wiersza).
//
// Przełączenie układu sprawdza jedno zapytanie mediów (SPLIT_QUERY z ui/pure.js) – app.js wywołuje
// useSplitView() raz i ustawia klasę `is-split` na <html>; reszta czyta PaneContext (usePane()).

import { createContext, useContext } from '../../vendor/preact-htm.js';
import { useMediaQuery } from './a11y.js';
import { SPLIT_QUERY } from './pure.js';

/**
 * Kontekst panelu: `{pane: 'single'|'list'|'detail', split, selected}`.
 * `selected` – pozycja wybrana na liście (`{type, id}`) w lewym panelu, inaczej `null`.
 * Wąski układ niczego nie dostarcza – ekrany i wiersze dostają wartość domyślną.
 */
export const PaneContext = createContext({ pane: 'single', split: false, selected: null });

/** Wartość kontekstu prawego panelu (stała – zmiana szczegółów nie przerysowuje wierszy listy). */
export const DETAIL_PANE = Object.freeze({ pane: 'detail', split: true, selected: null });

/** Hook: panel, w którym rysuje się wywołujący komponent. */
export function usePane() {
  return useContext(PaneContext);
}

/** Hook (tylko w App): czy okno jest dość szerokie na dwa panele. */
export function useSplitView() {
  return useMediaQuery(SPLIT_QUERY);
}

/** Wersja bez hooka (poza komponentami). */
export function isSplitView() {
  return typeof matchMedia === 'function' && matchMedia(SPLIT_QUERY).matches;
}

/** Duży tytuł lewego (`'list'`) albo prawego (`'detail'`) panelu widocznej karty. */
export function paneHeading(pane) {
  return document.querySelector(`.is-split .split-panel:not([hidden]) .pane-${pane} .large-title`);
}

// ---------------------------------------------------------------------------
// Komunikat „Szczegóły: …” dla czytników ekranu (app.js ustawia go chwilę po wyborze z listy)
// ---------------------------------------------------------------------------

const announcementResets = new Set();

/** app.js: nasłuch prośby o wyczyszczenie komunikatu; zwraca funkcję wypisującą. */
export function onAnnouncementReset(listener) {
  announcementResets.add(listener);
  return () => announcementResets.delete(listener);
}

/** Czyści komunikat o wyborze (Enter na już wybranym wierszu przenosi fokus do szczegółów). */
export function resetAnnouncement() {
  for (const listener of announcementResets) listener();
}

// ---------------------------------------------------------------------------
// Przewinięcie listy do wybranego wiersza (adres otwarty z zewnątrz, przeładowanie strony)
// ---------------------------------------------------------------------------

const REVEAL_TIMEOUT_MS = 5000;
const REVEAL_STOP_EVENTS = ['pointerdown', 'wheel', 'keydown'];
const pendingReveals = new Map();

function listPane(tab) {
  return document.querySelector(`.split-panel[data-tab="${tab}"] .pane-list`);
}

function tryReveal(tab) {
  const row = document.querySelector(`.split-panel[data-tab="${tab}"] .pane-list .row.is-selected`);
  if (!row) return false;
  row.scrollIntoView({ block: 'nearest' });
  return true;
}

/** Porzuca czekające przewinięcie do wybranego wiersza karty `tab`. */
export function cancelReveal(tab) {
  const stop = pendingReveals.get(tab);
  if (!stop) return;
  pendingReveals.delete(tab);
  stop();
}

/**
 * Przewija lewy panel karty `tab` tak, żeby wybrany wiersz był widoczny. Gdy wiersza jeszcze nie ma
 * (biblioteczka albo moduł ekranu dopiero się wczytują), czeka na niego – najwyżej 5 s i tylko do
 * pierwszego ruchu użytkownika w tym panelu (stuknięcie, kółko, klawisz).
 */
export function revealSelectedRow(tab) {
  cancelReveal(tab);
  if (typeof document === 'undefined' || tryReveal(tab)) return;
  const pane = listPane(tab);
  if (!pane || typeof MutationObserver !== 'function') return;
  const stop = () => cancelReveal(tab);
  const observer = new MutationObserver(() => {
    if (tryReveal(tab)) stop();
  });
  observer.observe(pane, { childList: true, subtree: true });
  for (const type of REVEAL_STOP_EVENTS) pane.addEventListener(type, stop, { passive: true });
  const timer = setTimeout(stop, REVEAL_TIMEOUT_MS);
  pendingReveals.set(tab, () => {
    observer.disconnect();
    for (const type of REVEAL_STOP_EVENTS) pane.removeEventListener(type, stop, { passive: true });
    clearTimeout(timer);
  });
}
