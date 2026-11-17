// Czyste funkcje pomocnicze zestawu UI (bez DOM – testowane w node).

// ---------------------------------------------------------------------------
// Trasy (hash routing)
// ---------------------------------------------------------------------------

/** Karty aplikacji w kolejności paska kart. */
export const TABS = ['serie', 'autorzy', 'ksiazki', 'szukaj'];

/** Typ ekranu szczegółów „naturalny” dla karty: `#/serie/5` = szczegóły serii 5. */
const NATURAL_TYPE = { serie: 'series', autorzy: 'author' };

/**
 * Segmenty adresu dla kolejnych ekranów na stosie: `…/seria/5`, `…/autor/3`, `…/ksiazka/12`.
 * Karta „Książki” nie ma typu naturalnego: `#/ksiazki/12` → `#/ksiazki`, książka to `#/ksiazki/ksiazka/12`.
 */
const SEGMENT_TO_TYPE = { seria: 'series', autor: 'author', ksiazka: 'book' };
const TYPE_TO_SEGMENT = { series: 'seria', author: 'autor', book: 'ksiazka' };

/** Najgłębszy obsługiwany stos ekranów (zabezpieczenie przed absurdalnymi adresami). */
export const MAX_STACK_DEPTH = 24;

export const DEFAULT_PATH = '/serie';

const ID_RE = /^[1-9]\d{0,14}$/;

function parseId(segment) {
  return ID_RE.test(segment) ? Number(segment) : null;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Rozbiera hash (`#/serie/5/autor/3?q=lem`) na trasę
 * `{tab, stack: [{type, id}], query: {…}, path}`; `path` to postać kanoniczna.
 * Nieznana karta → `null`. Niepoprawny ogon adresu jest obcinany
 * (wtedy `path` różni się od wejścia i router podmienia adres).
 */
export function parseRoute(hash) {
  let raw = String(hash ?? '');
  if (raw.startsWith('#')) raw = raw.slice(1);
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const segments = pathPart.split('/').filter(Boolean).map(safeDecode);
  if (segments.length === 0) return null;

  let tab = segments[0].toLowerCase();
  if (tab === 'książki') tab = 'ksiazki';
  if (!TABS.includes(tab)) return null;

  const stack = [];
  let i = 1;
  const natural = NATURAL_TYPE[tab];
  if (natural && i < segments.length) {
    const id = parseId(segments[i]);
    if (id !== null) {
      stack.push({ type: natural, id });
      i += 1;
    }
  }
  while (i + 1 < segments.length && stack.length < MAX_STACK_DEPTH) {
    const type = SEGMENT_TO_TYPE[segments[i].toLowerCase()];
    const id = parseId(segments[i + 1]);
    if (!type || id === null) break;
    stack.push({ type, id });
    i += 2;
  }

  const query = {};
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) {
      if (!(key in query)) query[key] = value;
    }
  }
  const route = { tab, stack, query };
  route.path = formatRoute(route);
  return route;
}

/** Składa trasę w kanoniczną ścieżkę (bez `#`). */
export function formatRoute({ tab, stack = [], query = {} }) {
  const parts = [tab];
  stack.forEach((entry, index) => {
    if (index === 0 && NATURAL_TYPE[tab] === entry.type) {
      parts.push(String(entry.id));
    } else {
      parts.push(TYPE_TO_SEGMENT[entry.type], String(entry.id));
    }
  });
  let path = '/' + parts.map((p) => encodeURIComponent(p)).join('/');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  if (qs) path += '?' + qs;
  return path;
}

/** Trasa po dołożeniu ekranu na stos bieżącej karty (bez parametrów zapytania). */
export function pushRouteEntry(route, entry) {
  if (!TYPE_TO_SEGMENT[entry.type]) throw new Error(`Nieznany typ ekranu: ${entry.type}`);
  const stack = [...route.stack, { type: entry.type, id: Number(entry.id) }].slice(-MAX_STACK_DEPTH);
  const next = { tab: route.tab, stack, query: {} };
  next.path = formatRoute(next);
  return next;
}

/** Trasa ekranu nadrzędnego (`null` na korzeniu karty). */
export function parentRoute(route) {
  if (!route.stack.length) return null;
  const next = { tab: route.tab, stack: route.stack.slice(0, -1), query: {} };
  next.path = formatRoute(next);
  return next;
}

