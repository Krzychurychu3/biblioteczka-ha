// Testy czystych funkcji ekranów: statystyki, filtr serii, tomy, sortowanie książek,
// ranking wyszukiwania, sekcje autora, teksty dialogów i komunikatów menu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../../biblioteczka/app/biblioteczka/static/js');
const logic = await import(path.join(js, 'screens/logic.js'));
const store = await import(path.join(js, 'store.js'));

const { buildLibrary, ownedBooks, visibleAuthors, visibleSeries } = store;

// ---------------------------------------------------------------------------
// Dane testowe (kształt jak `GET api/state`)
// ---------------------------------------------------------------------------

function author(id, name, extra = {}) {
  return { id, name, createdAt: '2024-01-01T00:00:00Z', isOnShelf: true, bookCount: 0, ownedBookCount: 0, seriesIds: [], summary: '', ownedSummary: '', ...extra };
}

function series(id, name, { owned = 0, total = 0, planned = null, complete = false, hasOwned = owned > 0, onShelf, ...extra } = {}) {
  return {
    id,
    name,
    authorId: null,
    plannedVolumeCount: planned,
    notes: '',
    createdAt: '2024-01-01T00:00:00Z',
    isOnShelf: onShelf ?? (total === 0 || hasOwned),
    hasOwnedBooks: hasOwned,
    progress: { owned, total, isComplete: complete, fraction: total ? owned / total : 0 },
    slots: [],
    missingDescription: null,
    nextVolumeNumber: 1,
    suggestedVolumeNumber: 1,
    coverId: null,
    authorLine: 'Autor nieznany',
    ...extra,
  };
}

function book(id, title, extra = {}) {
  return {
    id,
    title,
    authorId: null,
    seriesId: null,
    volumeNumber: null,
    isOwned: true,
    notes: '',
    addedAt: '2024-01-01T00:00:00Z',
    isbn: null,
    publisher: null,
    publicationYear: null,
    pageCount: null,
    coverId: null,
    coverSeed: title,
    coverLabel: null,
    seriesLine: null,
    suggestionSubtitle: '',
    ...extra,
  };
}

function lib({ authors = [], series: list = [], books = [], meta = {} } = {}) {
  return buildLibrary({ revision: 1, appVersion: '0.1.0', meta, authors, series: list, books });
}

// ---------------------------------------------------------------------------
// Odmiana
// ---------------------------------------------------------------------------

test('plural: odmiana dowolnego rzeczownika po liczbie', () => {
  const forms = ['okładka', 'okładki', 'okładek'];
  assert.equal(logic.plural(1, forms), 'okładka');
  assert.equal(logic.plural(2, forms), 'okładki');
  assert.equal(logic.plural(5, forms), 'okładek');
  assert.equal(logic.plural(12, forms), 'okładek');
  assert.equal(logic.plural(22, forms), 'okładki');
  assert.equal(logic.plural(0, forms), 'okładek');
  // Biernik („Dodano 1 książkę”) to `countAccusative` z core/polish.js – testy w core.test.mjs.
  assert.equal(logic.bookCountAccusative, undefined);
});

// ---------------------------------------------------------------------------
// Serie: postęp i podpisy
// ---------------------------------------------------------------------------

test('progressLabel: brak tomów, znana i nieznana liczba tomów', () => {
  assert.equal(logic.progressLabel(series(1, 'A')), 'brak tomów');
  assert.equal(logic.progressLabel(series(1, 'A', { owned: 5, total: 8, planned: 8 })), '5/8');
  assert.equal(logic.progressLabel(series(1, 'A', { owned: 3, total: 4 })), '3/?');
});

