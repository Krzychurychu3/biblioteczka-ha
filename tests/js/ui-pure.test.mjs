// Testy czystych funkcji frontendu: trasy, NumberField (reguły iOS NumberRow),
// położenie menu, rozmiar napisu na okładce, sortowanie i indeksy magazynu,
// stan zachowywany między ekranami, wpisy warstw po przeładowaniu, odstępy odpytywania
// oraz tryb dwóch paneli (wybór z listy, historia, strzałki, teksty prawego panelu).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../../biblioteczka/app/biblioteczka/static/js');
const pure = await import(path.join(js, 'ui/pure.js'));
const store = await import(path.join(js, 'store.js'));
const retained = await import(path.join(js, 'ui/retained.js'));
const historyQueue = await import(path.join(js, 'ui/history.js'));
const router = await import(path.join(js, 'ui/router.js'));
const overlay = await import(path.join(js, 'ui/overlay.js'));

const { parseRoute, formatRoute, pushRouteEntry, parentRoute, topEntry } = pure;

// ---------------------------------------------------------------------------
// Trasy
// ---------------------------------------------------------------------------

test('korzenie kart', () => {
  for (const tab of ['serie', 'autorzy', 'ksiazki', 'szukaj']) {
    const route = parseRoute(`#/${tab}`);
    assert.equal(route.tab, tab);
    assert.deepEqual(route.stack, []);
    assert.equal(route.path, `/${tab}`);
  }
});

test('nieznana albo pusta trasa → null (router przechodzi na #/serie)', () => {
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('#'), null);
  assert.equal(parseRoute('#/'), null);
  assert.equal(parseRoute('#/nieznane'), null);
  assert.equal(parseRoute(undefined), null);
});

test('szczegóły w naturalnej postaci: #/serie/:id i #/autorzy/:id', () => {
  assert.deepEqual(parseRoute('#/serie/5').stack, [{ type: 'series', id: 5 }]);
  assert.deepEqual(parseRoute('#/autorzy/12').stack, [{ type: 'author', id: 12 }]);
  assert.equal(parseRoute('#/serie/5').path, '/serie/5');
  assert.equal(parseRoute('#/autorzy/12').path, '/autorzy/12');
});

test('głębszy stos w jednej karcie', () => {
  const route = parseRoute('#/serie/5/autor/3/seria/7');
  assert.equal(route.tab, 'serie');
  assert.deepEqual(route.stack, [
    { type: 'series', id: 5 },
    { type: 'author', id: 3 },
    { type: 'series', id: 7 },
  ]);
  assert.equal(route.path, '/serie/5/autor/3/seria/7');
  assert.deepEqual(topEntry(route), { type: 'series', id: 7 });
});

test('karty bez naturalnego typu używają par segment/id', () => {
  const route = parseRoute('#/szukaj/seria/5');
  assert.deepEqual(route.stack, [{ type: 'series', id: 5 }]);
  assert.equal(route.path, '/szukaj/seria/5');
  assert.equal(parseRoute('#/ksiazki/autor/2').path, '/ksiazki/autor/2');
  // Goła liczba w karcie bez naturalnego typu jest odrzucana.
  assert.equal(parseRoute('#/ksiazki/4').path, '/ksiazki');
});

test('niepoprawny ogon jest obcinany do kanonicznej postaci', () => {
  assert.equal(parseRoute('#/serie/abc').path, '/serie');
  assert.equal(parseRoute('#/serie/0').path, '/serie');
  assert.equal(parseRoute('#/serie/05').path, '/serie');
  assert.equal(parseRoute('#/serie/-3').path, '/serie');
  assert.equal(parseRoute('#/serie/5/autor').path, '/serie/5');
  assert.equal(parseRoute('#/serie/5/cos/3').path, '/serie/5');
  assert.equal(parseRoute('#/serie/5/autor/x/seria/2').path, '/serie/5');
  assert.equal(parseRoute('#//serie//5//').path, '/serie/5');
  assert.equal(parseRoute('/serie/5').path, '/serie/5');
});

test('wielkość liter i polska nazwa karty', () => {
  assert.equal(parseRoute('#/Serie/5').path, '/serie/5');
  assert.equal(parseRoute('#/ksi%C4%85%C5%BCki').path, '/ksiazki');
  assert.equal(parseRoute('#/książki').tab, 'ksiazki');
});

test('parametry zapytania', () => {
  const route = parseRoute('#/szukaj?q=wied%C5%BAmin&x=1&q=drugi');
  assert.equal(route.query.q, 'wiedźmin');
  assert.equal(route.query.x, '1');
  assert.equal(parseRoute(`#${route.path}`).query.q, 'wiedźmin');
  assert.equal(formatRoute({ tab: 'szukaj', stack: [], query: { q: '' } }), '/szukaj');
});

test('formatRoute ↔ parseRoute', () => {
  const samples = ['/serie', '/serie/1', '/autorzy/9/seria/4', '/ksiazki/seria/2/autor/8', '/szukaj/autor/1/seria/3/autor/5'];
  for (const sample of samples) assert.equal(parseRoute(sample).path, sample);
});

test('pushRouteEntry i parentRoute', () => {
  let route = parseRoute('#/autorzy');
  route = pushRouteEntry(route, { type: 'author', id: 3 });
  assert.equal(route.path, '/autorzy/3');
  route = pushRouteEntry(route, { type: 'series', id: 8 });
  assert.equal(route.path, '/autorzy/3/seria/8');
  route = parentRoute(route);
  assert.equal(route.path, '/autorzy/3');
  route = parentRoute(route);
  assert.equal(route.path, '/autorzy');
  assert.equal(parentRoute(route), null);
  // Z wyszukiwania: pierwsze wejście w postaci pary.
  assert.equal(pushRouteEntry(parseRoute('#/szukaj?q=lem'), { type: 'author', id: 2 }).path, '/szukaj/autor/2');
  // Seria otwarta z karty autorów nie ma postaci naturalnej.
  assert.equal(pushRouteEntry(parseRoute('#/autorzy'), { type: 'series', id: 4 }).path, '/autorzy/seria/4');
  assert.throws(() => pushRouteEntry(route, { type: 'shelf', id: 1 }));
});

test('książka na stosie: segment „ksiazka” w każdej karcie, bez postaci naturalnej', () => {
  const samples = [
    '/ksiazki/ksiazka/12',
    '/serie/1/ksiazka/12',
    '/autorzy/3/ksiazka/12',
    '/szukaj/ksiazka/7',
    '/ksiazki/ksiazka/12/autor/3/seria/1',
  ];
  for (const sample of samples) {
    assert.equal(parseRoute('#' + sample).path, sample);
    assert.equal(formatRoute(parseRoute(sample)), sample);
  }
  assert.deepEqual(parseRoute('#/ksiazki/ksiazka/12').stack, [{ type: 'book', id: 12 }]);
  assert.deepEqual(parseRoute('#/ksiazki/ksiazka/12/autor/3/seria/1').stack, [
    { type: 'book', id: 12 },
    { type: 'author', id: 3 },
    { type: 'series', id: 1 },
  ]);
  // Karta „Książki” nie ma typu naturalnego, a niepoprawny id obcina ogon.
  assert.equal(parseRoute('#/ksiazki/12').path, '/ksiazki');
  assert.equal(parseRoute('#/serie/1/ksiazka/x').path, '/serie/1');
  assert.equal(parseRoute('#/serie/1/ksiazka').path, '/serie/1');
});

test('pushRouteEntry, parentRoute i topEntry z książką', () => {
  const route = pushRouteEntry(parseRoute('#/serie/1'), { type: 'book', id: '5' });
  assert.equal(route.path, '/serie/1/ksiazka/5');
  assert.deepEqual(topEntry(route), { type: 'book', id: 5 });
  assert.equal(topEntry(route).id, 5);
  assert.equal(parentRoute(route).path, '/serie/1');
  const fromBook = pushRouteEntry(parseRoute('#/ksiazki/ksiazka/12'), { type: 'author', id: 3 });
  assert.equal(fromBook.path, '/ksiazki/ksiazka/12/autor/3');
  assert.deepEqual(topEntry(parentRoute(fromBook)), { type: 'book', id: 12 });
  assert.throws(() => pushRouteEntry(route, { type: 'nieznany', id: 1 }));
});

test('stos ma ograniczoną głębokość', () => {
  const long = '/serie' + '/autor/1/seria/2'.repeat(40);
  assert.equal(parseRoute(long).stack.length, pure.MAX_STACK_DEPTH);
});

// ---------------------------------------------------------------------------
// NumberField – reguły iOS NumberRow
// ---------------------------------------------------------------------------

test('numberText: 0 i brak wartości to puste pole', () => {
  assert.equal(pure.numberText(0), '');
  assert.equal(pure.numberText(null), '');
  assert.equal(pure.numberText(undefined), '');
  assert.equal(pure.numberText(NaN), '');
  assert.equal(pure.numberText(7), '7');
  assert.equal(pure.numberText(2024), '2024');
});

test('applyNumberInput: tylko cyfry ASCII, najwyżej 4', () => {
  const { applyNumberInput } = pure;
  assert.deepEqual(applyNumberInput('12', 0, 999), { text: '12', value: 12 });
  assert.deepEqual(applyNumberInput('1a2', 0, 999), { text: '12', value: 12 });
  assert.deepEqual(applyNumberInput('-5', 0, 9999), { text: '5', value: 5 });
  assert.deepEqual(applyNumberInput('²', 0, 999), { text: '', value: 0 });
  assert.deepEqual(applyNumberInput('٣', 0, 999), { text: '', value: 0 });
  assert.deepEqual(applyNumberInput('１２', 0, 999), { text: '', value: 0 });
  assert.deepEqual(applyNumberInput('12000', 0, 9999), { text: '1200', value: 1200 });
  assert.deepEqual(applyNumberInput('', 0, 999), { text: '', value: 0 });
  assert.deepEqual(applyNumberInput(' 3 ', 0, 999), { text: '3', value: 3 });
});