/** Ostatni ekran na stosie albo `null` (korzeń karty). */
export function topEntry(route) {
  return route.stack.length ? route.stack[route.stack.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Dwa panele (szerokie okno): lista karty po lewej, szczegóły wybranej pozycji po prawej
// ---------------------------------------------------------------------------

/** Najmniejsza szerokość okna z dwoma panelami: szyna 208 + lista 340 + szczegóły 460. */
export const SPLIT_MIN_WIDTH = 1008;

/** Zapytanie mediów trybu dwóch paneli – to samo w JS (ui/split.js) i w CSS (app.css, blok 3b). */
export const SPLIT_QUERY = `(min-width: ${SPLIT_MIN_WIDTH}px)`;

/** Nazwy obszarów (aria-label) lewego panelu w kolejnych kartach. */
export const LIST_PANE_LABELS = Object.freeze({
  serie: 'Lista serii',
  autorzy: 'Lista autorów',
  ksiazki: 'Lista książek',
  szukaj: 'Wyszukiwanie',
});

/** Korzeń karty trasy (lewy panel): `{tab, stack: [], query: {}, path: '/<karta>'}`. */
export function rootRoute(route) {
  const next = { tab: route.tab, stack: [], query: {} };
  next.path = formatRoute(next);
  return next;
}

/** Trasa po wybraniu pozycji z listy karty: jeden ekran na stosie, bez parametrów zapytania. */
export function selectionRoute(route, entry) {
  if (!TYPE_TO_SEGMENT[entry.type]) throw new Error(`Nieznany typ ekranu: ${entry.type}`);
  const next = { tab: route.tab, stack: [{ type: entry.type, id: Number(entry.id) }], query: {} };
  next.path = formatRoute(next);
  return next;
}

/** Pozycja wybrana na liście karty (pierwszy ekran na stosie) albo `null`. */
export function selectedEntry(route) {
  return route.stack[0] ?? null;
}

/** Czy wybrana pozycja to `{type, id}` (id porównywane jako liczba). */
export function isSelectedEntry(selected, type, id) {
  return Boolean(selected) && selected.type === type && selected.id === Number(id);
}

/**
 * Jak zmienić historię po wybraniu pozycji z listy: 'none' (ta sama trasa), 'push' (nic nie było
 * wybrane – nowy wpis), 'replace' (zmiana wyboru albo powrót z głębszego ekranu – bez nowego wpisu).
 */
export function selectionMode(route, entry) {
  if (route.path === selectionRoute(route, entry).path) return 'none';
  return route.stack.length ? 'replace' : 'push';
}

/**
 * Strzałki na liście lewego panelu: nowy indeks wiersza dla klawisza albo `null`
 * (klawisz nie dotyczy listy). `index` −1 = fokus poza wierszami (np. w polu wyszukiwania).
 */
export function listKeyTarget(key, index, count) {
  if (!(count > 0)) return null;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(index + 1, count - 1);
    case 'ArrowUp':
      return index < 0 ? null : Math.max(index - 1, 0);
    case 'Home':
      return index >= 0 ? 0 : null;
    case 'End':
      return index >= 0 ? count - 1 : null;
    default:
      return null;
  }
}

/**
 * Czy karta nie ma czego pokazać na liście (wtedy prawy panel zostaje pusty – lista sama
 * pokazuje pusty stan z wezwaniem do działania). `counts`: `{series, authors, books}` – liczba
 * serii i autorów na półce oraz posiadanych książek.
 */
export function isTabEmpty(tab, { series = 0, authors = 0, books = 0 } = {}) {
  switch (tab) {
    case 'serie':
      return series === 0;
    case 'autorzy':
      return authors === 0;
    case 'ksiazki':
      return books === 0;
    default:
      return series === 0 && authors === 0 && books === 0;
  }
}

/**
 * Dwa panele (app.js, zastępczy cel fokusu): czy fokus zgubiono – brak elementu, <body>, element
 * odłączony od dokumentu albo wciąż w warstwie (zamykana warstwa zaraz zniknie; fokus w otwartej
 * warstwie modalnej chroni osobno hasOpenModal()). `active` – document.activeElement.
 */
export function isFocusLost(active, body) {
  if (!active || active === body || !active.isConnected) return true;
  return Boolean(typeof active.closest === 'function' && active.closest('[data-layer]'));
}

/**
 * Zastępczy cel zgubionego fokusu (app.js, gdy element otwierający warstwę zniknął): `'list'` albo
 * `'detail'` – tytuł panelu w dwóch panelach (`lastPane` – panel, w którym fokus był ostatnio;
 * szczegóły tylko przy wybranej pozycji); `'screen'` – tytuł ekranu w wąskim układzie, ale tylko gdy
 * układ zmienił się przy otwartej warstwie; inaczej `null` (telefon: jak dotąd – nic).
 */
export function focusFallbackTarget({ split, layoutSwitched = false, lastPane = 'list', hasDetail = false }) {
  if (split) return lastPane === 'detail' && hasDetail ? 'detail' : 'list';
  return layoutSwitched ? 'screen' : null;
}

const SPLIT_PLACEHOLDERS = Object.freeze({
  serie: {
    icon: 'books',
    title: 'Wybierz serię z listy',
    message: 'Zobaczysz tu jej tomy i to, czego jeszcze brakuje.',
  },
  autorzy: {
    icon: 'persons',
    title: 'Wybierz autora z listy',
    message: 'Zobaczysz tu serie i książki wybranego autora.',
  },
  ksiazki: {
    icon: 'book',
    title: 'Wybierz książkę z listy',
    message: 'Zobaczysz tu jej status, dane wydania i notatki.',
  },
  szukaj: {
    icon: 'search',
    title: 'Wybierz pozycję z listy',
    message: 'Zobaczysz tu szczegóły wybranego autora, serii albo książki.',
  },
});

/** Treść prawego panelu, gdy nic nie jest wybrane: `{icon, title, message}`, a przy pustej liście `null`. */
export function splitPlaceholder(tab, empty) {
  if (empty) return null;
  return SPLIT_PLACEHOLDERS[tab] || null;
}

/** Komunikat dla czytników ekranu po zmianie wyboru na liście („Szczegóły: Wiedźmin”). */
export function selectionAnnouncement(title) {
  return title ? `Szczegóły: ${title}` : '';
}

// ---------------------------------------------------------------------------
// NumberField – reguły iOS NumberRow (z poprawkami ze specyfikacji)
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Tekst pola dla wartości: 0 (i brak wartości) = „brak”, czyli puste pole. */
export function numberText(value) {
  const n = Number(value);
  return !Number.isFinite(n) || n === 0 ? '' : String(Math.trunc(n));
}

/**
 * Przetwarza wpisany tekst jak iOS NumberRow: zostają tylko cyfry ASCII
 * (maks. 4), wartość jest przycinana do zakresu, a gdy przycięcie zmieniło liczbę,
 * tekst pokazuje wartość po przycięciu (1500 w zakresie 0…999 → „999”).
 * Zwraca `{text, value}`.
 */
export function applyNumberInput(raw, min = 0, max = 999) {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '').slice(0, 4);
  const parsed = digits ? parseInt(digits, 10) : 0;
  const value = clamp(parsed, min, max);
  const text = parsed === value ? digits : numberText(value);
  return { text, value };
}