test('seriesRowStatus: pasek przy znanej wielkości, tekst przy nieznanej', () => {
  assert.deepEqual(logic.seriesRowStatus(series(1, 'A', { owned: 5, total: 8, planned: 8 })), { kind: 'progress', label: '5/8' });
  // Znana wielkość 0 (plannedVolumeCount ustawione) – nadal pasek.
  assert.deepEqual(logic.seriesRowStatus(series(1, 'A', { planned: 3, total: 3 })), { kind: 'progress', label: '0/3' });
  assert.deepEqual(logic.seriesRowStatus(series(1, 'A')), { kind: 'text', text: 'Brak tomów' });
  assert.deepEqual(logic.seriesRowStatus(series(1, 'A', { owned: 3, total: 4 })), { kind: 'text', text: '3 tomy na półce' });
  assert.deepEqual(logic.seriesRowStatus(series(1, 'A', { owned: 1, total: 2 })), { kind: 'text', text: '1 tom na półce' });
  assert.deepEqual(logic.seriesRowStatus(series(1, 'A', { owned: 0, total: 2 })), { kind: 'text', text: '0 tomów na półce' });
});

test('seriesCountCaption: „z 1 tomu”, „z N tomów” albo forma „na półce”', () => {
  assert.equal(logic.seriesCountCaption(series(1, 'A', { total: 1, planned: 1 })), 'z 1 tomu');
  assert.equal(logic.seriesCountCaption(series(1, 'A', { total: 2, planned: 2 })), 'z 2 tomów');
  assert.equal(logic.seriesCountCaption(series(1, 'A', { total: 22, planned: 22 })), 'z 22 tomów');
  assert.equal(logic.seriesCountCaption(series(1, 'A', { owned: 3, total: 3 })), 'tomy na półce');
  assert.equal(logic.seriesCountCaption(series(1, 'A', { owned: 1, total: 3 })), 'tom na półce');
  assert.equal(logic.seriesCountCaption(series(1, 'A', { owned: 0, total: 3 })), 'tomów na półce');
});

test('volumeRows: puste miejsca, kilka książek w jednym miejscu, tomy bez numeru', () => {
  const books = [book(1, 'Krew elfów'), book(2, 'Ostatnie życzenie'), book(3, 'Miecz przeznaczenia'), book(4, 'Opowiadania')];
  const s = series(9, 'Wiedźmin', {
    slots: [
      { number: 1, bookIds: [2], isOwned: true },
      { number: 2, bookIds: [3, 1], isOwned: true },
      { number: 3, bookIds: [], isOwned: false },
      { number: null, bookIds: [4], isOwned: true },
      { number: 4, bookIds: [999], isOwned: false }, // nieznana książka – miejsce pokazane jako puste
    ],
  });
  const rows = logic.volumeRows(s, new Map(books.map((b) => [b.id, b])));
  assert.deepEqual(
    rows.map((r) => (r.kind === 'placeholder' ? `#${r.number}` : `${r.book.id}@${r.number}`)),
    ['2@1', '3@2', '1@2', '#3', '4@null', '#4'],
  );
  assert.deepEqual(logic.volumeRows(series(1, 'Pusta'), new Map()), []);
});

test('volumeCaption: autor tomu tylko w serii bez autora', () => {
  const authorsById = new Map([[7, author(7, 'Nikola Kucharska')]]);
  const shared = series(1, 'Opowiem ci, mamo');
  const own = series(2, 'Wiedźmin', { authorId: 7 });
  const b = book(1, 'Co robią dinozaury?', { authorId: 7 });
  assert.equal(logic.volumeCaption(b, 3, shared, authorsById), 'Tom 3 · Nikola Kucharska');
  assert.equal(logic.volumeCaption(b, null, shared, authorsById), 'Nikola Kucharska');
  assert.equal(logic.volumeCaption(b, 3, own, authorsById), 'Tom 3');
  assert.equal(logic.volumeCaption(b, null, own, authorsById), null);
  assert.equal(logic.volumeCaption(book(2, 'X'), null, shared, authorsById), null);
});

// ---------------------------------------------------------------------------
// Karta „Serie”
// ---------------------------------------------------------------------------

