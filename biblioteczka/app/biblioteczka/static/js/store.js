// Globalny magazyn biblioteczki: ostatni snapshot z `GET api/state`, indeksy i selektory.
//
//   const lib = useLibrary();             // przerysowanie po każdej zmianie danych
//   lib.seriesById.get(5); lib.booksBySeries.get(5)
//   visibleSeries(lib); visibleAuthors(lib); ownedBooks(lib)
//   const result = await mutate(() => api.post('api/books', {draft}));
//   if (result) closeSheet();             // undefined = błąd (komunikat już pokazany)
//
// Dane odświeżają się co 15 s (co 2 s w trakcie pobierania okładek), gdy karta jest widoczna,
// po powrocie do karty/okna i po każdej zmianie (mutate). Dzięki ETag niezmieniony stan kosztuje
// tylko 304. Gdy serwer nie odpowiada, kolejne próby są coraz rzadsze (2 s → 4 s → 8 s… do 60 s).

import { useEffect, useReducer } from '../vendor/preact-htm.js';
import { compareLocalized } from './core/text.js';
import { api } from './api.js';
import { toast } from './ui/toast.js';

const POLL_MS = 15000;
const POLL_FAST_MS = 2000;
const POLL_BACKOFF_MAX_MS = 60000;

/**
 * Odstęp do następnego odpytania serwera: 15 s, w trakcie pobierania okładek 2 s.
 * Po `failures` kolejnych nieudanych pobraniach odstęp rośnie wykładniczo
 * (2 s → 4 s → 8 s…, najwyżej 60 s), ale nigdy nie jest krótszy niż zwykły.
 */
export function pollDelayMs({ coverJobRunning = false, failures = 0 } = {}) {
  const base = coverJobRunning ? POLL_FAST_MS : POLL_MS;
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  if (!n) return base;
  const backoff = POLL_FAST_MS * 2 ** Math.min(n - 1, 16);
  return Math.min(POLL_BACKOFF_MAX_MS, Math.max(base, backoff));
}

// ---------------------------------------------------------------------------
// Sortowanie i indeksy (czyste funkcje)
// ---------------------------------------------------------------------------

/**
 * Kopia listy posortowana „po polsku” (Intl.Collator pl, numerycznie, bez wielkości liter)
 * według `key` (nazwa pola albo funkcja); remisy rozstrzyga `id`, więc kolejność jest
 * taka sama na wszystkich urządzeniach.
 */
export function sortLocalized(items, key = 'name') {
  const get = typeof key === 'function' ? key : (item) => item?.[key];
  return [...(items || [])].sort((a, b) => {
    const result = compareLocalized(String(get(a) ?? ''), String(get(b) ?? ''));
    if (result) return result;
    return (a?.id ?? 0) - (b?.id ?? 0);
  });
}

function groupBy(items, field, sortKey) {
  const map = new Map();
  for (const item of items) {
    const id = item[field];
    if (id === null || id === undefined) continue;
    let list = map.get(id);
    if (!list) {
      list = [];
      map.set(id, list);
    }
    list.push(item);
  }
  for (const [id, list] of map) map.set(id, sortLocalized(list, sortKey));
  return map;
}

/** Buduje obiekt biblioteczki (dane + indeksy) ze snapshotu serwera. */
export function buildLibrary(state, extra = {}) {
  const authors = state?.authors || [];
  const series = state?.series || [];
  const books = state?.books || [];
  return {
    loaded: Boolean(state),
    revision: state?.revision ?? 0,
    appVersion: state?.appVersion ?? '',
    meta: state?.meta || {},
    authors,
    series,
    books,
    authorsById: new Map(authors.map((a) => [a.id, a])),
    seriesById: new Map(series.map((s) => [s.id, s])),
    booksById: new Map(books.map((b) => [b.id, b])),
    booksBySeries: groupBy(books, 'seriesId', 'title'),
    booksByAuthor: groupBy(books, 'authorId', 'title'),
    seriesByAuthor: groupBy(series, 'authorId', 'name'),
    error: null,
    ...extra,
  };
}

const memo = new WeakMap();

function memoized(lib, name, compute) {
  let cache = memo.get(lib);
  if (!cache) {
    cache = {};
    memo.set(lib, cache);
  }
  if (!(name in cache)) cache[name] = compute();
  return cache[name];
}

/** Serie „na półce” (puste albo z co najmniej jedną posiadaną książką), wg nazwy. */
export function visibleSeries(lib) {
  return memoized(lib, 'visibleSeries', () => sortLocalized(lib.series.filter((s) => s.isOnShelf), 'name'));
}

/** Autorzy „na półce”, wg nazwiska (tak jak w iOS – wg całej nazwy). */
export function visibleAuthors(lib) {
  return memoized(lib, 'visibleAuthors', () => sortLocalized(lib.authors.filter((a) => a.isOnShelf), 'name'));
}

/** Posiadane książki, wg tytułu. */
export function ownedBooks(lib) {
  return memoized(lib, 'ownedBooks', () => sortLocalized(lib.books.filter((b) => b.isOwned), 'title'));
}

/** Wszystkie serie wg nazwy (podpowiedzi w edytorach – także katalog). */
export function allSeriesSorted(lib) {
  return memoized(lib, 'allSeries', () => sortLocalized(lib.series, 'name'));
}

