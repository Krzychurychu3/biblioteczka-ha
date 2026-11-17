// Router oparty na hashu: adres dokumentu (ścieżka Ingress) nigdy się nie zmienia.
//
// Format: `#/<karta>[/<id>][/seria/<id>|/autor/<id>]…[?parametry]`, np.
// `#/serie`, `#/serie/5` (szczegóły serii 5), `#/autorzy/3`,
// `#/serie/5/autor/3/seria/7` (stos ekranów w karcie „Serie”),
// `#/szukaj/seria/5` (seria otwarta z wyników wyszukiwania), `#/ksiazki/ksiazka/12` (książka).
// Każda karta ma własny stos, jak NavigationStack w iOS.
//
// Dwa panele (szerokie okno): lista karty to korzeń, a wybrana pozycja – pierwszy ekran na stosie.
// Pierwszy wybór dodaje wpis w historii, zmiana wyboru podmienia bieżący wpis (selectEntry).
// Wybór widać od razu (trasa w pamięci), a adres dochodzi chwilę później – przy strzałkach dopiero
// po chwili bez klawisza.

import { useEffect, useState } from '../../vendor/preact-htm.js';
import {
  DEFAULT_PATH,
  SPLIT_QUERY,
  TABS,
  formatRoute,
  parentRoute,
  parseRoute,
  pushRouteEntry,
  selectionMode,
  selectionRoute,
} from './pure.js';
import { historyBack, historyPush, historyReplace, historySelect, onHistoryPop } from './history.js';

const TAB_MEMORY_KEY = 'biblioteczka.tabs';

// `current` – trasa pokazywana przez ekrany; `committedPath` – ścieżka z paska adresu (ostatnio
// obsłużona w update). Różnią się tylko chwilę po wyborze z listy, zanim adres dotrze.
let current = null;
let committedPath = null;
let previousPath = null;
// Dwa panele: ostatni wybór z listy, którego adres jeszcze nie dotarł (`hashchange` przychodzi
// dwa zadania po zleceniu, przy strzałkach – po chwili bez klawisza), i zamiar dla app.js (czy
// przenieść fokus do szczegółów). Oba wygasają, gdyby adres z jakiegoś powodu nie dotarł.
const SELECTION_TTL_MS = 2000;
// Przeglądanie listy strzałkami: zapis w historii po tylu ms bez kolejnego klawisza.
export const KEY_COMMIT_DELAY_MS = 250;
let pendingSelection = null;
let selectionIntent = null;
const listeners = new Set();
const tabMemory = loadTabMemory();

function loadTabMemory() {
  const memory = {};
  for (const tab of TABS) memory[tab] = '/' + tab;
  try {
    const saved = JSON.parse(sessionStorage.getItem(TAB_MEMORY_KEY) || '{}');
    for (const tab of TABS) {
      const route = typeof saved[tab] === 'string' ? parseRoute(saved[tab]) : null;
      if (route && route.tab === tab) memory[tab] = route.path;
    }
  } catch {
    // Brak sessionStorage (tryb prywatny) – pamięć tylko w tej sesji strony.
  }
  return memory;
}

function saveTabMemory() {
  try {
    sessionStorage.setItem(TAB_MEMORY_KEY, JSON.stringify(tabMemory));
  } catch {
    // Bez trwałej pamięci kart.
  }
}

function readLocation() {
  const route = parseRoute(location.hash);
  if (!route) {
    const fallback = parseRoute(tabMemory.serie) || parseRoute(DEFAULT_PATH);
    return { route: fallback, canonical: false };
  }
  return { route, canonical: location.hash === '#' + route.path };
}

/**
 * Dwa panele, pierwszy adres strony bez znacznika (panel HA otwarty ponownie – trasa z pamięci karty
 * – albo adres otwarty z zewnątrz) z wybraną pozycją: pod nim nie ma listy, więc „wstecz” wyszłoby
 * od razu z aplikacji, a zmiany wyboru tylko podmieniałyby ten jeden wpis.
 */
function needsSeed(route) {
  const state = history.state;
  return (
    route.stack.length > 0 &&
    !(state && state.bibRoute) &&
    typeof matchMedia === 'function' &&
    matchMedia(SPLIT_QUERY).matches
  );
}

/**
 * Wpisy korzenia karty i kolejnych ekranów stosu pod trasą startową – taki kształt historii, jakby
 * użytkownik sam przeszedł od listy (bez przeładowania i bez `hashchange`).
 */
function seedHistory(route) {
  const base = location.href.split('#')[0];
  let from = null;
  for (let depth = 0; depth <= route.stack.length; depth += 1) {
    const path = depth === route.stack.length ? route.path : formatRoute({ tab: route.tab, stack: route.stack.slice(0, depth) });
    const state = { bibRoute: path, bibFrom: from };
    if (depth === 0) history.replaceState(state, '', `${base}#${path}`);
    else history.pushState(state, '', `${base}#${path}`);
    from = path;
  }
}

function show(route) {
  if (current && current.path === route.path) return;
  previousPath = current ? current.path : null;
  current = route;
  tabMemory[route.tab] = route.path;
  saveTabMemory();
  for (const listener of listeners) listener(route);
}