test('libraryStats liczy tylko serie z posiadanymi książkami', () => {
  const data = lib({
    series: [
      series(1, 'Wiedźmin', { owned: 5, total: 8, planned: 8 }),
      series(2, 'Harry Potter', { owned: 7, total: 7, planned: 7, complete: true }),
      series(3, 'Katalog', { owned: 0, total: 4, hasOwned: false }), // sam katalog
      series(4, 'Pusta', { owned: 0, total: 3, planned: 3, hasOwned: false }), // pusta z wielkością
    ],
    books: [book(1, 'A'), book(2, 'B'), book(3, 'C', { isOwned: false })],
  });
  assert.deepEqual(logic.libraryStats(data), { owned: 2, completeSeries: 1, missing: 3 });
});

test('filterSeries: Wszystkie / Niekompletne (także nieznana wielkość) / Kompletne', () => {
  const list = [
    series(1, 'A', { owned: 2, total: 2, planned: 2, complete: true }),
    series(2, 'B', { owned: 2, total: 2 }), // nieznana wielkość – nigdy kompletna
    series(3, 'C'), // pusta
  ];
  assert.deepEqual(logic.filterSeries(list, 'all').map((s) => s.id), [1, 2, 3]);
  assert.deepEqual(logic.filterSeries(list, 'incomplete').map((s) => s.id), [2, 3]);
  assert.deepEqual(logic.filterSeries(list, 'complete').map((s) => s.id), [1]);
  assert.deepEqual(logic.SERIES_FILTERS.map((f) => f.label), ['Wszystkie', 'Niekompletne', 'Kompletne']);
});

test('isLibraryEmpty i puste wiersze filtrów', () => {
  assert.equal(logic.isLibraryEmpty([], []), true);
  assert.equal(logic.isLibraryEmpty([], [book(1, 'A', { isOwned: false })]), true);
  assert.equal(logic.isLibraryEmpty([], [book(1, 'A')]), false);
  assert.equal(logic.isLibraryEmpty([series(1, 'A')], []), false);
  assert.equal(logic.emptyFilterRow('all').text, 'Nie masz jeszcze żadnej serii – dodaj pierwszą');
  assert.equal(logic.emptyFilterRow('all').action, true);
  assert.equal(logic.emptyFilterRow('incomplete').text, 'Wszystkie serie są kompletne. Brawo!');
  assert.equal(logic.emptyFilterRow('complete').text, 'Żadna seria nie jest jeszcze kompletna.');
});

test('widoczność: serie i autorzy „na półce” z pól stanu', () => {
  const data = lib({
    authors: [author(1, 'Lem'), author(2, 'Katalogowy', { isOnShelf: false })],
    series: [series(1, 'Pusta'), series(2, 'Katalog', { total: 3, hasOwned: false })],
  });
  assert.deepEqual(visibleAuthors(data).map((a) => a.id), [1]);
  assert.deepEqual(visibleSeries(data).map((s) => s.id), [1]);
});

// ---------------------------------------------------------------------------
// Karta „Książki”: sortowanie
// ---------------------------------------------------------------------------

function sortingLibrary() {
  return lib({
    authors: [author(1, 'Żeromski'), author(2, 'andrzej Sapkowski'), author(3, 'Lem')],
    series: [series(10, 'Wiedźmin', { authorId: 2 }), series(11, 'Saga o Ludziach Lodu', { authorId: 2 })],
    books: [
      book(1, 'Przedwiośnie', { authorId: 1, addedAt: '2024-03-01T10:00:00Z' }),
      book(2, 'Krew elfów', { authorId: 2, seriesId: 10, volumeNumber: 3, addedAt: '2024-05-01T10:00:00Z' }),
      book(3, 'Ostatnie życzenie', { authorId: 2, seriesId: 10, volumeNumber: 1, addedAt: '2024-01-01T10:00:00Z' }),
      book(4, 'Opowiadania', { authorId: 2, seriesId: 10, volumeNumber: null, addedAt: '2024-02-01T10:00:00Z' }),
      book(5, 'Żmija', { authorId: 2, addedAt: '2024-04-01T10:00:00Z' }),
      book(6, 'Bez autora', { addedAt: '2024-06-01T10:00:00Z' }),
      book(7, 'Solaris', { authorId: 3, addedAt: '2024-06-01T10:00:00Z' }),
      book(8, 'Sezon burz', { authorId: 2, seriesId: 11, volumeNumber: 2, addedAt: '2023-01-01T10:00:00Z' }),
      book(9, 'Nie mam', { authorId: 3, isOwned: false, addedAt: '2025-01-01T10:00:00Z' }),
    ],
  });
}