/** Wszyscy autorzy wg nazwy (podpowiedzi w edytorach – także katalog). */
export function allAuthorsSorted(lib) {
  return memoized(lib, 'allAuthors', () => sortLocalized(lib.authors, 'name'));
}

// ---------------------------------------------------------------------------
// Stan globalny
// ---------------------------------------------------------------------------

let library = buildLibrary(null, { loading: true });
const listeners = new Set();

function setLibrary(next) {
  library = next;
  for (const listener of listeners) {
    try {
      listener(library);
    } catch (error) {
      console.error(error);
    }
  }
}

/** Bieżący obiekt biblioteczki (poza komponentami). */
export function getLibrary() {
  return library;
}

/** Subskrypcja zmian; zwraca funkcję wypisującą. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hook: bieżąca biblioteczka; komponent przerysowuje się po każdej zmianie. */
export function useLibrary() {
  const [, force] = useReducer((n) => n + 1, 0);
  const seen = library;
  useEffect(() => {
    const unsubscribe = subscribe(() => force());
    if (library !== seen) force();
    return unsubscribe;
  }, []);
  return library;
}

let inflight = null;
let queued = null;
/** Liczba kolejnych nieudanych pobrań stanu (do wydłużania odstępu odpytywania). */
let failures = 0;

async function fetchState({ force = false } = {}) {
  try {
    const state = await api.state({ force: force || !library.loaded });
    failures = 0;
    if (state) {
      // Pobrania idą jedno po drugim, więc odpowiedź jest zawsze najnowsza
      // (także gdy numer rewizji spadł po przywróceniu kopii zapasowej).
      setLibrary(buildLibrary(state));
    } else if (library.error || library.loading) {
      setLibrary({ ...library, error: null, loading: false });
    }
    // Np. po uruchomieniu pobierania okładek albo po odzyskaniu połączenia (także 304):
    // odpytuj od razu częściej, nie po starym, długim odstępie.
    if (syncing && pollInterval() < pollDelay) schedulePoll();
    return library;
  } catch (error) {
    failures += 1;
    setLibrary({ ...library, error, loading: false });
    throw error;
  }
}

/**
 * Pobiera świeży stan. Wywołania w trakcie trwającego pobierania są łączone w jedno
 * kolejne pobranie (zaczęte po bieżącym), więc wynik zawsze uwzględnia wcześniejsze zmiany.
 * Promise odrzucany przy błędzie sieci (błąd trafia też do `library.error`).
 */
export function refresh(options) {
  if (!inflight) {
    inflight = fetchState(options).finally(() => {
      inflight = null;
    });
    return inflight;
  }
  if (!queued) {
    queued = inflight
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return refresh(options);
      });
  }
  return queued;
}

/**
 * Wykonuje zmianę na serwerze i odświeża dane.
 * `task` – funkcja zwracająca Promise (albo sam Promise) wywołania API.
 * Opcje: `toastError` (domyślnie true) – komunikat błędu w dymku; `rethrow` – rzuć błąd dalej;
 * `success` – tekst dymka po sukcesie.
 * Zwraca wynik wywołania albo `undefined` po błędzie.
 */
export async function mutate(task, { toastError = true, rethrow = false, success } = {}) {
  let result;
  try {
    result = await (typeof task === 'function' ? task() : task);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (rethrow) throw error;
      return undefined;
    }
    console.warn(error);
    if (toastError) toast(error?.message || 'Wystąpił nieoczekiwany błąd.', { tone: 'error' });
    if (rethrow) throw error;
    return undefined;
  }
  try {
    await refresh();
  } catch {
    // Zmiana się udała; odświeżenie powtórzy się przy następnym odpytaniu.
  }
  if (success) toast(success, { tone: 'success' });
  return result;
}

// ---------------------------------------------------------------------------
// Synchronizacja między urządzeniami
// ---------------------------------------------------------------------------

let pollTimer = 0;
let pollDelay = 0;
let syncing = false;

function pollInterval() {
  // Po błędzie `meta.coverJob` pochodzi z ostatniego udanego pobrania – stąd wydłużanie odstępu.
  return pollDelayMs({ coverJobRunning: Boolean(library.meta?.coverJob?.running), failures });
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollDelay = 0;
  if (!syncing || document.visibilityState !== 'visible') return;
  pollDelay = pollInterval();
  pollTimer = setTimeout(async () => {
    try {
      await refresh();
    } catch {
      // Błąd widać w `library.error` (pasek „Brak połączenia…”).
    }
    schedulePoll();
  }, pollDelay);
}

function refreshNow() {
  refresh()
    .catch(() => undefined)
    .finally(schedulePoll);
}

/** Uruchamia odpytywanie serwera (app.js przy starcie). Zwraca Promise pierwszego pobrania. */
export function startSync() {
  if (syncing) return refresh();
  syncing = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshNow();
    else clearTimeout(pollTimer);
  });
  window.addEventListener('focus', refreshNow);
  window.addEventListener('online', refreshNow);
  const first = refresh({ force: true });
  first.catch(() => undefined).finally(schedulePoll);
  return first;
}