test('applyNumberInput: przycięcie do zakresu zmienia tekst (1500 → 999)', () => {
  const { applyNumberInput } = pure;
  assert.deepEqual(applyNumberInput('1500', 0, 999), { text: '999', value: 999 });
  assert.deepEqual(applyNumberInput('2500', 0, 2100), { text: '2100', value: 2100 });
  assert.deepEqual(applyNumberInput('9999', 0, 9999), { text: '9999', value: 9999 });
});

test('applyNumberInput: zera z przodu zostają, „0” pokazuje się jak w iOS', () => {
  const { applyNumberInput } = pure;
  assert.deepEqual(applyNumberInput('007', 0, 999), { text: '007', value: 7 });
  assert.deepEqual(applyNumberInput('0', 0, 999), { text: '0', value: 0 });
});

test('stepNumber: przyciski −/+ w zakresie', () => {
  const { stepNumber } = pure;
  assert.equal(stepNumber(0, -1, 0, 999), 0);
  assert.equal(stepNumber(0, 1, 0, 999), 1);
  assert.equal(stepNumber(999, 1, 0, 999), 999);
  assert.equal(stepNumber(5, -1, 0, 999), 4);
  assert.equal(stepNumber(null, 1, 0, 999), 1);
});

// ---------------------------------------------------------------------------
// Menu i okładki
// ---------------------------------------------------------------------------

test('placeMenu: pod kotwicą, wyrównane do prawej krawędzi', () => {
  const place = pure.placeMenu(
    { left: 300, right: 344, top: 10, bottom: 54 },
    { width: 240, height: 200 },
    { width: 390, height: 800 },
  );
  assert.equal(place.left, 344 - 240);
  assert.equal(place.top, 60);
  assert.equal(place.originY, 'top');
  assert.equal(place.originX, 'right');
});

test('placeMenu: nie wychodzi poza okno i otwiera się w górę przy dolnej krawędzi', () => {
  const place = pure.placeMenu(
    { left: 4, right: 48, top: 740, bottom: 784 },
    { width: 240, height: 300 },
    { width: 320, height: 800 },
    { align: 'start' },
  );
  assert.ok(place.left >= 8);
  assert.ok(place.left + 240 <= 320 - 8 + 0.001);
  assert.equal(place.originY, 'bottom');
  assert.equal(place.top, 740 - 6 - 300);
});

test('placeMenu: zbyt wysokie menu dostaje maxHeight i mieści się w oknie', () => {
  const place = pure.placeMenu(
    { left: 100, right: 140, top: 300, bottom: 340 },
    { width: 200, height: 2000 },
    { width: 400, height: 600 },
  );
  assert.equal(place.maxHeight, 584);
  assert.ok(place.top >= 8);
});

test('coverFontSize: numer tomu większy niż inicjały, długie napisy zmniejszane do 40 %', () => {
  const w = 38;
  assert.equal(pure.coverFontSize(w, '3', true), w * 0.44);
  assert.equal(pure.coverFontSize(w, 'HP', false), w * 0.34);
  assert.ok(pure.coverFontSize(w, '999', true) < w * 0.44);
  assert.equal(pure.coverFontSize(w, '123456789', true), w * 0.44 * 0.4);
});

// ---------------------------------------------------------------------------
// Magazyn: sortowanie i indeksy
// ---------------------------------------------------------------------------

test('sortLocalized: polski alfabet, liczby numerycznie, remis rozstrzyga id', () => {
  const items = [
    { id: 1, name: 'Żaba' },
    { id: 2, name: 'tom 10' },
    { id: 3, name: 'Łódź' },
    { id: 4, name: 'lody' },
    { id: 5, name: 'tom 2' },
    { id: 6, name: 'Ćma' },
    { id: 7, name: 'Cma' },
    { id: 9, name: 'abc' },
    { id: 8, name: 'abc' },
  ];
  const names = store.sortLocalized(items, 'name').map((i) => `${i.name}#${i.id}`);
  assert.deepEqual(names, ['abc#8', 'abc#9', 'Cma#7', 'Ćma#6', 'lody#4', 'Łódź#3', 'tom 2#5', 'tom 10#2', 'Żaba#1']);
  // Funkcja klucza i brak wartości.
  assert.deepEqual(
    store.sortLocalized([{ id: 2, t: null }, { id: 1, t: 'b' }], (x) => x.t).map((x) => x.id),
    [2, 1],
  );
  assert.deepEqual(store.sortLocalized(null), []);
});

test('buildLibrary: indeksy i selektory półki', () => {
  const state = {
    revision: 7,
    appVersion: '0.1.0',
    meta: { catalogAvailable: true },
    authors: [
      { id: 1, name: 'Stanisław Lem', isOnShelf: true },
      { id: 2, name: 'Andrzej Sapkowski', isOnShelf: true },
      { id: 3, name: 'Katalogowy', isOnShelf: false },
    ],
    series: [
      { id: 10, name: 'Wiedźmin', authorId: 2, isOnShelf: true },
      { id: 11, name: 'Bajki', authorId: 3, isOnShelf: false },
      { id: 12, name: 'Cyberiada', authorId: 1, isOnShelf: true },
    ],
    books: [
      { id: 100, title: 'Ostatnie życzenie', authorId: 2, seriesId: 10, isOwned: true },
      { id: 101, title: 'Krew elfów', authorId: 2, seriesId: 10, isOwned: false },
      { id: 102, title: 'Solaris', authorId: 1, seriesId: null, isOwned: true },
      { id: 103, title: 'Bajka', authorId: 3, seriesId: 11, isOwned: false },
      { id: 104, title: 'Anonim', authorId: null, seriesId: null, isOwned: true },
    ],
  };
  const lib = store.buildLibrary(state);
  assert.equal(lib.loaded, true);
  assert.equal(lib.revision, 7);
  assert.equal(lib.authorsById.get(2).name, 'Andrzej Sapkowski');
  assert.equal(lib.seriesById.get(12).name, 'Cyberiada');
  assert.equal(lib.booksById.get(104).title, 'Anonim');
  assert.deepEqual(lib.booksBySeries.get(10).map((b) => b.id), [101, 100]);
  assert.deepEqual(lib.booksByAuthor.get(2).map((b) => b.id), [101, 100]);
  assert.equal(lib.booksByAuthor.has(null), false);
  assert.deepEqual(lib.seriesByAuthor.get(1).map((s) => s.id), [12]);
  assert.deepEqual(store.visibleSeries(lib).map((s) => s.name), ['Cyberiada', 'Wiedźmin']);
  assert.deepEqual(store.visibleAuthors(lib).map((a) => a.name), ['Andrzej Sapkowski', 'Stanisław Lem']);
  assert.deepEqual(store.ownedBooks(lib).map((b) => b.title), ['Anonim', 'Ostatnie życzenie', 'Solaris']);
  // Selektory są zapamiętywane dla danego snapshotu.
  assert.equal(store.visibleSeries(lib), store.visibleSeries(lib));
  assert.deepEqual(store.allSeriesSorted(lib).map((s) => s.id), [11, 12, 10]);
});

test('buildLibrary(null): pusty, niewczytany stan', () => {
  const lib = store.buildLibrary(null);
  assert.equal(lib.loaded, false);
  assert.equal(lib.authors.length, 0);
  assert.deepEqual(store.ownedBooks(lib), []);
});

// ---------------------------------------------------------------------------
// Stan zachowywany po odmontowaniu ekranu (zapytanie wyszukiwania, filtr serii)
// ---------------------------------------------------------------------------

test('retained: wartość przeżywa odmontowanie ekranu, a domyślna jest tylko do pierwszego zapisu', () => {
  retained.forgetRetained();
  assert.equal(retained.retainedValue('szukaj.query', ''), '');
  let calls = 0;
  assert.equal(retained.retainedValue('serie.filter', () => (calls += 1, 'all')), 'all');
  assert.equal(calls, 1);
  retained.retainValue('szukaj.query', 'wied');
  retained.retainValue('serie.filter', 'incomplete');
  // „Ponowne zamontowanie” ekranu czyta zapamiętaną wartość, nie domyślną.
  assert.equal(retained.retainedValue('szukaj.query', ''), 'wied');
  assert.equal(retained.retainedValue('serie.filter', () => (calls += 1, 'all')), 'incomplete');
  assert.equal(calls, 1);
  // Pusty napis to też zapamiętana wartość.
  retained.retainValue('szukaj.query', '');
  assert.equal(retained.retainedValue('szukaj.query', 'x'), '');
  retained.forgetRetained('serie.filter');
  assert.equal(retained.retainedValue('serie.filter', 'all'), 'all');
  retained.forgetRetained();
  assert.equal(retained.retainedValue('szukaj.query', 'domyślne'), 'domyślne');
  assert.equal(typeof retained.useRetainedState, 'function');
});

// ---------------------------------------------------------------------------
// Wpisy warstw (arkuszy) sprzed przeładowania strony
// ---------------------------------------------------------------------------

/**
 * Atrapa historii przeglądarki: `back()` asynchronicznie zmienia wpis i wysyła `popstate`.
 * `calls` – dziennik operacji na historii (także atrapy paska adresu z fakeLocation).
 */