test('sortowanie „Tytuł” – po polsku, tylko posiadane', () => {
  const data = sortingLibrary();
  const owned = ownedBooks(data);
  assert.deepEqual(
    logic.sortBooks(owned, 'title', data).map((b) => b.title),
    ['Bez autora', 'Krew elfów', 'Opowiadania', 'Ostatnie życzenie', 'Przedwiośnie', 'Sezon burz', 'Solaris', 'Żmija'],
  );
});

test('sortowanie „Autor i seria”: autor → bez serii najpierw → seria → tom (brak = 0) → tytuł; bez autora na końcu', () => {
  const data = sortingLibrary();
  const sorted = logic.sortBooks(ownedBooks(data), 'author', data).map((b) => b.id);
  // andrzej Sapkowski (2, bez względu na wielkość liter) < Lem (3) < Żeromski (1); potem bez autora.
  // U Sapkowskiego: Żmija (bez serii) → Saga o Ludziach Lodu (8) → Wiedźmin: Opowiadania (brak = 0), tom 1, tom 3.
  assert.deepEqual(sorted, [5, 8, 4, 3, 2, 7, 1, 6]);
});

test('sortowanie „Ostatnio dodane” – od najnowszych, remisy alfabetycznie', () => {
  const data = sortingLibrary();
  const sorted = logic.sortBooks(ownedBooks(data), 'recent', data).map((b) => b.title);
  assert.deepEqual(sorted.slice(0, 3), ['Bez autora', 'Solaris', 'Krew elfów']);
  assert.equal(sorted.at(-1), 'Sezon burz');
  assert.equal(logic.isBookSort('recent'), true);
  assert.equal(logic.isBookSort('xyz'), false);
  assert.equal(logic.isBookSort(null), false);
});

test('nagłówek listy książek z odmianą', () => {
  assert.equal(logic.shelfHeader(1), '1 książka na półce');
  assert.equal(logic.shelfHeader(3), '3 książki na półce');
  assert.equal(logic.shelfHeader(5), '5 książek na półce');
  assert.equal(logic.shelfHeader(22), '22 książki na półce');
});

// ---------------------------------------------------------------------------
// Szukaj
// ---------------------------------------------------------------------------

test('puste zapytanie (także same spacje) – brak wyników, „Ostatnio dodane”', () => {
  assert.equal(logic.isQueryEmpty(''), true);
  assert.equal(logic.isQueryEmpty('   \t'), true);
  assert.equal(logic.isQueryEmpty(' a '), false);
  assert.deepEqual(logic.rankByMatch([{ name: 'A' }], (x) => x.name, '  '), []);
  const data = sortingLibrary();
  const recent = logic.recentBooks(ownedBooks(data));
  assert.equal(recent.length, 8);
  assert.deepEqual(recent.slice(0, 2).map((b) => b.title), ['Bez autora', 'Solaris']);
  assert.equal(recent.some((b) => !b.isOwned), false);
  assert.equal(logic.recentBooks(ownedBooks(data), 3).length, 3);
});

test('ranking: początek nazwy, potem początek słowa, potem środek; remisy alfabetycznie', () => {
  const items = ['Abc Kot', 'Kotek', 'Mały kot', 'Skotnicki', 'Kot', 'Pies'].map((name, i) => ({ id: i, name }));
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const result = logic.rankByMatch(sorted, (x) => x.name, 'kot').map((x) => x.name);
  assert.deepEqual(result, ['Kot', 'Kotek', 'Abc Kot', 'Mały kot', 'Skotnicki']);
});