/** Krok przycisków −/+ w zakresie. */
export function stepNumber(value, delta, min = 0, max = 999) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return clamp(n + delta, min, max);
}

// ---------------------------------------------------------------------------
// Okładki
// ---------------------------------------------------------------------------

/** Rozmiar czcionki napisu na okładce (iOS: zmniejszanie do 40 %, jedna linia). */
export function coverFontSize(width, text, isLabel) {
  const base = width * (isLabel ? 0.44 : 0.34);
  const length = Math.max(1, [...String(text ?? '')].length);
  const fitting = (width * 0.79) / (length * 0.62);
  return Math.max(base * 0.4, Math.min(base, fitting));
}

// ---------------------------------------------------------------------------
// Menu – wyliczanie położenia
// ---------------------------------------------------------------------------

/**
 * Położenie wyskakującego menu względem prostokąta kotwicy:
 * pod kotwicą (albo nad, gdy brakuje miejsca), wyrównane do początku lub końca,
 * zawsze w granicach okna z marginesem. Zwraca `{left, top, maxHeight, originX, originY}`.
 */
export function placeMenu(anchor, size, viewport, { align = 'end', gap = 6, margin = 8 } = {}) {
  const maxHeight = Math.max(120, viewport.height - margin * 2);
  const height = Math.min(size.height, maxHeight);
  const width = Math.min(size.width, viewport.width - margin * 2);

  let left = align === 'start' ? anchor.left : anchor.right - width;
  left = clamp(left, margin, Math.max(margin, viewport.width - margin - width));

  const below = viewport.height - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  let top;
  let originY;
  if (height <= below || below >= above) {
    top = anchor.bottom + gap;
    originY = 'top';
  } else {
    top = anchor.top - gap - height;
    originY = 'bottom';
  }
  top = clamp(top, margin, Math.max(margin, viewport.height - margin - height));
  const anchorCenter = (anchor.left + anchor.right) / 2;
  const originX = anchorCenter - left < width / 2 ? 'left' : 'right';
  return { left, top, maxHeight, originX, originY };
}