function update() {
  const { route, canonical } = readLocation();
  if (!current && needsSeed(route)) {
    seedHistory(route);
  } else {
    if (!canonical) {
      // Niepoprawny lub niekanoniczny adres – podmień bez nowego wpisu.
      location.replace(`${location.href.split('#')[0]}#${route.path}`);
    }
    const state = history.state || {};
    if (state.bibRoute !== route.path) {
      // Nowy wpis (kliknięty link, wpisany adres): zapamiętaj, skąd przyszliśmy,
      // żeby „wstecz” w aplikacji mogło użyć historii przeglądarki.
      history.replaceState({ ...state, bibRoute: route.path, bibFrom: committedPath }, '');
    }
  }
  committedPath = route.path;
  const pending = fresh(pendingSelection);
  // Adres wcześniejszego wyboru z listy, a nowszy wybór już widać: bez przerysowania (inaczej
  // szczegóły na chwilę cofnęłyby się, a app.js uznałby to za nawigację spoza listy).
  if (pending && pending.path !== route.path) return;
  pendingSelection = null;
  show(route);
}

/** Bieżąca trasa (`{tab, stack, query, path}`). */
export function getRoute() {
  if (!current) update();
  return current;
}

/** Ścieżka poprzedniej trasy (do przywracania przewinięcia). */
export function getPreviousPath() {
  return previousPath;
}

/** Subskrypcja zmian trasy; zwraca funkcję wypisującą. */
export function subscribeRoute(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hook: bieżąca trasa, przerysowanie po każdej zmianie. */
export function useRoute() {
  const [route, setRoute] = useState(getRoute);
  useEffect(() => {
    if (current !== route) setRoute(current);
    return subscribeRoute(setRoute);
  }, []);
  return route;
}

/** Przejście do ścieżki (`/serie/5`); `replace` = bez nowego wpisu w historii. */
export function navigate(path, { replace = false } = {}) {
  const route = parseRoute(path);
  if (!route) throw new Error(`Nieznana trasa: ${path}`);
  // Każda inna nawigacja jest nowsza niż czekający wybór z listy – jej adres ma się pokazać.
  pendingSelection = null;
  if (replace) historyReplace(route.path);
  else historyPush(route.path);
}

/** Otwiera ekran szczegółów na stosie bieżącej karty: `pushEntry({type: 'series', id})`. */
export function pushEntry(entry) {
  navigate(pushRouteEntry(getRoute(), entry).path);
}

/** Szczegóły serii na stosie bieżącej karty. */
export function openSeries(id) {
  pushEntry({ type: 'series', id });
}

/** Szczegóły autora na stosie bieżącej karty. */
export function openAuthor(id) {
  pushEntry({ type: 'author', id });
}

/** Adres (do `href`) ekranu dołożonego na stos bieżącej karty. */
export function entryHref(entry) {
  return hrefFor(pushRouteEntry(getRoute(), entry).path);
}

/**
 * Pełny adres dokumentu z danym hashem. Zwykłe `href="#/…"` rozwiązywałoby się
 * względem `<base href>`, co przy innym adresie dokumentu przeładowałoby stronę.
 */
export function hrefFor(path) {
  return `${location.href.split('#')[0]}#${path}`;
}

/** Powrót do ekranu nadrzędnego (np. po usunięciu oglądanej serii). */
export function goBack() {
  const parent = parentRoute(getRoute());
  if (!parent) return;
  pendingSelection = null;
  historyBack(parent.path);
}

function fresh(record) {
  return record && Date.now() - record.at <= SELECTION_TTL_MS ? record : null;
}

/**
 * Dwa panele: wybór pozycji z listy karty. Pierwszy wybór dodaje wpis w historii, zmiana wyboru
 * podmienia bieżący wpis (z zachowaniem bibFrom). Zwraca false, gdy pozycja już jest wybrana.
 * Szczegóły pokazują się od razu, a adres dochodzi później. `focusDetail` – po przejściu fokus
 * trafi na tytuł szczegółów (Enter na wierszu). `browsing` – przeglądanie strzałkami: wpis
 * w historii dopiero po KEY_COMMIT_DELAY_MS bez kolejnego wyboru.
 */
export function selectEntry(entry, { focusDetail = false, browsing = false } = {}) {
  // Trasa pokazywana – także wybór, którego adres jeszcze nie dotarł: kolejny szybki wybór liczy się
  // względem niego (podmiana, nie drugi push).
  const route = getRoute();
  const mode = selectionMode(route, entry);
  if (mode === 'none') return false;
  const next = selectionRoute(route, entry);
  const at = Date.now();
  pendingSelection = { path: next.path, at };
  selectionIntent = { path: next.path, focusDetail, at };
  historySelect(next.path, { push: mode === 'push', delay: browsing ? KEY_COMMIT_DELAY_MS : 0 });
  show(next);
  return true;
}

/** Dla app.js: zamiar zapisany przez selectEntry dla ścieżki `path` (jednorazowo), albo null. */
export function takeSelectionIntent(path) {
  const intent = fresh(selectionIntent);
  if (!intent) {
    selectionIntent = null;
    return null;
  }
  if (intent.path !== path) return null;
  selectionIntent = null;
  return { path: intent.path, focusDetail: intent.focusDetail };
}

/** Ostatnio oglądana ścieżka danej karty. */
export function tabPath(tab) {
  return tabMemory[tab] || '/' + tab;
}

/** Przełączenie karty; ponowne wybranie bieżącej karty wraca do jej korzenia. */
export function selectTab(tab) {
  const route = getRoute();
  if (route.tab === tab) {
    if (route.stack.length || Object.keys(route.query).length) navigate(formatRoute({ tab }));
    return false;
  }
  navigate(tabPath(tab));
  return true;
}

if (typeof window !== 'undefined') {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.addEventListener('hashchange', update);
  // Wstecz/dalej przeglądarki, zanim adres wyboru z listy dotarł (ui/history.js porzuca wtedy jego
  // zapis): pokaż wpis, na który użytkownik przeszedł – także gdy ma ten sam adres (bez `hashchange`).
  onHistoryPop(({ external }) => {
    if (!external || !pendingSelection) return;
    pendingSelection = null;
    update();
  });
}