test('wyszukiwanie bez polskich znaków i wielkości liter; tylko półka', () => {
  const data = lib({
    authors: [author(1, 'Andrzej Sapkowski'), author(2, 'Katalogowy Wiedźmiński', { isOnShelf: false })],
    series: [series(1, 'Wiedźmin', { owned: 1, total: 1 }), series(2, 'Wiedźmińskie bajki', { total: 2, hasOwned: false })],
    books: [book(1, 'Łódź podwodna'), book(2, 'Wiedźmin – opowiadania'), book(3, 'Wiedźmin dla dzieci', { isOwned: false })],
  });
  const query = { authors: visibleAuthors(data), series: visibleSeries(data), books: ownedBooks(data) };
  const results = logic.searchLibrary(query, 'WIEDZMIN');
  assert.deepEqual(results.authors, []);
  assert.deepEqual(results.series.map((s) => s.id), [1]);
  assert.deepEqual(results.books.map((b) => b.id), [2]);
  assert.equal(results.isEmpty, false);
  assert.deepEqual(logic.searchLibrary(query, 'lodz').books.map((b) => b.id), [1]);
  assert.deepEqual(logic.searchLibrary(query, 'sapk').authors.map((a) => a.id), [1]);
  assert.equal(logic.searchLibrary(query, 'xyz').isEmpty, true);
  assert.equal(logic.queryForDisplay('  pan   tadeusz '), 'pan tadeusz');
});

// ---------------------------------------------------------------------------
// Szczegóły autora (§9.9 „W innych seriach”)
// ---------------------------------------------------------------------------

test('authorSections: serie autora, pojedyncze tytuły, książki w innych seriach, braki', () => {
  const data = lib({
    authors: [author(1, 'Nikola Kucharska'), author(2, 'Inny')],
    series: [
      series(1, 'Zwierzaki', { authorId: 1, owned: 2, total: 4, planned: 4 }),
      series(2, 'Opowiem ci, mamo', { owned: 1, total: 6 }), // wspólna (bez autora)
      series(3, 'Cudza seria', { authorId: 2, owned: 1, total: 1 }),
      series(4, 'Katalogowa', { authorId: 1, total: 2, hasOwned: false }), // ukryta
      series(5, 'Pusta autora', { authorId: 1, planned: 3, total: 3, owned: 0, hasOwned: false, onShelf: true }),
    ],
    books: [
      book(1, 'Zebra', { authorId: 1 }),
      book(2, 'Aligator', { authorId: 1 }),
      book(3, 'Nieposiadana', { authorId: 1, isOwned: false }),
      book(4, 'Co jedzą dinozaury?', { authorId: 1, seriesId: 2, volumeNumber: 3 }),
      book(5, 'Gościnnie', { authorId: 1, seriesId: 3 }),
      book(6, 'Tom serii', { authorId: 1, seriesId: 1, volumeNumber: 1 }),
      book(7, 'Brak w innej serii', { authorId: 1, seriesId: 2, isOwned: false }),
    ],
  });
  const sections = logic.authorSections(data, 1);
  assert.deepEqual(sections.series.map((s) => s.id), [5, 1]); // „Pusta autora” < „Zwierzaki”
  assert.deepEqual(sections.standalone.map((b) => b.id), [2, 1]);
  assert.deepEqual(sections.otherSeries.map((b) => b.id), [5, 4]); // „Cudza seria” < „Opowiem ci, mamo”
  assert.equal(sections.missing, 2 + 3);
  const nobody = logic.authorSections(data, 99);
  assert.deepEqual(nobody, { series: [], standalone: [], otherSeries: [], missing: 0 });
});

// ---------------------------------------------------------------------------
// Dialogi usuwania
// ---------------------------------------------------------------------------