function fakeHistory(entries, { stuck = false } = {}) {
  const listeners = new Set();
  const hashOf = (url) => String(url).slice(String(url).indexOf('#'));
  const fake = {
    entries: entries.map((state) => ({ state })),
    index: entries.length - 1,
    backs: 0,
    calls: [],
    get state() {
      return fake.entries[fake.index].state;
    },
    replaceState(state, _title, url) {
      fake.calls.push('replaceState');
      fake.entries[fake.index].state = state;
      if (url !== undefined && String(url).includes('#')) fake.entries[fake.index].hash = hashOf(url);
    },
    pushState(state, _title, url) {
      fake.calls.push('pushState');
      const hash = url !== undefined && String(url).includes('#') ? hashOf(url) : fake.entries[fake.index].hash;
      fake.entries.splice(fake.index + 1);
      fake.entries.push({ state, hash });
      fake.index = fake.entries.length - 1;
    },
    back() {
      fake.backs += 1;
      if (stuck || fake.index === 0) return;
      setImmediate(() => {
        fake.index -= 1;
        for (const listener of [...listeners]) listener({ state: fake.state });
      });
    },
    go(delta) {
      fake.gos = (fake.gos || 0) + 1;
      const target = fake.index + delta;
      if (stuck || target < 0 || target >= fake.entries.length) return;
      setImmediate(() => {
        fake.index = target;
        for (const listener of [...listeners]) listener({ state: fake.state });
      });
    },
  };
  const saved = { history: globalThis.history, add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  globalThis.history = fake;
  globalThis.addEventListener = (type, fn) => type === 'popstate' && listeners.add(fn);
  globalThis.removeEventListener = (type, fn) => type === 'popstate' && listeners.delete(fn);
  fake.listeners = listeners;
  fake.restore = () => {
    for (const [key, value] of [['history', saved.history], ['addEventListener', saved.add], ['removeEventListener', saved.remove]]) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  return fake;
}

test('po przeładowaniu z otwartym arkuszem i dialogiem start schodzi z obu wpisów warstw', async () => {
  const fake = fakeHistory([
    { bibRoute: '/serie', bibFrom: null },
    { bibRoute: '/serie/1', bibFrom: '/serie' },
    { bibRoute: '/serie/1', bibFrom: '/serie', bibLayer: 7 },
    { bibRoute: '/serie/1', bibFrom: '/serie', bibLayer: 8 },
  ]);
  try {
    await historyQueue.historyLeaveOrphanLayers();
    assert.equal(fake.backs, 2);
    assert.equal(fake.index, 1);
    // Bieżący wpis to ekran serii otwarty z listy – pierwsze „wstecz” wróci na #/serie.
    assert.deepEqual(fake.state, { bibRoute: '/serie/1', bibFrom: '/serie' });
    assert.equal(fake.listeners.size, 0);
  } finally {
    fake.restore();
  }
});

test('bez wpisu warstwy start niczego nie cofa', async () => {
  const fake = fakeHistory([{ bibRoute: '/serie', bibFrom: null }, { bibRoute: '/serie/1', bibFrom: '/serie' }]);
  try {
    await historyQueue.historyLeaveOrphanLayers();
    assert.equal(fake.backs, 0);
    assert.equal(fake.index, 1);
  } finally {
    fake.restore();
  }
});

test('gdy cofnięcie nie przychodzi, start usuwa tylko znacznik warstwy', async () => {
  const fake = fakeHistory([{ bibRoute: '/serie/1', bibFrom: '/serie', bibLayer: 3 }], { stuck: true });
  try {
    await historyQueue.historyLeaveOrphanLayers({ timeout: 10 });
    assert.equal(fake.backs, 1);
    assert.deepEqual(fake.state, { bibRoute: '/serie/1', bibFrom: '/serie' });
    assert.equal(fake.listeners.size, 0);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Dwa panele: wybór z listy
// ---------------------------------------------------------------------------

test('próg dwóch paneli: jedna stała dla JS i CSS', () => {
  assert.equal(pure.SPLIT_MIN_WIDTH, 1008);
  assert.equal(pure.SPLIT_QUERY, '(min-width: 1008px)');
});

test('rootRoute i selectionRoute: korzeń karty i jeden wybrany ekran (bez zapytania)', () => {
  const deep = parseRoute('#/serie/1/autor/2/seria/3');
  assert.deepEqual(pure.rootRoute(deep), { tab: 'serie', stack: [], query: {}, path: '/serie' });
  assert.equal(pure.rootRoute(parseRoute('#/szukaj?q=lem')).path, '/szukaj');
  assert.deepEqual(pure.selectionRoute(deep, { type: 'series', id: '5' }), {
    tab: 'serie',
    stack: [{ type: 'series', id: 5 }],
    query: {},
    path: '/serie/5',
  });
  assert.equal(pure.selectionRoute(parseRoute('#/szukaj?q=wied'), { type: 'book', id: 7 }).path, '/szukaj/ksiazka/7');
  assert.equal(pure.selectionRoute(parseRoute('#/ksiazki'), { type: 'book', id: 12 }).path, '/ksiazki/ksiazka/12');
  assert.equal(pure.selectionRoute(parseRoute('#/autorzy'), { type: 'author', id: 3 }).path, '/autorzy/3');
  assert.throws(() => pure.selectionRoute(deep, { type: 'nieznany', id: 1 }));
});

test('selectionMode: push z korzenia, replace przy zmianie wyboru i z głębszego ekranu, none dla tej samej trasy', () => {
  const series1 = { type: 'series', id: 1 };
  assert.equal(pure.selectionMode(parseRoute('#/serie'), series1), 'push');
  assert.equal(pure.selectionMode(parseRoute('#/szukaj?q=lem'), { type: 'author', id: 2 }), 'push');
  assert.equal(pure.selectionMode(parseRoute('#/serie/2'), series1), 'replace');
  assert.equal(pure.selectionMode(parseRoute('#/serie/2/autor/3/seria/4'), series1), 'replace');
  assert.equal(pure.selectionMode(parseRoute('#/serie/1'), series1), 'none');
  assert.equal(pure.selectionMode(parseRoute('#/serie/1'), { type: 'series', id: '1' }), 'none');
  // Wybrany wiersz kliknięty, gdy szczegóły są głębiej: powrót do niego bez nowego wpisu.
  assert.equal(pure.selectionMode(parseRoute('#/serie/1/autor/2'), series1), 'replace');
});

test('selectedEntry i isSelectedEntry: typ i liczbowy id muszą się zgadzać', () => {
  assert.equal(pure.selectedEntry(parseRoute('#/serie')), null);
  assert.deepEqual(pure.selectedEntry(parseRoute('#/serie/1/autor/2')), { type: 'series', id: 1 });
  const selected = { type: 'book', id: 12 };
  assert.equal(pure.isSelectedEntry(selected, 'book', 12), true);
  assert.equal(pure.isSelectedEntry(selected, 'book', '12'), true);
  assert.equal(pure.isSelectedEntry(selected, 'book', 13), false);
  assert.equal(pure.isSelectedEntry(selected, 'series', 12), false);
  assert.equal(pure.isSelectedEntry(null, 'book', 12), false);
});

test('listKeyTarget: strzałki w granicach listy, Home/End, inne klawisze nic nie robią', () => {
  const { listKeyTarget } = pure;
  assert.equal(listKeyTarget('ArrowDown', 0, 5), 1);
  assert.equal(listKeyTarget('ArrowDown', 4, 5), 4);
  assert.equal(listKeyTarget('ArrowDown', -1, 5), 0);
  assert.equal(listKeyTarget('ArrowUp', 3, 5), 2);
  assert.equal(listKeyTarget('ArrowUp', 0, 5), 0);
  assert.equal(listKeyTarget('ArrowUp', -1, 5), null);
  assert.equal(listKeyTarget('Home', 3, 5), 0);
  assert.equal(listKeyTarget('End', 1, 5), 4);
  assert.equal(listKeyTarget('Home', -1, 5), null);
  assert.equal(listKeyTarget('End', -1, 5), null);
  // Bez skrótów literowych (j/k) i bez reakcji na inne klawisze.
  assert.equal(listKeyTarget('j', 1, 5), null);
  assert.equal(listKeyTarget('k', 1, 5), null);
  assert.equal(listKeyTarget('Enter', 1, 5), null);
  assert.equal(listKeyTarget('ArrowDown', 0, 0), null);
  assert.equal(listKeyTarget('ArrowDown', -1, 0), null);
});

test('splitPlaceholder: zachęta do wyboru w każdej karcie, a przy pustej liście – nic', () => {
  assert.deepEqual(pure.splitPlaceholder('serie', false), {
    icon: 'books',
    title: 'Wybierz serię z listy',
    message: 'Zobaczysz tu jej tomy i to, czego jeszcze brakuje.',
  });
  assert.deepEqual(pure.splitPlaceholder('autorzy', false), {
    icon: 'persons',
    title: 'Wybierz autora z listy',
    message: 'Zobaczysz tu serie i książki wybranego autora.',
  });
  assert.deepEqual(pure.splitPlaceholder('ksiazki', false), {
    icon: 'book',
    title: 'Wybierz książkę z listy',
    message: 'Zobaczysz tu jej status, dane wydania i notatki.',
  });
  assert.deepEqual(pure.splitPlaceholder('szukaj', false), {
    icon: 'search',
    title: 'Wybierz pozycję z listy',
    message: 'Zobaczysz tu szczegóły wybranego autora, serii albo książki.',
  });
  for (const tab of pure.TABS) assert.equal(pure.splitPlaceholder(tab, true), null);
});

test('isTabEmpty: pusta lista karty (Szukaj – gdy nie ma niczego)', () => {
  const none = { series: 0, authors: 0, books: 0 };
  for (const tab of pure.TABS) assert.equal(pure.isTabEmpty(tab, none), true);
  assert.equal(pure.isTabEmpty('serie', { series: 2, authors: 0, books: 0 }), false);
  assert.equal(pure.isTabEmpty('autorzy', { series: 2, authors: 0, books: 5 }), true);
  assert.equal(pure.isTabEmpty('ksiazki', { series: 0, authors: 1, books: 3 }), false);
  assert.equal(pure.isTabEmpty('ksiazki', { series: 4, authors: 1, books: 0 }), true);
  assert.equal(pure.isTabEmpty('szukaj', { series: 0, authors: 0, books: 1 }), false);
});

test('selectionAnnouncement i nazwy paneli list', () => {
  assert.equal(pure.selectionAnnouncement('Wiedźmin'), 'Szczegóły: Wiedźmin');
  assert.equal(pure.selectionAnnouncement(''), '');
  assert.equal(pure.selectionAnnouncement(undefined), '');
  assert.deepEqual({ ...pure.LIST_PANE_LABELS }, {
    serie: 'Lista serii',
    autorzy: 'Lista autorów',
    ksiazki: 'Lista książek',
    szukaj: 'Wyszukiwanie',
  });
});

// ---------------------------------------------------------------------------
// Dwa panele: historia (podmiana z zachowaniem bibFrom, dwa szybkie wybory)
// ---------------------------------------------------------------------------

/**
 * Atrapa paska adresu do atrapy historii: `hash = …` dodaje wpis, `replace(url)` podmienia
 * bieżący – w obu przypadkach nowy wpis ma `state === null`, jak w przeglądarce.
 * `onHashChange` – wywoływane w osobnym zadaniu po zmianie fragmentu (jak `hashchange`).
 */
function fakeLocation(fake, hash, { onHashChange } = {}) {
  const base = 'http://dom.test/api/hassio_ingress/tok/';
  fake.entries.forEach((entry, index) => {
    entry.hash = index === fake.index ? hash : entry.hash || '#/serie';
  });
  const changed = () => onHashChange && setTimeout(onHashChange, 0);
  const location = {
    get href() {
      return base + fake.entries[fake.index].hash;
    },
    get hash() {
      return fake.entries[fake.index].hash;
    },
    set hash(value) {
      fake.calls.push('hash');
      fake.entries.splice(fake.index + 1);
      fake.entries.push({ state: null, hash: '#' + String(value).replace(/^#/, '') });
      fake.index = fake.entries.length - 1;
      changed();
    },
    replace(url) {
      fake.calls.push('replace');
      const before = fake.entries[fake.index].hash;
      fake.entries[fake.index] = { state: null, hash: url.slice(url.indexOf('#')) };
      if (fake.entries[fake.index].hash !== before) changed();
    },
  };
  const saved = globalThis.location;
  globalThis.location = location;
  const restore = fake.restore;
  fake.restore = () => {
    restore();
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  };
  return location;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('historyReplace z keepFrom: nowy adres dziedziczy bibFrom podmienianego wpisu', async () => {
  const fake = fakeHistory([
    { bibRoute: '/serie', bibFrom: null },
    { bibRoute: '/serie/1', bibFrom: '/serie' },
  ]);
  fakeLocation(fake, '#/serie/1');
  try {
    historyQueue.historyReplace('/serie/2', { keepFrom: true });
    await settle();
    assert.equal(fake.entries.length, 2);
    assert.equal(fake.entries[1].hash, '#/serie/2');
    assert.deepEqual(fake.state, { bibRoute: '/serie/2', bibFrom: '/serie' });
  } finally {
    fake.restore();
  }
});

test('historyReplace bez keepFrom: jak dotąd – wpis bez znacznika (router oznaczy go sam)', async () => {
  const fake = fakeHistory([
    { bibRoute: '/serie', bibFrom: null },
    { bibRoute: '/serie/1', bibFrom: '/serie' },
  ]);
  fakeLocation(fake, '#/serie/1');
  try {
    historyQueue.historyReplace('/serie/2');
    await settle();
    assert.equal(fake.entries[1].hash, '#/serie/2');
    assert.equal(fake.state, null);
  } finally {
    fake.restore();
  }
});

test('historyReplace z keepFrom na wpisie bez znacznika niczego nie stempluje', async () => {
  const fake = fakeHistory([{ bibRoute: '/serie', bibFrom: null }, null]);
  fakeLocation(fake, '#/serie/1');
  try {
    historyQueue.historyReplace('/serie/2', { keepFrom: true });
    await settle();
    assert.equal(fake.entries[1].hash, '#/serie/2');
    assert.equal(fake.state, null);
  } finally {
    fake.restore();
  }
});

test('selectEntry: pierwszy wybór dodaje wpis, drugi przed hashchange podmienia go; zamiar jest jednorazowy', async () => {
  const fake = fakeHistory([{ bibRoute: '/serie', bibFrom: null }]);
  fakeLocation(fake, '#/serie');
  try {
    assert.equal(router.getRoute().path, '/serie');
    assert.equal(router.selectEntry({ type: 'series', id: 3 }), true);
    assert.equal(router.selectEntry({ type: 'series', id: 5 }, { focusDetail: true }), true);
    // Ta sama pozycja co ostatni (jeszcze nieobsłużony) wybór – nic się nie dzieje.
    assert.equal(router.selectEntry({ type: 'series', id: 5 }), false);
    await settle();
    // Jeden nowy wpis (push + podmiana), oznaczony od razu przez kolejkę (HIST3-1) – bibFrom = '/serie'.
    assert.equal(fake.entries.length, 2);
    assert.equal(fake.entries[1].hash, '#/serie/5');
    assert.deepEqual(fake.state, { bibRoute: '/serie/5', bibFrom: '/serie' });
    assert.deepEqual(fake.entries[0].state, { bibRoute: '/serie', bibFrom: null });
    // Zamiar dotyczy tylko ostatniego wyboru i znika po odczycie.
    assert.equal(router.takeSelectionIntent('/serie/3'), null);
    assert.deepEqual(router.takeSelectionIntent('/serie/5'), { path: '/serie/5', focusDetail: true });
    assert.equal(router.takeSelectionIntent('/serie/5'), null);
  } finally {
    fake.restore();
  }
});

/**
 * Osobna instancja ui/history.js z nasłuchem `popstate` (moduł rejestruje go tylko przy `window`).
 * Zwraca moduł i jego nasłuchy – test podpina je pod atrapę historii.
 */
async function historyWithPopstate(tag) {
  const handlers = [];
  const saved = globalThis.window;
  globalThis.window = { addEventListener: (type, fn) => type === 'popstate' && handlers.push(fn) };
  try {
    const mod = await import(`${pathToFileURL(path.join(js, 'ui/history.js')).href}?${tag}`);
    return { mod, handlers };
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
}

test('historyBack: cofnięcie na podmieniony wpis (inny wybór z listy) kończy się u rodzica z bibFrom wpisu', async () => {
  const { mod, handlers } = await historyWithPopstate('nav1-replaced');
  // #/serie → wybór HP (#/serie/2) → autor HP → wstecz → wybór Wiedźmina (podmiana na #/serie/1) → dalej.
  const fake = fakeHistory([
    { bibRoute: '/serie', bibFrom: null },
    { bibRoute: '/serie/1', bibFrom: '/serie' },
    { bibRoute: '/serie/2/autor/2', bibFrom: '/serie/2' },
  ]);
  fake.entries[0].hash = '#/serie';
  fake.entries[1].hash = '#/serie/1';
  fakeLocation(fake, '#/serie/2/autor/2');
  for (const fn of handlers) fake.listeners.add(fn);
  try {
    mod.historyBack('/serie/2');
    await settle();
    assert.equal(fake.gos, 1, 'cofnięcie w historii, nie podmiana');
    assert.equal(fake.index, 1);
    assert.equal(fake.entries.length, 3);
    // Adres poprawiony na rodzica, a bibFrom – ten z wpisu, na który wróciliśmy (nie ścieżka dziecka).
    assert.equal(fake.entries[1].hash, '#/serie/2');
    assert.deepEqual(fake.state, { bibRoute: '/serie/2', bibFrom: '/serie' });
    assert.deepEqual(fake.entries[0].state, { bibRoute: '/serie', bibFrom: null });
  } finally {
    fake.restore();
  }
});

test('historyBack: zwykłe cofnięcie do rodzica niczego nie podmienia (telefon jak dotąd)', async () => {
  const { mod, handlers } = await historyWithPopstate('nav1-plain');
  const parent = { bibRoute: '/serie/2', bibFrom: '/serie' };
  const fake = fakeHistory([{ bibRoute: '/serie', bibFrom: null }, parent, { bibRoute: '/serie/2/autor/2', bibFrom: '/serie/2' }]);
  fake.entries[0].hash = '#/serie';
  fake.entries[1].hash = '#/serie/2';
  fakeLocation(fake, '#/serie/2/autor/2');
  for (const fn of handlers) fake.listeners.add(fn);
  try {
    mod.historyBack('/serie/2');
    await settle();
    assert.equal(fake.index, 1);
    assert.equal(fake.entries[1].hash, '#/serie/2');
    assert.equal(fake.state, parent, 'ten sam wpis, bez location.replace');
    // Wpis bez bibFrom rodzica: podmiana adresu, bez cofania (jak dotąd).
    fake.entries.push({ state: { bibRoute: '/autorzy/3', bibFrom: '/autorzy' }, hash: '#/autorzy/3' });
    fake.index = 2;
    fake.entries.splice(3);
    mod.historyBack('/autorzy');
    await settle();
    assert.equal(fake.gos, 1);
    assert.equal(fake.index, 2);
    assert.equal(fake.entries[2].hash, '#/autorzy');
  } finally {
    fake.restore();
  }
});

/**
 * Osobna instancja ui/router.js z nasłuchem `hashchange` (moduł rejestruje go tylko przy `window`).
 * Atrapa historii musi już być zainstalowana (router czyta `history` przy wczytaniu). Zwraca moduł
 * i `hashchange()` – ręczne „dotarcie” adresu.
 */
async function routerWithHashchange(tag) {
  const handlers = [];
  const saved = globalThis.window;
  globalThis.window = { addEventListener: (type, fn) => type === 'hashchange' && handlers.push(fn) };
  try {
    const mod = await import(`${pathToFileURL(path.join(js, 'ui/router.js')).href}?${tag}`);
    return { router: mod, hashchange: () => handlers.forEach((fn) => fn()) };
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
}

/** Atrapy `sessionStorage` (pamięć kart) i `matchMedia` (szerokość okna) na czas testu. */
function fakeWindowEnv({ tabs = null, split = false } = {}) {
  const store = tabs ? { 'biblioteczka.tabs': JSON.stringify(tabs) } : {};
  const saved = { sessionStorage: globalThis.sessionStorage, matchMedia: globalThis.matchMedia };
  globalThis.sessionStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = String(value);
    },
  };
  globalThis.matchMedia = (query) => ({ matches: split && query === pure.SPLIT_QUERY });
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}

test('HISTORY-4: przytrzymana strzałka – szczegóły od razu, a w historii jeden wpis po chwili bez klawisza', async () => {
  const fake = fakeHistory([{ bibRoute: '/ksiazki', bibFrom: null }]);
  let hashchange = () => undefined;
  fakeLocation(fake, '#/ksiazki', { onHashChange: () => hashchange() });
  try {
    const loaded = await routerWithHashchange('history4');
    const r = loaded.router;
    hashchange = loaded.hashchange;
    assert.equal(r.getRoute().path, '/ksiazki');
    // Powtarzanie klawisza: każde naciśnięcie w osobnym zadaniu, krócej niż KEY_COMMIT_DELAY_MS.
    for (let id = 1; id <= 60; id += 1) {
      assert.equal(r.selectEntry({ type: 'book', id }, { browsing: true }), true);
      assert.equal(r.getRoute().path, `/ksiazki/ksiazka/${id}`, 'szczegóły idą za fokusem od razu');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Przed zapisem: ani jednej operacji na historii (Chrome dławi ~200 w 10 s, WebKit – 100).
    assert.deepEqual(fake.calls, []);
    await new Promise((resolve) => setTimeout(resolve, r.KEY_COMMIT_DELAY_MS + 60));
    // Jeden wpis wyboru (z korzenia karty) i jego znacznik – razem dwie operacje.
    assert.deepEqual(fake.calls, ['hash', 'replaceState']);
    assert.equal(fake.entries.length, 2);
    assert.equal(fake.entries[1].hash, '#/ksiazki/ksiazka/60');
    assert.deepEqual(fake.state, { bibRoute: '/ksiazki/ksiazka/60', bibFrom: '/ksiazki' });
    // ↓ i ↑ z powrotem: ten sam adres – nic do zapisania.
    fake.calls.length = 0;
    r.selectEntry({ type: 'book', id: 61 }, { browsing: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    r.selectEntry({ type: 'book', id: 60 }, { browsing: true });
    await new Promise((resolve) => setTimeout(resolve, r.KEY_COMMIT_DELAY_MS + 60));
    assert.deepEqual(fake.calls, []);
    assert.equal(r.getRoute().path, '/ksiazki/ksiazka/60');
    // Klik w trakcie przeglądania strzałkami: zapis od razu, z adresem klikniętego wiersza.
    r.selectEntry({ type: 'book', id: 62 }, { browsing: true });
    r.selectEntry({ type: 'book', id: 7 });
    await settle();
    assert.deepEqual(fake.calls, ['replace', 'replaceState']);
    assert.deepEqual(fake.state, { bibRoute: '/ksiazki/ksiazka/7', bibFrom: '/ksiazki' });
    await new Promise((resolve) => setTimeout(resolve, r.KEY_COMMIT_DELAY_MS + 60));
    assert.equal(fake.calls.length, 2, 'bez spóźnionego drugiego zapisu');
  } finally {
    fake.restore();
  }
});

test('LIFECYCLE-1: adres poprzedniego wyboru, który dociera po nowszym, nie cofa szczegółów (fokus zostaje na liście)', async () => {
  const fake = fakeHistory([{ bibRoute: '/serie', bibFrom: null }]);
  fakeLocation(fake, '#/serie');
  try {
    const { router: r, hashchange } = await routerWithHashchange('lifecycle1');
    r.getRoute();
    // Jak efekt trasy w app.js: każda pokazana trasa pyta o zamiar wyboru z listy.
    const shown = [];
    r.subscribeRoute((route) => shown.push([route.path, r.takeSelectionIntent(route.path)]));
    r.selectEntry({ type: 'series', id: 3 });
    await settle(); // kolejka: location.hash = '/serie/3'
    r.selectEntry({ type: 'series', id: 5 }); // następna strzałka, zanim dotarł `hashchange` dla 3
    hashchange(); // dociera adres 3 (pasek adresu wciąż na 3)
    await settle(); // kolejka: podmiana na 5
    hashchange();
    assert.equal(r.getRoute().path, '/serie/5');
    assert.deepEqual(
      shown.map(([routePath, intent]) => [routePath, Boolean(intent)]),
      [
        ['/serie/3', true],
        ['/serie/5', true],
      ],
      'każda pokazana trasa to wybór z listy – żadna nie przenosi fokusu do szczegółów',
    );
    assert.deepEqual(fake.state, { bibRoute: '/serie/5', bibFrom: '/serie' });
    assert.equal(fake.entries.length, 2);
  } finally {
    fake.restore();
  }
});

test('HISTORY-1: wybór równy wpisowi pod spodem (podświetlony wiersz z głębszego ekranu, ↓↑) cofa zamiast dublować wpis', async () => {
  const { mod, handlers } = await historyWithPopstate('history1');
  // #/serie → wybór HP (#/serie/2) → autor HP w prawym panelu; klik w podświetlony wiersz HP.
  const fake = fakeHistory([
    { bibRoute: '/serie', bibFrom: null },
    { bibRoute: '/serie/2', bibFrom: '/serie' },
    { bibRoute: '/serie/2/autor/2', bibFrom: '/serie/2' },
  ]);
  fake.entries[0].hash = '#/serie';
  fake.entries[1].hash = '#/serie/2';
  fakeLocation(fake, '#/serie/2/autor/2');
  for (const fn of handlers) fake.listeners.add(fn);
  try {
    mod.historyReplace('/serie/2', { keepFrom: true });
    await settle();
    assert.equal(fake.gos, 1, 'cofnięcie, nie podmiana');
    assert.equal(fake.index, 1);
    assert.deepEqual(fake.state, { bibRoute: '/serie/2', bibFrom: '/serie' });
    // Wpis „dalej” zostaje (ekran autora), pod spodem lista – następne „wstecz” wraca na #/serie.
    assert.equal(fake.entries.length, 3);
    assert.equal(fake.entries[2].hash, '#/serie/2/autor/2');
    assert.deepEqual(fake.calls, []);
    // Inny wybór na tej samej głębokości – zwykła podmiana z zachowaniem bibFrom.
    fake.index = 2;
    mod.historyReplace('/serie/1', { keepFrom: true });
    await settle();
    assert.equal(fake.gos, 1);
    assert.deepEqual(fake.state, { bibRoute: '/serie/1', bibFrom: '/serie/2' });
  } finally {
    fake.restore();
  }
});

test('historySelect: czekający wybór zapisuje się przed inną operacją, a „wstecz” przeglądarki go porzuca', async () => {
  const { mod, handlers } = await historyWithPopstate('select-queue');
  const fake = fakeHistory([
    { bibRoute: '/serie', bibFrom: null },
    { bibRoute: '/serie/1', bibFrom: '/serie' },
  ]);
  fake.entries[0].hash = '#/serie';
  fakeLocation(fake, '#/serie/1');
  for (const fn of handlers) fake.listeners.add(fn);
  try {
    // Strzałka, a zaraz potem arkusz (np. „Edytuj” z menu wiersza): najpierw adres wyboru, potem wpis warstwy.
    mod.historySelect('/serie/2', { delay: 1000 });
    mod.historyPushLayer(7);
    await settle();
    assert.deepEqual(fake.calls, ['replace', 'replaceState', 'pushState']);
    assert.equal(fake.entries[1].hash, '#/serie/2');
    assert.equal(fake.state.bibLayer, 7);
    // Strzałka, a zaraz potem „wstecz” przeglądarki: wybór nie podmienia wpisu, na który wróciliśmy.
    fake.entries.splice(2);
    fake.index = 1;
    fake.calls.length = 0;
    mod.historySelect('/serie/3', { delay: 20 });
    fake.index = 0;
    for (const fn of handlers) fn({ state: fake.state });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fake.calls, []);
    assert.equal(fake.entries[0].hash, '#/serie');
    assert.equal(fake.entries[1].hash, '#/serie/2');
  } finally {
    fake.restore();
  }
});

test('HISTORY-2: dwa panele, start z wybraną pozycją bez znacznika (panel HA otwarty ponownie) – pod spodem wpis listy', async () => {
  // Wpis strony HA, a nad nim pierwszy wpis ramki bez hasha; pamięć karty Serie: '/serie/2'.
  const fake = fakeHistory([null, null]);
  fake.entries[0].hash = '#HA';
  fakeLocation(fake, '');
  const restoreEnv = fakeWindowEnv({ tabs: { serie: '/serie/2' }, split: true });
  try {
    const { router: r } = await routerWithHashchange('history2-split');
    assert.equal(r.getRoute().path, '/serie/2', 'ostatni wybór karty wraca');
    assert.deepEqual(
      fake.entries.map((e) => [e.hash, e.state]),
      [
        ['#HA', null],
        ['#/serie', { bibRoute: '/serie', bibFrom: null }],
        ['#/serie/2', { bibRoute: '/serie/2', bibFrom: '/serie' }],
      ],
    );
    // Zmiana wyboru podmienia wpis – „wstecz” prowadzi do listy, a nie do strony HA.
    r.selectEntry({ type: 'series', id: 4 });
    await settle();
    assert.equal(fake.entries.length, 3);
    assert.deepEqual(fake.state, { bibRoute: '/serie/4', bibFrom: '/serie' });
  } finally {
    restoreEnv();
    fake.restore();
  }
});

test('HISTORY-2: przy głębszym stosie wpisy każdego ekranu; wąskie okno i przeładowanie – bez zmian', async () => {
  let fake = fakeHistory([null]);
  fakeLocation(fake, '#/autorzy/3/seria/5');
  let restoreEnv = fakeWindowEnv({ split: true });
  try {
    const { router: r } = await routerWithHashchange('history2-deep');
    assert.equal(r.getRoute().path, '/autorzy/3/seria/5');
    assert.deepEqual(
      fake.entries.map((e) => [e.hash, e.state && e.state.bibFrom]),
      [
        ['#/autorzy', null],
        ['#/autorzy/3', '/autorzy'],
        ['#/autorzy/3/seria/5', '/autorzy/3'],
      ],
    );
  } finally {
    restoreEnv();
    fake.restore();
  }
  // Telefon (wąskie okno): jeden wpis jak dotąd, „wstecz” w pasku prowadzi do listy.
  fake = fakeHistory([null]);
  fakeLocation(fake, '');
  restoreEnv = fakeWindowEnv({ tabs: { serie: '/serie/2' }, split: false });
  try {
    const { router: r } = await routerWithHashchange('history2-narrow');
    assert.equal(r.getRoute().path, '/serie/2');
    assert.equal(fake.entries.length, 1);
    assert.deepEqual(fake.state, { bibRoute: '/serie/2', bibFrom: null });
  } finally {
    restoreEnv();
    fake.restore();
  }
  // Przeładowanie wpisu, który już ma znacznik: nic się nie dokłada.
  fake = fakeHistory([{ bibRoute: '/serie', bibFrom: null }, { bibRoute: '/serie/2', bibFrom: '/serie' }]);
  fake.entries[0].hash = '#/serie';
  fakeLocation(fake, '#/serie/2');
  restoreEnv = fakeWindowEnv({ split: true });
  try {
    const { router: r } = await routerWithHashchange('history2-reload');
    assert.equal(r.getRoute().path, '/serie/2');
    assert.equal(fake.entries.length, 2);
    assert.deepEqual(fake.calls, []);
  } finally {
    restoreEnv();
    fake.restore();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ui/history.js, ui/router.js i ui/overlay.js wczytane od nowa w atrapie przeglądarki, z jedną wspólną
 * kolejką historii i nasłuchami `popstate`/`hashchange` (router importuje './history.js', więc `?tag`
 * nie wystarcza – moduły czytane są z kopii w katalogu tymczasowym). Atrapa zachowuje się jak Chrome:
 * - `location.hash = x` – nowy wpis (state null), `popstate` od razu, `hashchange` w osobnym zadaniu;
 * - `location.replace(url)` – podmiana wpisu (state null), `popstate` od razu, `hashchange` przy zmianie
 *   fragmentu;
 * - `history.go(d)` – w osobnym zadaniu `popstate` ze stanem wpisu docelowego, potem `hashchange`;
 * - `pushState`/`replaceState` – bez zdarzeń.
 * Dwa `hashchange` po dwóch zmianach w jednym zadaniu widzą już ostatni adres – jak w przeglądarce.
 */
async function browserGraph(hash, { split = true } = {}) {
  const events = { popstate: new Set(), hashchange: new Set() };
  const fire = (type, event) => [...events[type]].forEach((fn) => fn(event));
  const hashchangeLater = () => setTimeout(() => fire('hashchange', {}), 0);
  const hashOf = (url) => (String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '');
  const base = 'http://dom.test/api/hassio_ingress/tok/';
  const tab = { entries: [{ hash, state: null }], index: 0 };
  const entry = () => tab.entries[tab.index];
  const fakeLocation = {
    get href() {
      return base + entry().hash;
    },
    get hash() {
      return entry().hash;
    },
    set hash(value) {
      const next = '#' + String(value).replace(/^#/, '');
      if (next === entry().hash) return;
      tab.entries.splice(tab.index + 1);
      tab.entries.push({ hash: next, state: null });
      tab.index = tab.entries.length - 1;
      fire('popstate', { state: null });
      hashchangeLater();
    },
    replace(url) {
      const changed = hashOf(url) !== entry().hash;
      tab.entries[tab.index] = { hash: hashOf(url), state: null };
      fire('popstate', { state: null });
      if (changed) hashchangeLater();
    },
  };
  const fakeHistoryApi = {
    scrollRestoration: 'auto',
    get length() {
      return tab.entries.length;
    },
    get state() {
      return entry().state;
    },
    replaceState(state, _title, url) {
      entry().state = state == null ? null : structuredClone(state);
      if (url !== undefined) entry().hash = hashOf(url);
    },
    pushState(state, _title, url) {
      tab.entries.splice(tab.index + 1);
      tab.entries.push({ hash: url !== undefined ? hashOf(url) : entry().hash, state: state == null ? null : structuredClone(state) });
      tab.index = tab.entries.length - 1;
    },
    go(delta) {
      setTimeout(() => {
        const target = tab.index + delta;
        if (target < 0 || target >= tab.entries.length) return;
        const before = entry().hash;
        tab.index = target;
        fire('popstate', { state: entry().state });
        if (entry().hash !== before) hashchangeLater();
      }, 1);
    },
    back() {
      this.go(-1);
    },
  };
  const store = {};
  const fakes = {
    window: {
      addEventListener: (type, fn) => events[type] && events[type].add(fn),
      removeEventListener: (type, fn) => events[type] && events[type].delete(fn),
    },
    location: fakeLocation,
    history: fakeHistoryApi,
    matchMedia: (query) => ({ matches: split && query === pure.SPLIT_QUERY }),
    sessionStorage: { getItem: (key) => store[key] ?? null, setItem: (key, value) => (store[key] = String(value)) },
  };
  const saved = Object.fromEntries(Object.keys(fakes).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, fakes);
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  const staticDir = path.resolve(js, '..');
  const dir = mkdtempSync(path.join(tmpdir(), 'bib-graph-'));
  try {
    for (const file of ['js/ui/history.js', 'js/ui/router.js', 'js/ui/pure.js', 'js/ui/overlay.js', 'vendor/preact-htm.js']) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      copyFileSync(path.join(staticDir, file), path.join(dir, file));
    }
    const load = (file) => import(pathToFileURL(path.join(dir, 'js/ui', file)).href);
    const [router, queue, layers] = [await load('router.js'), await load('history.js'), await load('overlay.js')];
    return { router, queue, layers, tab, restore };
  } catch (error) {
    restore();
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Wpisy historii atrapy: `[hash, state]`, z `>` przy bieżącym. */
function historyShape(tab) {
  return tab.entries.map((e, i) => [(i === tab.index ? '>' : '') + e.hash, e.state]);
}

test('HIST3-1: ↓ z korzenia listy i w ciągu 250 ms link w prawym panelu – oba wpisy oznaczone, „Wstecz” cofa, a „wstecz” przeglądarki wraca do listy', async () => {
  const { router: r, tab, restore } = await browserGraph('#/serie');
  try {
    assert.equal(r.getRoute().path, '/serie');
    r.selectEntry({ type: 'series', id: 2 }, { browsing: true }); // ↓ na liście – zapis czeka
    await sleep(60);
    r.pushEntry({ type: 'author', id: 5 }); // klik w autora: wybór i link w jednym przebiegu kolejki
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie/2/autor/5');
    assert.deepEqual(historyShape(tab), [
      ['#/serie', { bibRoute: '/serie', bibFrom: null }],
      ['#/serie/2', { bibRoute: '/serie/2', bibFrom: '/serie' }],
      ['>#/serie/2/autor/5', { bibRoute: '/serie/2/autor/5', bibFrom: '/serie/2' }],
    ]);
    r.goBack(); // „Wstecz” w prawym panelu – cofnięcie, bez drugiego #/serie/2
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie/2');
    assert.equal(tab.index, 1);
    assert.equal(tab.entries.length, 3);
    history.back();
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie', 'pierwsze „wstecz” przeglądarki wraca do listy');
  } finally {
    restore();
  }
});

test('HIST3-1: zmiana wyboru strzałką i w ciągu 250 ms link – nowy wpis pochodzi z nowego wyboru', async () => {
  const { router: r, tab, restore } = await browserGraph('#/serie');
  try {
    r.getRoute();
    r.selectEntry({ type: 'series', id: 2 }); // klik – zapis od razu
    await sleep(50);
    r.selectEntry({ type: 'series', id: 3 }, { browsing: true }); // ↓ – podmiana czeka
    await sleep(60);
    r.pushEntry({ type: 'author', id: 5 });
    await sleep(50);
    assert.deepEqual(historyShape(tab), [
      ['#/serie', { bibRoute: '/serie', bibFrom: null }],
      ['#/serie/3', { bibRoute: '/serie/3', bibFrom: '/serie' }],
      ['>#/serie/3/autor/5', { bibRoute: '/serie/3/autor/5', bibFrom: '/serie/3' }],
    ]);
    r.goBack();
    await sleep(50);
    history.back();
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie');
    assert.equal(tab.index, 0);
  } finally {
    restore();
  }
});

test('HIST3-1: ↓ i w ciągu 250 ms arkusz – wpis wyboru pod arkuszem oznaczony, a dwa kliknięcia na liście nie zjadają wpisu listy', async () => {
  const { router: r, layers, tab, restore } = await browserGraph('#/serie');
  try {
    r.getRoute();
    r.selectEntry({ type: 'series', id: 2 }, { browsing: true }); // ↓
    await sleep(60);
    const sheet = layers.openLayer({ kind: 'sheet', render: () => null }); // np. „Edytuj serię” w prawym panelu
    await sleep(50);
    assert.deepEqual(tab.entries[1], { hash: '#/serie/2', state: { bibRoute: '/serie/2', bibFrom: '/serie' } });
    assert.equal(tab.entries[2].state.bibLayer, sheet.id);
    sheet.close(); // Esc
    await sleep(50);
    r.selectEntry({ type: 'series', id: 3 }); // klik w inny wiersz
    await sleep(50);
    r.selectEntry({ type: 'series', id: 2 }); // i z powrotem
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie/2');
    assert.deepEqual(historyShape(tab).slice(0, 2), [
      ['#/serie', { bibRoute: '/serie', bibFrom: null }],
      ['>#/serie/2', { bibRoute: '/serie/2', bibFrom: '/serie' }],
    ]);
    history.back();
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie', '„wstecz” zostaje w aplikacji');
  } finally {
    await sleep(300); // zamykany arkusz kończy animację
    restore();
  }
});

test('HIST3-2: menu otwarte chwilę po strzałce nie zamyka się, gdy adres wyboru dociera (push i cofnięcie HISTORY-1)', async () => {
  const { router: r, layers, tab, restore } = await browserGraph('#/serie');
  try {
    r.getRoute();
    // Pierwszy wybór z korzenia (push): ↓, a 80 ms później klawisz ContextMenu na wierszu.
    r.selectEntry({ type: 'series', id: 2 }, { browsing: true });
    await sleep(80);
    const menu = layers.openLayer({ kind: 'menu', render: () => null });
    await sleep(r.KEY_COMMIT_DELAY_MS + 100);
    assert.equal(tab.entries[tab.index].hash, '#/serie/2', 'adres wyboru dotarł');
    assert.equal(layers.hasOpenLayer(), true, 'menu nadal otwarte');
    menu.close();
    // Głębokość 2 (autor serii 2), ↓ i ↑ z powrotem: zapis to cofnięcie na wpis #/serie/2.
    r.pushEntry({ type: 'author', id: 5 });
    await sleep(350);
    r.selectEntry({ type: 'series', id: 3 }, { browsing: true });
    await sleep(5);
    r.selectEntry({ type: 'series', id: 2 }, { browsing: true });
    await sleep(40);
    layers.openLayer({ kind: 'menu', render: () => null });
    await sleep(r.KEY_COMMIT_DELAY_MS + 100);
    assert.equal(tab.index, 1, 'cofnięcie na wpis wyboru');
    assert.equal(layers.hasOpenLayer(), true, 'menu nadal otwarte po cofnięciu');
  } finally {
    layers.closeAllLayers();
    await sleep(300);
    restore();
  }
});

test('HIST3-2: zwykła nawigacja (wąskie okno) z otwartym menu nadal je zamyka – jak dotąd', async () => {
  const { router: r, layers, tab, restore } = await browserGraph('#/serie', { split: false });
  try {
    r.getRoute();
    layers.openLayer({ kind: 'menu', render: () => null });
    r.navigate('/serie/2');
    await sleep(50);
    assert.equal(r.getRoute().path, '/serie/2');
    assert.deepEqual(tab.entries[1].state, { bibRoute: '/serie/2', bibFrom: '/serie' });
    assert.equal(layers.hasOpenLayer(), false);
  } finally {
    await sleep(300);
    restore();
  }
});

test('focusFallbackTarget: dwa panele – tytuł panelu; wąski układ – tytuł ekranu tylko po zmianie układu', () => {
  const { focusFallbackTarget } = pure;
  assert.equal(focusFallbackTarget({ split: true }), 'list');
  assert.equal(focusFallbackTarget({ split: true, lastPane: 'detail', hasDetail: true }), 'detail');
  assert.equal(focusFallbackTarget({ split: true, lastPane: 'detail', hasDetail: false }), 'list');
  assert.equal(focusFallbackTarget({ split: true, layoutSwitched: true }), 'list');
  // Telefon (bez zmiany układu): jak dotąd – nic.
  assert.equal(focusFallbackTarget({ split: false }), null);
  assert.equal(focusFallbackTarget({ split: false, lastPane: 'detail', hasDetail: true }), null);
  assert.equal(focusFallbackTarget({ split: false, layoutSwitched: true }), 'screen');
});

test('LIFECYCLE-2: warstwa wie, że układ zmienił się, gdy była otwarta (element otwierający zamontowany od nowa)', () => {
  const frames = [];
  const saved = { raf: globalThis.requestAnimationFrame, document: globalThis.document };
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  const element = () => ({ isConnected: true, focus() {}, closest: () => null });
  const calls = [];
  try {
    overlay.setFocusFallback((info) => calls.push(info));
    // Arkusz otwarty w dwóch panelach, okno zwężone, potem Esc.
    const opener = element();
    globalThis.document = { activeElement: opener };
    const sheet = overlay.openLayer({ kind: 'sheet', render: () => null });
    overlay.noteLayoutSwitch();
    opener.isConnected = false;
    sheet.close();
    frames.shift()();
    // Menu zamknięte zmianą rozmiaru okna, zanim app.js przełączył układ: liczy się stan w klatce.
    const trigger = element();
    globalThis.document = { activeElement: trigger };
    const menu = overlay.openLayer({ kind: 'menu', render: () => null });
    menu.close();
    overlay.noteLayoutSwitch();
    trigger.isConnected = false;
    frames.shift()();
    // Usunięty wiersz bez zmiany układu (telefon): cel zastępczy wie, że układ się nie zmienił.
    const row = element();
    globalThis.document = { activeElement: row };
    const dialog = overlay.openLayer({ kind: 'dialog', render: () => null });
    row.isConnected = false;
    dialog.close();
    frames.shift()();
    assert.deepEqual(calls, [{ layoutSwitched: true }, { layoutSwitched: true }, { layoutSwitched: false }]);
    overlay.refocusIfLost();
    frames.shift()();
    assert.deepEqual(calls[3], { layoutSwitched: false });
  } finally {
    overlay.setFocusFallback(null);
    for (const [key, value] of [['requestAnimationFrame', saved.raf], ['document', saved.document]]) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('Segmented: po strzałce fokus trafia na opcję zaznaczoną po przerysowaniu (także gdy zmiany nie przyjęto)', () => {
  const source = readFileSync(path.join(js, 'ui/empty.js'), 'utf8');
  const select = /const select = \(i, focus\) => \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(select, 'select');
  assert.match(select[1], /requestAnimationFrame\([\s\S]*\[aria-checked="true"\]/);
});

test('isFocusLost: <body>, brak, odłączony element albo fokus w (zamykanej) warstwie', () => {
  const body = { isConnected: true, closest: () => null };
  const row = { isConnected: true, closest: () => null };
  const inLayer = { isConnected: true, closest: (selector) => (selector === '[data-layer]' ? {} : null) };
  assert.equal(pure.isFocusLost(null, body), true);
  assert.equal(pure.isFocusLost(body, body), true);
  assert.equal(pure.isFocusLost({ isConnected: false, closest: () => null }, body), true);
  // Arkusz w trakcie zamykania wciąż trzyma fokus – za chwilę zniknie razem z nim.
  assert.equal(pure.isFocusLost(inLayer, body), true);
  assert.equal(pure.isFocusLost(row, body), false);
});

test('refocusIfLost: bez celu zastępczego (wąski układ) nic; z nim – cel w następnej klatce', () => {
  const frames = [];
  const saved = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    overlay.setFocusFallback(null);
    overlay.refocusIfLost();
    assert.equal(frames.length, 0);
    let calls = 0;
    overlay.setFocusFallback(() => (calls += 1));
    overlay.refocusIfLost();
    assert.equal(calls, 0);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(calls, 1);
    // Cel usunięty przed klatką (zmiana układu) – nic się nie dzieje.
    overlay.refocusIfLost();
    overlay.setFocusFallback(null);
    frames.shift()();
    assert.equal(calls, 1);
  } finally {
    overlay.setFocusFallback(null);
    if (saved === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = saved;
  }
});

test('usunięcie z wiersza: po powrocie (albo bez niego) common.js prosi o fokus zastępczy', () => {
  const source = readFileSync(path.join(js, 'screens/common.js'), 'utf8');
  const body = /function leaveIfShowing\(type, id\) \{([^}]*\}[^}]*)\}/.exec(source);
  assert.ok(body, 'leaveIfShowing');
  assert.match(body[1], /goBack\(\);\s*refocusIfLost\(\);/);
  for (const type of ['book', 'series', 'author']) {
    assert.match(source, new RegExp(`onDeleted \\|\\| \\(\\(\\) => leaveIfShowing\\('${type}'`));
  }
});

// ---------------------------------------------------------------------------
// Odpytywanie serwera
// ---------------------------------------------------------------------------

test('pollDelayMs: zwykły odstęp, szybki przy okładkach, wykładniczo dłuższy po błędach (maks. 60 s)', () => {
  assert.equal(store.pollDelayMs(), 15000);
  assert.equal(store.pollDelayMs({ coverJobRunning: true }), 2000);
  const fast = [1, 2, 3, 4, 5, 6, 7, 40].map((failures) => store.pollDelayMs({ coverJobRunning: true, failures }));
  assert.deepEqual(fast, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  // Błędy nigdy nie przyspieszają zwykłego odpytywania.
  const slow = [1, 2, 3, 4, 5, 6, 7].map((failures) => store.pollDelayMs({ failures }));
  assert.deepEqual(slow, [15000, 15000, 15000, 16000, 32000, 60000, 60000]);
  assert.equal(store.pollDelayMs({ failures: Infinity }), 60000);
  assert.equal(store.pollDelayMs({ failures: -3 }), 15000);
});

test('startSync: przy niedostępnym serwerze w trakcie pobierania okładek odstępy rosną, po sukcesie wracają do 2 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const docListeners = {};
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const running = { revision: 1, appVersion: '', meta: { coverJob: { running: true, total: 10, done: 1, found: 0 } }, authors: [], series: [], books: [] };
  let mode = 'ok';
  const calls = [];
  globalThis.document = { visibilityState: 'visible', addEventListener: (type, fn) => (docListeners[type] = fn) };
  globalThis.window = { addEventListener: () => undefined };
  globalThis.fetch = async (url) => {
    assert.equal(url, 'api/state');
    calls.push(Date.now());
    if (mode === 'fail') throw new TypeError('Failed to fetch');
    return { status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json', ETag: `"r${calls.length}"` }), json: async () => running };
  };
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const advance = async (ms, step = 250) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(step);
      await flush();
    }
  };
  const gaps = (list) => list.slice(1).map((time, i) => time - list[i]);
  try {
    await store.startSync();
    await flush();
    assert.deepEqual(calls, [0]);
    assert.equal(store.getLibrary().meta.coverJob.running, true);

    mode = 'fail';
    await advance(130000);
    assert.ok(store.getLibrary().error, 'błąd połączenia widoczny w magazynie');
    assert.deepEqual(gaps(calls), [2000, 2000, 4000, 8000, 16000, 32000, 60000]);

    // Karta w tle: żadnych zapytań.
    const before = calls.length;
    globalThis.document.visibilityState = 'hidden';
    docListeners.visibilitychange();
    await advance(300000, 1000);
    assert.equal(calls.length, before);

    // Powrót do karty po odzyskaniu połączenia: od razu pobranie i znowu co 2 s.
    mode = 'ok';
    globalThis.document.visibilityState = 'visible';
    docListeners.visibilitychange();
    await flush();
    await advance(4000);
    assert.equal(store.getLibrary().error, null);
    assert.deepEqual(gaps(calls.slice(before)), [2000, 2000]);
  } finally {
    // Zatrzymanie odpytywania i przywrócenie środowiska.
    globalThis.document.visibilityState = 'hidden';
    docListeners.visibilitychange?.();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Arkusz stylów
// ---------------------------------------------------------------------------

test('app.css: przy 320 px przełącznik segmentowy ma mniejszy tekst i odstępy, nadpisujące regułę bazową', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  const base = css.search(/^\.segment \{/m);
  assert.ok(base >= 0, 'reguła .segment');
  // Blok @media musi stać po regule bazowej (ta sama specyficzność – wygrywa późniejsza).
  const narrow = /@media \(max-width: 340px\) \{\s*\.segment \{([^}]*)\}/g;
  const blocks = [...css.matchAll(narrow)].filter((m) => m.index > base);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0][1], /font-size:\s*13px/);
  assert.match(blocks[0][1], /padding:\s*6px 3px/);
});

test('app.css: etykieta pola liczby obok +/− się nie kurczy (bez „Liczba tom…” przy 360–375 px)', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  const rule = /^\.number-row \.field-label \{([^}]*)\}/m.exec(css);
  assert.ok(rule, 'reguła .number-row .field-label');
  // flex-shrink 0: przy braku miejsca ustępuje pole liczby (min-width: 0), a nie etykieta.
  assert.match(rule[1], /flex:\s*1 0 auto/);
  const input = /^\.number-input \{([^}]*)\}/m.exec(css);
  assert.ok(input, 'reguła .number-input');
  assert.match(input[1], /text-overflow:\s*ellipsis/);
  // Etykieta nadal ma limit szerokości (długie etykiety kończą się wielokropkiem).
  const label = /^\.field-label \{([^}]*)\}/m.exec(css);
  assert.match(label[1], /max-width:\s*55%/);
});

test('app.css: układ dwóch paneli pod tym samym progiem co SPLIT_QUERY i tylko na ekranie', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  assert.ok(css.includes(`@media screen and (min-width: ${pure.SPLIT_MIN_WIDTH}px)`), 'blok @media dwóch paneli');
  const block = css.slice(css.indexOf(`@media screen and (min-width: ${pure.SPLIT_MIN_WIDTH}px)`));
  // Okno się nie przewija, więc pasek przewijania okna nie rezerwuje miejsca.
  assert.match(block, /html\.is-split \{[^}]*scrollbar-gutter:\s*auto/);
  assert.match(block, /html\.is-split,\s*html\.is-split body \{[^}]*overflow:\s*hidden/);
  assert.match(block, /\.is-split \.pane-list \{[^}]*container:\s*list-pane \/ inline-size/);
  // Klasa `is-split` tylko na <html>: panel karty to .split-panel.
  assert.match(block, /\.is-split \.split-panel:not\(\[hidden\]\) \{/);
});

test('app.css: wąska lista w dwóch panelach dostaje poprawki telefonu po regułach bazowych', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  const segment = css.search(/^\.segment \{/m);
  const tile = css.search(/^\.stat-tile \{/m);
  const narrowSegment = css.indexOf('@container list-pane (max-width: 379px)');
  const narrowTile = css.indexOf('@container list-pane (max-width: 340px)');
  assert.ok(segment >= 0 && tile >= 0, 'reguły bazowe');
  assert.ok(narrowSegment > segment, '@container dla .segment po regule bazowej');
  assert.ok(narrowTile > tile, '@container dla .stat-tile po regule bazowej');
  assert.match(css.slice(narrowSegment), /^@container list-pane \(max-width: 379px\) \{\s*\.segment \{[^}]*padding:\s*6px 3px;[^}]*font-size:\s*13px/);
  // Zwykły próg 340 px dla telefonów zostaje bez zmian.
  assert.ok(!/@media[^{]*min-width: 1008px\) and \(max-width/.test(css), 'bez progu 1008–1239 px');
});

test('app.css: wybrany wiersz po regułach :hover i :active, z obrysem w wymuszonych kolorach', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  const active = css.indexOf('.row.is-interactive .row-slide:has(.row-main:active)');
  const selected = css.indexOf('.is-split .pane-list .row.is-selected .row-slide {');
  const pressed = css.indexOf('.is-split .pane-list .row.is-selected .row-slide:has(.row-main:active)');
  assert.ok(active >= 0 && selected > active && pressed > selected);
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(forced, /\.is-split \.pane-list \.row\.is-selected \.row-slide \{\s*outline: 2px solid Highlight;/);
});

test('app.css: panel w dwóch panelach jest pozycjonowany (absolutne potomki nie wydłużają dokumentu)', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  const block = css.slice(css.indexOf(`@media screen and (min-width: ${pure.SPLIT_MIN_WIDTH}px)`));
  const pane = /\.is-split \.pane \{([^}]*)\}/.exec(block);
  assert.ok(pane, 'reguła .is-split .pane');
  assert.match(pane[1], /position:\s*relative/);
  // Przejście z wąskiego układu zeruje przewinięcie okna (okno w dwóch panelach się nie przewija).
  const app = readFileSync(path.join(js, 'app.js'), 'utf8');
  assert.match(app, /if \(layoutChanged\) scrollTo\(0, 0\);/);
  // Pasek panelu mierzy tytuł jeszcze raz w następnej klatce – po wyzerowaniu przewinięcia okna
  // (inaczej po przejściu z przewiniętego wąskiego układu zostaje zwinięty mimo widocznego tytułu).
  const hook = app.slice(app.indexOf('function useCompactBar('), app.indexOf('function PaneBar('));
  assert.match(hook, /measure\(\);\s*(\/\/[^\n]*\n\s*)*if \(scroller\) onScroll\(\);/);
});

test('app.css: wybrany wiersz ma pasek akcentu, a nie tylko odcień tła', () => {
  const css = readFileSync(path.resolve(js, '../css/app.css'), 'utf8');
  const rule = /\.is-split \.pane-list \.row\.is-selected \.row-slide \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'reguła wybranego wiersza');
  assert.match(rule[1], /box-shadow:\s*inset 3px 0 0 var\(--accent\)/);
  // Warianty :hover i :active zmieniają tylko tło – pasek zostaje.
  for (const variant of [/\.row\.is-selected \.row-slide:hover \{([^}]*)\}/, /\.row\.is-selected \.row-slide:has\(\.row-main:active\) \{([^}]*)\}/]) {
    const match = variant.exec(css);
    assert.ok(match);
    assert.doesNotMatch(match[1], /box-shadow/);
  }
});

test('useCompactBar: pasek ukrytej karty nie jest mierzony (po pokazaniu karty nie gaśnie zwinięty tytuł)', () => {
  // Kod hooka z app.js uruchomiony z zaślepkami hooków Preacta i elementów DOM.
  const app = readFileSync(path.join(js, 'app.js'), 'utf8');
  const source = app.slice(app.indexOf('function useCompactBar('), app.indexOf('/**\n * Pasek tytułu.'));
  assert.match(source, /^function useCompactBar\(/);
  const state = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => (state[index] = value)];
  };
  const useLayoutEffect = (effect) => effect();
  const noop = () => undefined;
  const useCompactBar = new Function(
    'useState',
    'useLayoutEffect',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'addEventListener',
    'removeEventListener',
    'scrollY',
    `${source}\nreturn useCompactBar;`,
  )(useState, useLayoutEffect, () => 0, noop, noop, noop, 0);

  // Panel listy: pasek kończy się na 52 px, duży tytuł na 107 px (nieprzewinięty panel).
  let visible = false;
  const rect = (bottom) => () => (visible ? { bottom } : { bottom: 0 });
  const bar = { getClientRects: () => (visible ? [{}] : []), getBoundingClientRect: rect(52) };
  const heading = { getBoundingClientRect: rect(107) };
  const scroller = { scrollTop: 0, addEventListener: noop, removeEventListener: noop };
  const run = () => {
    cursor = 0;
    return useCompactBar({
      barRef: { current: bar },
      getScroller: () => scroller,
      getHeading: () => heading,
      largeTitle: true,
      deps: [visible],
    });
  };

  // Karta zamontowana jako ukryta: elementy bez wymiarów nie zwijają paska.
  assert.deepEqual(run(), [false, false]);
  assert.deepEqual(run(), [false, false]);
  // Po pokazaniu karty pomiar jest prawdziwy.
  visible = true;
  assert.deepEqual(run(), [false, false]);
  // Przewinięty panel zwija pasek, a ukrycie karty zostawia ten stan do kolejnego pomiaru.
  scroller.scrollTop = 80;
  heading.getBoundingClientRect = () => ({ bottom: 27 });
  run();
  assert.deepEqual(run(), [true, true]);
  visible = false;
  assert.deepEqual(run(), [true, true]);
});