test('dialog usuwania serii', () => {
  const s = { name: 'Wiedźmin' };
  const empty = logic.seriesDeletion(s, 0);
  assert.equal(empty.title, 'Usunąć serię?');
  assert.equal(empty.message, '„Wiedźmin” – jeśli usuniesz tylko serię, jej książki zostaną w biblioteczce jako pojedyncze tytuły.');
  assert.deepEqual(empty.options, [{ label: 'Usuń serię', withBooks: false }]);
  assert.deepEqual(logic.seriesDeletion(s, 5).options, [
    { label: 'Usuń serię i 5 książek', withBooks: true },
    { label: 'Usuń tylko serię', withBooks: false },
  ]);
  assert.equal(logic.seriesDeletion(s, 1).options[0].label, 'Usuń serię i 1 książkę');
  assert.equal(logic.seriesDeletion(s, 3).options[0].label, 'Usuń serię i 3 książki');
});

test('dialog usuwania autora i książki', () => {
  const a = { name: 'Stanisław Lem' };
  const d = logic.authorDeletion(a, 0, 0);
  assert.equal(d.title, 'Usunąć autora?');
  assert.equal(d.message, '„Stanisław Lem” – jeśli usuniesz tylko autora, jego książki i serie zostaną w biblioteczce bez przypisanego autora.');
  assert.deepEqual(d.options, [{ label: 'Usuń autora', withBooks: false }]);
  // Sama (pusta) seria też daje wybór, jak w iOS.
  assert.deepEqual(logic.authorDeletion(a, 0, 1).options.map((o) => o.label), ['Usuń razem z książkami (0)', 'Usuń tylko autora']);
  assert.equal(logic.authorDeletion(a, 12, 2).options[0].label, 'Usuń razem z książkami (12)');
  const b = logic.bookDeletion({ title: 'Solaris' });
  assert.deepEqual(b, { title: 'Usunąć tę książkę?', message: '„Solaris” – tej operacji nie można cofnąć.', label: 'Usuń książkę' });
});

// ---------------------------------------------------------------------------
// Menu „Więcej”
// ---------------------------------------------------------------------------

test('eksport możliwy dla posiadanych książek i braków serii z posiadanymi tomami', () => {
  const catalogOnly = lib({ series: [series(1, 'K', { total: 1, hasOwned: false })], books: [book(1, 'K1', { isOwned: false, seriesId: 1 })] });
  assert.equal(logic.hasExportableBooks(catalogOnly), false);
  const missingVolume = lib({ series: [series(1, 'S', { owned: 1, total: 2 })], books: [book(1, 'S2', { isOwned: false, seriesId: 1 })] });
  assert.equal(logic.hasExportableBooks(missingVolume), true);
  assert.equal(logic.hasExportableBooks(lib({ books: [book(1, 'A')] })), true);
  assert.equal(logic.hasExportableBooks(lib()), false);
});

test('komunikat katalogu bajek', () => {
  assert.equal(logic.catalogImportMessage(0), 'Wszystkie pozycje z katalogu są już w bazie.');
  assert.equal(
    logic.catalogImportMessage(1),
    'Dodano 1 książkę do bazy podpowiedzi. Nie pojawi się na listach – zobaczysz ją, gdy zaczniesz wpisywać tytuł przy dodawaniu książki.',
  );
  assert.match(logic.catalogImportMessage(100), /^Dodano 100 książek do bazy podpowiedzi\. Nie pojawią się na listach – zobaczysz je,/);
  assert.match(logic.catalogImportMessage(2), /^Dodano 2 książki do bazy podpowiedzi\. Nie pojawią się na listach – zobaczysz je,/);
  assert.match(logic.catalogImportMessage(5), /^Dodano 5 książek .* Nie pojawią się /);
});

test('raport importu CSV', () => {
  assert.deepEqual(logic.csvImportReport({ added: 3, updated: 1, skipped: 5, errors: [] }), [
    'Dodano 3 książki.',
    'Uzupełniono dane: 1 książka.',
    'Pominięto: 5 pozycji.',
  ]);
  assert.deepEqual(logic.csvImportReport({ added: 0, updated: 0, skipped: 0, errors: [] }), [
    'Plik nie zawiera żadnych książek do zaimportowania.',
  ]);
  const errors = Array.from({ length: 7 }, (_, i) => `Wiersz ${i + 2}: brak tytułu`);
  const lines = logic.csvImportReport({ added: 1, updated: 0, skipped: 0, errors });
  assert.deepEqual(lines.slice(0, 2), ['Dodano 1 książkę.', 'Błędy (7):']);
  assert.equal(lines.filter((l) => l.startsWith('• ')).length, logic.CSV_ERROR_LIMIT);
  assert.equal(lines.at(-1), '…i 2 więcej.');
  assert.equal(logic.csvImportReport({ errors: ['x'] })[0], 'Błąd:');
  assert.equal(logic.csvImportTitle({ added: 0, updated: 0, errors: ['x'] }), 'Nie udało się zaimportować');
  assert.equal(logic.csvImportTitle({ added: 1, errors: ['x'] }), 'Import z CSV');
  assert.deepEqual(logic.csvImportReport(null), ['Plik nie zawiera żadnych książek do zaimportowania.']);
});

test('raport importu CSV: odrzucone wiersze to „Pominięto”, nie „Bez zmian”', () => {
  const errors = ['Wiersz 2: brak tytułu – pominięto.', 'Wiersz 3: brak tytułu – pominięto.'];
  const lines = logic.csvImportReport({ added: 0, updated: 0, skipped: 2, errors, errorCount: 2 });
  assert.deepEqual(lines, ['Pominięto: 2 pozycje.', 'Błędy (2):', `• ${errors[0]}`, `• ${errors[1]}`]);
  assert.ok(!lines.some((l) => l.startsWith('Bez zmian')));
  assert.equal(logic.csvImportReport({ skipped: 1 })[0], 'Pominięto: 1 pozycja.');
  assert.equal(logic.csvImportReport({ skipped: 12 })[0], 'Pominięto: 12 pozycji.');
  assert.equal(logic.csvImportReport({ skipped: 22 })[0], 'Pominięto: 22 pozycje.');
});

test('raport importu CSV: liczba błędów z `errorCount`, gdy serwer przysłał tylko część komunikatów', () => {
  // 60 wierszy bez tytułu: serwer przysyła 50 komunikatów i łączną liczbę 60.
  const errors = Array.from({ length: 50 }, (_, i) => `Wiersz ${i + 2}: brak tytułu – pominięto.`);
  const report = { added: 0, updated: 0, skipped: 60, errors, errorCount: 60 };
  const lines = logic.csvImportReport(report);
  assert.equal(lines[1], 'Błędy (60):');
  assert.equal(lines.filter((l) => l.startsWith('• ')).length, logic.CSV_ERROR_LIMIT);
  assert.equal(lines.at(-1), '…i 55 więcej.');
  assert.equal(logic.csvImportTitle(report), 'Nie udało się zaimportować');
  // Jeden błąd łącznie – liczba pojedyncza; wszystkie komunikaty widoczne – bez „więcej”.
  const single = logic.csvImportReport({ added: 2, errors: ['x'], errorCount: 1 });
  assert.deepEqual(single, ['Dodano 2 książki.', 'Błąd:', '• x']);
  // Ukryte komunikaty liczą się, nawet gdy na liście jest ich mniej niż limit.
  assert.deepEqual(logic.csvImportReport({ errors: ['a', 'b'], errorCount: 4 }).slice(-1), ['…i 2 więcej.']);
  // Starszy raport bez `errorCount` – liczba z długości listy.
  const old = logic.csvImportReport({ errors: Array.from({ length: 7 }, (_, i) => `e${i}`) });
  assert.equal(old[0], 'Błędy (7):');
  assert.equal(old.at(-1), '…i 2 więcej.');
  // Uszkodzone `errorCount` nie zaniża liczby poniżej przysłanych komunikatów.
  assert.equal(logic.csvImportReport({ errors: ['a', 'b', 'c'], errorCount: 'x' })[0], 'Błędy (3):');
  assert.equal(logic.csvImportReport({ errors: ['a', 'b', 'c'], errorCount: 1 })[0], 'Błędy (3):');
  assert.equal(logic.csvImportTitle({ errors: [], errorCount: 3 }), 'Nie udało się zaimportować');
});

test('pobieranie okładek: postęp i komunikaty', () => {
  assert.equal(logic.coverJobProgress(null), null);
  assert.equal(logic.coverJobProgress({ running: false, total: 3, done: 3, found: 1 }), null);
  const p = logic.coverJobProgress({ running: true, total: 10, done: 4, found: 2 });
  assert.equal(p.fraction, 0.4);
  assert.equal(p.text, 'Sprawdzono 4 z 10');
  assert.equal(p.foundText, 'Znaleziono: 2');
  assert.equal(logic.coverJobProgress({ running: true, total: 0, done: 0, found: 0 }).text, 'Przygotowuję…');
  assert.equal(logic.coverJobProgress({ running: true, total: 2, done: 9 }).done, 2);
  assert.equal(logic.coverJobResultMessage(0), 'Nie znaleziono nowych okładek.');
  assert.equal(logic.coverJobResultMessage(1), 'Pobrano 1 okładkę.');
  assert.equal(logic.coverJobResultMessage(3), 'Pobrano 3 okładki.');
  assert.equal(logic.coverJobResultMessage(12), 'Pobrano 12 okładek.');
  assert.equal(logic.coverJobStartMessage({ started: true, total: 5 }, false), 'Szukam okładek – 5 książek bez okładki.');
  assert.equal(logic.coverJobStartMessage({ started: false, total: 5 }, true), 'Okładki są już pobierane.');
  assert.equal(logic.coverJobStartMessage({ started: false, total: 0 }, false), 'Wszystkie książki z numerem ISBN mają już okładki.');
});

test('createOwnedQueue: wybór w trakcie zapisu zostaje zapisany po bieżącym – liczy się ostatni', async () => {
  const saved = [];
  const pending = [];
  const queue = logic.createOwnedQueue((value) => {
    saved.push(value);
    return new Promise((resolve) => pending.push(resolve));
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // „Mam” → „Brakuje mi” (zapis trwa) → „Mam” → „Brakuje mi” → „Mam” (szybkie strzałki).
  const first = queue.request(false);
  assert.equal(queue.busy, true);
  assert.equal(await queue.request(true), undefined);
  assert.equal(await queue.request(false), undefined);
  assert.equal(await queue.request(true), undefined);
  assert.deepEqual(saved, [false]);
  pending.shift()({ ok: 1 });
  await tick();
  assert.deepEqual(saved, [false, true], 'po pierwszym zapisie – ostatni wybór');
  pending.shift()({ ok: 2 });
  assert.deepEqual(await first, { target: true, result: { ok: 2 } });
  assert.equal(queue.busy, false);

  // Powrót do zapisywanej wartości w trakcie zapisu – bez drugiego zapisu.
  saved.length = 0;
  const again = queue.request(false);
  queue.request(true);
  queue.request(false);
  pending.shift()({ ok: 3 });
  assert.deepEqual(await again, { target: false, result: { ok: 3 } });
  assert.deepEqual(saved, [false]);

  // Błąd zapisu: zapamiętany wybór przepada (ekran wraca do stanu z serwera).
  saved.length = 0;
  const failed = queue.request(true);
  queue.request(false);
  pending.shift()(undefined);
  assert.deepEqual(await failed, { target: true, result: undefined });
  assert.deepEqual(saved, [true]);
  assert.equal(queue.busy, false);
});
