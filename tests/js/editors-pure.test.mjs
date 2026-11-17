// Testy czystej logiki edytorów (`static/js/editors/logic.js`): podpowiedzi, duplikaty,
// automatyczny numer tomu, nakładanie danych z katalogów, walidacja ISBN, filtr skanera.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../../biblioteczka/app/biblioteczka/static/js/editors/logic.js';
import { seriesDeletion } from '../../biblioteczka/app/biblioteczka/static/js/screens/logic.js';
import { ApiError } from '../../biblioteczka/app/biblioteczka/static/js/api.js';
import { onPointerRelease } from '../../biblioteczka/app/biblioteczka/static/js/ui/fields.js';

// ---------------------------------------------------------------------------
// Biblioteczka testowa (kształt jak `buildLibrary` ze store.js)
// ---------------------------------------------------------------------------

function makeLibrary({ authors = [], series = [], books = [] }) {
  return {
    loaded: true,
    authors,
    series,
    books,
    authorsById: new Map(authors.map((a) => [a.id, a])),
    seriesById: new Map(series.map((s) => [s.id, s])),
    booksById: new Map(books.map((b) => [b.id, b])),
  };
}

const author = (id, name, bookCount, extra = {}) => ({
  id,
  name,
  bookCount,
  isOnShelf: true,
  seriesIds: [],
  summary: `${bookCount} książek`,
  createdAt: '2024-01-01T00:00:00Z',
  ...extra,
});

const series = (id, name, authorId, extra = {}) => ({
  id,
  name,
  authorId,
  plannedVolumeCount: null,
  notes: '',
  createdAt: '2024-01-01T00:00:00Z',
  isOnShelf: true,
  progress: { owned: 0, total: 0, isComplete: false, fraction: 0 },
  suggestedVolumeNumber: 1,
  authorLine: 'Autor nieznany',
  ...extra,
});

const book = (id, title, authorId, seriesId, extra = {}) => ({
  id,
  title,
  authorId,
  seriesId,
  volumeNumber: null,
  isOwned: true,
  notes: '',
  addedAt: '2024-01-01T00:00:00Z',
  isbn: null,
  publisher: null,
  publicationYear: null,
  pageCount: null,
  coverId: null,
  suggestionSubtitle: '',
  ...extra,
});

const COVER_A = 'a'.repeat(40);
const COVER_B = 'b'.repeat(40);

const LIB = makeLibrary({
  authors: [
    author(1, 'Andrzej Sapkowski', 5),
    author(2, 'Marta Galewska-Kustra', 3),
    author(3, 'J. K. Rowling', 1),
    author(4, 'Stanisław Lem', 2),
    author(5, 'Lemony Snicket', 0),
    author(6, 'Anna Nowak', 3),
    author(7, 'Ewa Katalogowa', 1, { isOnShelf: false }),
  ],
  series: [
    series(10, 'Wiedźmin', 1, {
      createdAt: '2024-01-01T00:00:00Z',
      plannedVolumeCount: 8,
      progress: { owned: 2, total: 8, label: '2/8' },
      suggestedVolumeNumber: 3,
      authorLine: 'Andrzej Sapkowski',
    }),
    series(11, 'Pucio', 2, {
      createdAt: '2024-02-01T00:00:00Z',
      progress: { owned: 1, total: 2 },
      suggestedVolumeNumber: 0,
      authorLine: 'Marta Galewska-Kustra',
    }),
    series(12, 'Wiedźmin', 6, { createdAt: '2023-01-01T00:00:00Z', suggestedVolumeNumber: 1, authorLine: 'Anna Nowak' }),
    series(13, 'Opowiem ci, mamo', null, {
      createdAt: '2025-01-01T00:00:00Z',
      suggestedVolumeNumber: 2,
      authorLine: 'Różni autorzy',
      isOnShelf: false,
    }),
  ],
  books: [
    book(100, 'Ostatnie życzenie', 1, 10, { volumeNumber: 1 }),
    book(101, 'Miecz przeznaczenia', 1, 10, { volumeNumber: 2, isbn: '9788375780635', publisher: 'SuperNowa', pageCount: 330 }),
    book(102, 'Pucio mówi pierwsze słowa', 2, 11),
    book(103, 'Pucio uczy się mówić', 2, 11, { isOwned: false, notes: 'z katalogu', suggestionSubtitle: 'Marta Galewska-Kustra · Pucio' }),
    book(104, 'Bon czy ton. Savoir-vivre dla dzieci', 2, null, {
      isOwned: false,
      notes: 'pożyczona Oli',
      publisher: 'Nasza Księgarnia',
      publicationYear: 2014,
      isbn: '9788310124058',
      coverId: COVER_A,
    }),
    book(105, 'Harry Potter i Kamień Filozoficzny', 3, null),
    book(106, 'Solaris', 4, null),
    book(107, 'Co robią zwierzęta?', null, 13, { isOwned: false, volumeNumber: 1 }),
  ],
});

const emptyForm = (overrides = {}) => ({ ...L.initialBookForm(LIB, {}), ...overrides });

// ---------------------------------------------------------------------------
// Liczby
// ---------------------------------------------------------------------------

test('zakresy liczb (§9.7): spoza zakresu = brak', () => {
  assert.equal(L.clampVolume(0), 0);
  assert.equal(L.clampVolume(1), 1);
  assert.equal(L.clampVolume(999), 999);
  assert.equal(L.clampVolume(1000), 0);
  assert.equal(L.clampVolume(-5), 0);
  assert.equal(L.clampVolume(2.5), 0);
  assert.equal(L.clampVolume('12'), 12);
  assert.equal(L.clampVolume('1-8'), 0);
  assert.equal(L.clampVolume(null), 0);
  assert.equal(L.clampVolume(true), 0);
  assert.equal(L.clampYear(999), 0);
  assert.equal(L.clampYear(1000), 1000);
  assert.equal(L.clampYear(2100), 2100);
  assert.equal(L.clampYear(2101), 0);
  assert.equal(L.clampPages(12000), 0);
  assert.equal(L.clampPages(9999), 9999);
  assert.equal(L.clampPages(0), 0);
});

test('etykieta postępu serii', () => {
  assert.equal(L.progressLabel({ progress: { label: '5/8' } }), '5/8');
  assert.equal(L.progressLabel({ progress: { owned: 0, total: 0 } }), 'brak tomów');
  assert.equal(L.progressLabel({ plannedVolumeCount: 4, progress: { owned: 1, total: 4 } }), '1/4');
  assert.equal(L.progressLabel({ plannedVolumeCount: null, progress: { owned: 1, total: 2 } }), '1/?');
  assert.equal(L.progressLabel({ progress: { owned: 3, total: 3, isTotalKnown: true } }), '3/3');
});

// ---------------------------------------------------------------------------
// Podpowiedzi
// ---------------------------------------------------------------------------

test('podpowiedzi autorów: puste pole → 5 najpłodniejszych, remis wg nazwy', () => {
  const items = L.authorSuggestions(LIB, '');
  assert.deepEqual(
    items.map((i) => i.title),
    ['Andrzej Sapkowski', 'Anna Nowak', 'Marta Galewska-Kustra', 'Stanisław Lem', 'Ewa Katalogowa'],
  );
  assert.equal(items[0].subtitle, '5 książek');
  assert.equal(items[0].icon, 'person-fill');
});

test('podpowiedzi autorów: ranga przed liczbą książek, brak przy dokładnym dopasowaniu', () => {
  assert.deepEqual(
    L.authorSuggestions(LIB, 'lem').map((i) => i.title),
    ['Lemony Snicket', 'Stanisław Lem'],
  );
  assert.deepEqual(L.authorSuggestions(LIB, '  andrzej   SAPKOWSKI '), []);
  // „lodz”-podobne dopasowanie bez polskich znaków
  assert.deepEqual(L.authorSuggestions(LIB, 'stanislaw').map((i) => i.title), ['Stanisław Lem']);
  assert.equal(L.authorSuggestions(LIB, 'a', { limit: 2 }).length, 2);
});

test('podpowiedzi serii: seria dopasowanego autora pierwsza, potem najnowsze', () => {
  const nowak = LIB.authorsById.get(6);
  assert.deepEqual(L.seriesSuggestions(LIB, 'wied', nowak).map((i) => i.id), [12, 10]);
  assert.deepEqual(L.seriesSuggestions(LIB, 'wied', null).map((i) => i.id), [10, 12]);
  const first = L.seriesSuggestions(LIB, 'wied', null)[0];
  assert.equal(first.subtitle, 'Andrzej Sapkowski · 2/8');
  assert.equal(first.icon, 'books-fill');
  assert.equal(L.seriesSuggestions(LIB, 'pucio', null).length, 0, 'dokładne dopasowanie');
  assert.equal(L.seriesSuggestions(LIB, '', null)[0].id, 13, 'puste pole – najnowsza seria');
  assert.equal(L.seriesSuggestions(LIB, 'opow', null)[0].subtitle, 'Różni autorzy · brak tomów');
});

test('podpowiedzi tytułów: tylko „nie mam”, nowa książka, od 2 znaków, bez przejęcia', () => {
  assert.deepEqual(L.titleSuggestions(LIB, 'pu').map((i) => i.id), [103]);
  assert.equal(L.titleSuggestions(LIB, 'pu')[0].subtitle, 'Marta Galewska-Kustra · Pucio');
  assert.deepEqual(L.titleSuggestions(LIB, 'p'), []);
  assert.deepEqual(L.titleSuggestions(LIB, ' p '), []);
  assert.deepEqual(L.titleSuggestions(LIB, 'pu', { isNew: false }), []);
  assert.deepEqual(L.titleSuggestions(LIB, 'pu', { adoptedId: 103 }), []);
  assert.deepEqual(L.titleSuggestions(LIB, 'zwierz').map((i) => i.id), [107]);
  assert.equal(L.titleSuggestions(LIB, 'zwierz')[0].subtitle, null, 'pusty podtytuł → null');

  const many = makeLibrary({
    books: Array.from({ length: 8 }, (_, i) => book(i + 1, `Tom ${8 - i}`, null, null, { isOwned: false })),
  });
  assert.deepEqual(
    L.titleSuggestions(many, 'tom').map((i) => i.title),
    ['Tom 1', 'Tom 2', 'Tom 3', 'Tom 4', 'Tom 5'],
    'najwyżej 5, porządek „po polsku” z liczbami',
  );
});

test('podobni autorzy: słowa ≥ 3 znaki jako podciąg, bez dokładnego dopasowania, najwyżej 3', () => {
  assert.deepEqual(L.similarAuthors(LIB, 'Lem').map((a) => a.id), [5, 4]);
  assert.deepEqual(L.similarAuthors(LIB, 'Le'), []);
  assert.deepEqual(L.similarAuthors(LIB, 'Stanisław Lem'), [], 'dokładne dopasowanie');
  // W edycji własna nazwa nie jest „dokładnym dopasowaniem”, a edytowany autor jest pomijany.
  assert.deepEqual(L.similarAuthors(LIB, 'Stanisław Lem', { excludingId: 4 }).map((a) => a.id), [5]);
  assert.equal(L.similarAuthors(LIB, 'ann').length, 1);
  assert.ok(L.similarAuthors(LIB, 'ska').length <= 3);
});

// ---------------------------------------------------------------------------
// Duplikaty
// ---------------------------------------------------------------------------

test('duplikat książki: tytuł nameKey + zgodny autor albo brak autora', () => {
  assert.equal(L.findDuplicateBook(LIB, { title: 'ostatnie  życzenie', authorName: '' })?.id, 100);
  assert.equal(L.findDuplicateBook(LIB, { title: 'Ostatnie życzenie', authorName: 'andrzej sapkowski' })?.id, 100);
  assert.equal(L.findDuplicateBook(LIB, { title: 'Ostatnie życzenie', authorName: 'Ktoś Inny' }), null);
  assert.equal(L.findDuplicateBook(LIB, { title: 'Ostatnie życzenie', authorName: '', editingId: 100 }), null);
  assert.equal(L.findDuplicateBook(LIB, { title: 'Co robią zwierzęta?', authorName: 'Ktokolwiek' })?.id, 107);
  assert.equal(L.findDuplicateBook(LIB, { title: 'Co robią zwierzęta?', authorName: '', adoptedId: 107 }), null);
  assert.equal(L.findDuplicateBook(LIB, { title: '   ', authorName: '' }), null);
  assert.equal(L.duplicateBookMessage(LIB.booksById.get(100)), 'Masz już tę książkę w biblioteczce.');
  assert.equal(L.duplicateBookMessage(LIB.booksById.get(103)), 'Ta książka jest już w bazie jako „nie mam”.');
});

test('duplikat serii blokuje zapis: pierwsza zgodna wg id', () => {
  assert.equal(L.findDuplicateSeries(LIB, { name: 'wiedźmin', authorName: '' })?.id, 10);
  assert.equal(L.findDuplicateSeries(LIB, { name: 'Wiedźmin', authorName: 'Anna Nowak' })?.id, 12);
  assert.equal(L.findDuplicateSeries(LIB, { name: 'Wiedźmin', authorName: 'Ktoś' }), null);
  assert.equal(L.findDuplicateSeries(LIB, { name: 'Wiedźmin', authorName: '', editingId: 10 })?.id, 12);
  assert.equal(L.findDuplicateSeries(LIB, { name: 'Opowiem ci, mamo', authorName: 'X' })?.id, 13);
  assert.equal(L.duplicateSeriesMessage(LIB.seriesById.get(10)), 'Taka seria jest już w biblioteczce.');
  assert.equal(
    L.duplicateSeriesMessage(LIB.seriesById.get(13)),
    'Ta seria jest już w katalogu podpowiedzi. Dodaj książkę z tej serii, a seria pojawi się na liście.',
  );
});

test('usuwanie serii w edytorze: liczba książek w bierniku, jak w menu wiersza (ed-1)', () => {
  const labels = (n) => L.seriesDeleteActions(n).map((a) => a.label);
  assert.deepEqual(labels(1), ['Usuń serię i 1 książkę', 'Usuń tylko serię']);
  assert.deepEqual(labels(2), ['Usuń serię i 2 książki', 'Usuń tylko serię']);
  assert.deepEqual(labels(5), ['Usuń serię i 5 książek', 'Usuń tylko serię']);
  assert.deepEqual(labels(22), ['Usuń serię i 22 książki', 'Usuń tylko serię']);
  assert.deepEqual(labels(0), ['Usuń serię']);
  for (const n of [0, 1, 2, 5, 12, 22]) {
    const actions = L.seriesDeleteActions(n);
    // Ten sam wybór co w dialogu z menu wiersza serii (screens/logic.js).
    assert.deepEqual(
      actions.map(({ label, withBooks }) => ({ label, withBooks })),
      seriesDeletion({ name: 'Wiedźmin' }, n).options,
      `n = ${n}`,
    );
    assert.ok(actions.every((a) => a.role === 'destructive'));
  }
});

test('edytor autora: istniejący autor blokuje dodanie, w edycji – łączenie', () => {
  let state = L.authorEditorState(LIB, { name: 'stanisław  lem' });
  assert.equal(state.canSave, false);
  assert.equal(state.message, 'Ten autor jest już w biblioteczce.');
  state = L.authorEditorState(LIB, { name: 'Ewa Katalogowa' });
  assert.equal(state.message, 'Ten autor jest już w katalogu podpowiedzi – pojawi się na liście, gdy dodasz jego książkę.');
  state = L.authorEditorState(LIB, { name: 'Stanisław Lem', editingId: 5 });
  assert.equal(state.canSave, true);
  assert.equal(state.willMerge, true);
  assert.equal(state.message, 'Autor „Stanisław Lem” już istnieje – po zapisaniu oba wpisy zostaną połączone.');
  state = L.authorEditorState(LIB, { name: 'Stanisław Lem', editingId: 4 });
  assert.equal(state.willMerge, false);
  assert.equal(state.message, null);
  assert.equal(L.authorEditorState(LIB, { name: '  ' }).canSave, false);
  assert.equal(L.authorEditorState(LIB, { name: 'Nowa Osoba' }).canSave, true);
});

// ---------------------------------------------------------------------------
// Stan początkowy i automatyczny numer tomu (§9.4)
// ---------------------------------------------------------------------------

test('stan początkowy formularza książki', () => {
  const fresh = L.initialBookForm(LIB, {});
  assert.equal(fresh.isOwned, true);
  assert.equal(fresh.volume, 0);
  assert.equal(fresh.volumeSource, 'none');

  const fromSeries = L.initialBookForm(LIB, { seriesId: 10 });
  assert.equal(fromSeries.authorName, 'Andrzej Sapkowski', 'autor serii');
  assert.equal(fromSeries.seriesName, 'Wiedźmin');
  assert.equal(fromSeries.volume, 3, 'suggestedVolumeNumber');
  assert.equal(fromSeries.volumeSource, 'data');

  const placeholder = L.initialBookForm(LIB, { seriesId: 10, volumeNumber: 6, authorId: 4 });
  assert.equal(placeholder.volume, 6);
  assert.equal(placeholder.authorName, 'Stanisław Lem', 'autor z kontekstu ma pierwszeństwo przed autorem serii');

  const edited = L.initialBookForm(LIB, { book: { ...LIB.booksById.get(101), pageCount: 12000, publicationYear: 950 } });
  assert.equal(edited.title, 'Miecz przeznaczenia');
  assert.equal(edited.volume, 2);
  assert.equal(edited.pageCount, 0, 'spoza zakresu → brak');
  assert.equal(edited.year, 0);
  assert.equal(edited.isbnText, '9788375780635');

  const scanned = L.initialBookForm(LIB, { scannedIsbn: '978-83-7578-063-5' });
  assert.equal(scanned.isbnText, '9788375780635');
});

test('numer tomu: istniejąca seria → jej następny tom, nowa → 1, wyczyszczenie czyści', () => {
  let f = emptyForm({ authorName: 'Andrzej Sapkowski', seriesName: 'Wiedźmin' });
  f = L.autoVolume(f, LIB);
  assert.equal(f.volume, 3);
  assert.equal(f.volumeSource, 'auto');

  // Autor zmieniony na innego – numer liczony dla jego serii, dopóki jest automatyczny.
  f = L.autoVolume({ ...f, authorName: 'Anna Nowak' }, LIB);
  assert.equal(f.volume, 1);

  f = L.autoVolume({ ...f, seriesName: '' }, LIB);
  assert.equal(f.volume, 0);
  assert.equal(f.volumeSource, 'none');

  assert.equal(L.autoVolume(emptyForm({ seriesName: 'Zupełnie nowa' }), LIB).volume, 1);
  assert.equal(L.autoVolume(emptyForm({ seriesName: 'pucio' }), LIB).volume, 0, 'seria bez numerów');
  assert.equal(L.autoVolume(emptyForm({ seriesName: 'Wiedźmin' }), LIB).volume, 3, 'bez autora – pierwsza wg nazwy');
});

test('numer tomu: liczony po wpisaniu całej nazwy, a nie po pierwszej literze', () => {
  let f = L.autoVolume(emptyForm({ authorName: 'Andrzej Sapkowski', seriesName: 'W' }), LIB);
  assert.equal(f.volume, 1);
  f = L.autoVolume({ ...f, seriesName: 'Wiedźmin' }, LIB);
  assert.equal(f.volume, 3, 'numer automatyczny jest przeliczany');
});

test('numer tomu: wpisany ręcznie albo z danych zostaje; przy przejęciu bez zmian', () => {
  let f = L.setVolumeByUser(emptyForm({ seriesName: 'Nowa' }), 5);
  f = L.autoVolume({ ...f, seriesName: 'Wiedźmin', authorName: 'Andrzej Sapkowski' }, LIB);
  assert.equal(f.volume, 5);
  assert.equal(f.volumeSource, 'user');

  f = L.setSeries(emptyForm(), 'Wiedźmin', 7);
  assert.equal(L.autoVolume(f, LIB).volume, 7);
  // Seria wyczyszczona: numer z danych zostaje (pole „Tom” jest ukryte, zapis go pominie).
  assert.equal(L.autoVolume({ ...f, seriesName: '' }, LIB).volume, 7);

  f = L.adoptBook(emptyForm(), LIB.booksById.get(103), LIB);
  assert.equal(L.autoVolume({ ...f, seriesName: 'Inna' }, LIB).volume, 0);

  // Numer 0 z danych + wyczyszczenie serii → znów działa automat dla nowej serii.
  f = L.setSeries(emptyForm(), 'Pucio', 0);
  f = L.autoVolume({ ...f, seriesName: '' }, LIB);
  assert.equal(f.volumeSource, 'none');
  assert.equal(L.autoVolume({ ...f, seriesName: 'Nowa' }, LIB).volume, 1);
});

test('numer tomu: zakres 1…999 dla danych', () => {
  assert.equal(L.setSeries(emptyForm(), 'X', 1500).volume, 0);
  assert.equal(L.setVolumeByUser(emptyForm(), 999).volume, 999);
});

// ---------------------------------------------------------------------------
// Przejęcie i tytuł
// ---------------------------------------------------------------------------

test('przejęcie wpisu „nie mam” wczytuje wszystkie jego dane (§9.1)', () => {
  const f = L.adoptBook(emptyForm({ authorName: 'Ktoś', publisher: 'Mój wydawca' }), LIB.booksById.get(104), LIB);
  assert.equal(f.adoptedId, 104);
  assert.equal(f.title, 'Bon czy ton. Savoir-vivre dla dzieci');
  assert.equal(f.authorName, 'Marta Galewska-Kustra');
  assert.equal(f.seriesName, '');
  assert.equal(f.isOwned, true);
  assert.equal(f.notes, 'pożyczona Oli');
  assert.equal(f.isbnText, '9788310124058');
  assert.equal(f.publisher, 'Mój wydawca', 'wpisana wartość wygrywa');
  assert.equal(f.year, 2014);
  assert.equal(f.coverId, COVER_A);

  const noAuthor = L.adoptBook(emptyForm({ authorName: 'Wpisany' }), LIB.booksById.get(107), LIB);
  assert.equal(noAuthor.authorName, 'Wpisany', 'wpis bez autora zostawia wpisanego');
  assert.equal(noAuthor.seriesName, 'Opowiem ci, mamo');
  assert.equal(noAuthor.volume, 1);
  assert.equal(noAuthor.volumeSource, 'data');
});

test('zmiana tytułu po przejęciu: inny nameKey kończy przejęcie, wielkość liter nie', () => {
  const adopted = L.adoptBook(emptyForm(), LIB.booksById.get(103), LIB);
  assert.equal(L.setTitle(adopted, 'PUCIO  uczy się mówić').adoptedId, 103);
  const changed = L.setTitle(adopted, 'Pucio uczy się mówić 2');
  assert.equal(changed.adoptedId, null);
  assert.equal(changed.seriesName, 'Pucio', 'pozostałe pola zostają');
});

test('książka z tym samym ISBN: posiadana → jej dane, „nie mam” → przejęcie', () => {
  const owned = L.fillFromExisting(emptyForm({ isbnText: '9788375780635' }), LIB.booksById.get(101), LIB);
  assert.equal(owned.title, 'Miecz przeznaczenia');
  assert.equal(owned.authorName, 'Andrzej Sapkowski');
  assert.equal(owned.seriesName, 'Wiedźmin');
  assert.equal(owned.volume, 2);
  assert.equal(owned.adoptedId, null);
  assert.equal(owned.publisher, 'SuperNowa');
  assert.equal(owned.pageCount, 330);
  assert.equal(L.findDuplicateBook(LIB, { title: owned.title, authorName: owned.authorName })?.id, 100 + 1);

  const unowned = L.fillFromExisting(emptyForm(), LIB.booksById.get(104), LIB);
  assert.equal(unowned.adoptedId, 104);
  assert.equal(unowned.notes, 'pożyczona Oli');

  assert.equal(L.findIsbnBook(LIB, '9788375780635')?.id, 101);
  assert.equal(L.findIsbnBook(LIB, '9788375780635', { editingId: 101 }), null);
  assert.equal(L.findIsbnBook(LIB, '9780000000002', { extraIds: [106] })?.id, 106, 'identyfikatory z serwera');
});

// ---------------------------------------------------------------------------
// Dane z katalogów
// ---------------------------------------------------------------------------

test('dane z katalogów: oczyszczanie (puste → null, liczby w zakresie)', () => {
  const info = L.sanitizeInfo({
    title: '  Tytuł  ',
    authorName: '',
    seriesName: '   ',
    publisher: '',
    year: 999,
    pageCount: 12000,
    volumeNumber: 3,
    sources: ['Biblioteka Narodowa', 5],
  });
  assert.equal(info.title, 'Tytuł');
  assert.equal(info.authorName, null);
  assert.equal(info.seriesName, null);
  assert.equal(info.publisher, null);
  assert.equal(info.year, null);
  assert.equal(info.pageCount, null);
  assert.equal(info.volumeNumber, 3);
  assert.deepEqual(info.sources, ['Biblioteka Narodowa']);
  assert.equal(L.sanitizeInfo(null), null);
});

test('nowa książka: tytuł i autor z danych, autor w pisowni z bazy, seria autora z tytułu', () => {
  const f = L.applyLookup(
    emptyForm({ title: 'cokolwiek', authorName: 'Ktoś' }),
    { title: 'Pucio i przyjaciele', authorName: 'Marta Galewska Kustra', year: 2020, pageCount: 24, coverId: COVER_B },
    { lib: LIB, isNew: true },
  );
  assert.equal(f.title, 'Pucio i przyjaciele');
  assert.equal(f.authorName, 'Marta Galewska-Kustra', 'looseKey');
  assert.equal(f.seriesName, 'Pucio');
  assert.equal(f.volume, 0, 'seria bez numerów');
  assert.equal(f.year, 2020);
  assert.equal(f.pageCount, 24);
  assert.equal(f.coverId, COVER_B);

  const rowling = L.applyLookup(emptyForm(), { title: 'Nowa', authorName: 'J.K. Rowling' }, { lib: LIB, isNew: true });
  assert.equal(rowling.authorName, 'J. K. Rowling');
});

test('pusty autor ze źródła nie czyści wpisanego (§9.5)', () => {
  const f = L.applyLookup(emptyForm({ authorName: 'Wpisany Autor' }), { title: 'Coś', authorName: '' }, { lib: LIB, isNew: true });
  assert.equal(f.authorName, 'Wpisany Autor');
});

test('nowa książka: dopasowanie do książki w bazie (dokładne i po początku tytułu)', () => {
  const fuzzy = L.applyLookup(
    emptyForm(),
    { title: 'Bon czy ton', authorName: 'Marta Galewska-Kustra' },
    { lib: LIB, isNew: true },
  );
  assert.equal(fuzzy.adoptedId, 104, 'wpis „nie mam” przejęty');
  assert.equal(fuzzy.title, 'Bon czy ton. Savoir-vivre dla dzieci');
  assert.equal(fuzzy.publisher, 'Nasza Księgarnia');

  const owned = L.applyLookup(emptyForm(), { title: 'Ostatnie życzenie', authorName: 'Andrzej Sapkowski' }, { lib: LIB, isNew: true });
  assert.equal(owned.adoptedId, null);
  assert.equal(owned.seriesName, 'Wiedźmin');
  assert.equal(owned.volume, 1);

  assert.equal(L.findLibraryBook(LIB, 'Bon czy', 'Marta Galewska-Kustra')?.id, 104, 'dwa słowa wystarczą');
  assert.equal(L.findLibraryBook(LIB, 'Bon', 'Marta Galewska-Kustra'), null, 'krótszy tytuł musi mieć ≥ 2 słowa');
  assert.equal(L.findLibraryBook(LIB, 'Bon czy tak', 'Marta Galewska-Kustra'), null, 'wspólny początek całymi słowami');
  assert.equal(L.findLibraryBook(LIB, 'Bon czy ton', ''), null, 'bez autora tylko dokładnie');
  assert.equal(L.findLibraryBook(LIB, 'Ostatnie życzenie', 'Ktoś', { editingId: null }), null);
  assert.equal(L.findLibraryBook(LIB, 'Co robią zwierzęta?', 'Ktoś')?.id, 107, 'książka bez autora');
});

test('seria z katalogu: istniejąca w pisowni z bazy, nowa tylko gdy pewna', () => {
  const existing = L.applyLookup(emptyForm(), { title: 'Krew elfów', authorName: 'Andrzej Sapkowski', seriesName: 'WIEDŹMIN', volumeNumber: 3 }, { lib: LIB, isNew: true });
  assert.equal(existing.seriesName, 'Wiedźmin');
  assert.equal(existing.volume, 3);
  assert.equal(existing.volumeSource, 'data');

  const uncertain = L.applyLookup(emptyForm(), { title: 'X', seriesName: 'Seria wydawnicza' }, { lib: LIB, isNew: true });
  assert.equal(uncertain.seriesName, '');
  const certain = L.applyLookup(emptyForm(), { title: 'X', seriesName: 'Nowy cykl', isSeriesCertain: true, volumeNumber: 1500 }, { lib: LIB, isNew: true });
  assert.equal(certain.seriesName, 'Nowy cykl');
  assert.equal(certain.volume, 0, 'tom spoza zakresu');

  const noVolume = L.applyLookup(emptyForm(), { title: 'Sezon burz', authorName: 'Andrzej Sapkowski', seriesName: 'Wiedźmin' }, { lib: LIB, isNew: true });
  assert.equal(noVolume.volume, 3, 'suggestedVolumeNumber istniejącej serii');
});

test('edycja: dane z katalogów tylko w puste pola', () => {
  const start = L.initialBookForm(LIB, { book: LIB.booksById.get(105) });
  const f = L.applyLookup(
    start,
    { title: 'Inny tytuł', authorName: 'Inny', seriesName: 'Harry Potter', isSeriesCertain: true, volumeNumber: 1, publisher: 'Media Rodzina', year: 2000, pageCount: 9999 },
    { lib: LIB, isNew: false, editingId: 105 },
  );
  assert.equal(f.title, 'Harry Potter i Kamień Filozoficzny');
  assert.equal(f.authorName, 'J. K. Rowling');
  assert.equal(f.seriesName, 'Harry Potter', 'pusta seria uzupełniona');
  assert.equal(f.volume, 1);
  assert.equal(f.publisher, 'Media Rodzina');
  assert.equal(f.adoptedId, null, 'w edycji bez dopasowania do bazy');

  const filled = L.applyLookup({ ...start, seriesName: 'Moja', publisher: 'Mój', year: 1999, coverId: COVER_A }, { title: 'X', seriesName: 'Harry Potter', isSeriesCertain: true, publisher: 'P', year: 2000, coverId: COVER_B }, { lib: LIB, isNew: false, editingId: 105 });
  assert.equal(filled.seriesName, 'Moja');
  assert.equal(filled.publisher, 'Mój');
  assert.equal(filled.year, 1999);
  assert.equal(filled.coverId, COVER_A);
});

test('wynik serwera (resolution) ma pierwszeństwo przed lokalnym dopasowaniem', () => {
  const f = L.applyLookup(
    emptyForm(),
    { title: 'Zupełnie inny tytuł', authorName: 'Nikt' },
    { lib: LIB, isNew: true, resolution: { libraryBookId: 103, libraryBookOwned: false, seriesName: 'Pucio', volumeNumber: null } },
  );
  assert.equal(f.adoptedId, 103);
  assert.equal(f.title, 'Pucio uczy się mówić');

  const series = L.applyLookup(
    emptyForm(),
    { title: 'Coś' },
    { lib: LIB, isNew: true, resolution: { libraryBookId: null, seriesName: 'Wiedźmin', volumeNumber: 4 } },
  );
  assert.equal(series.seriesName, 'Wiedźmin');
  assert.equal(series.volume, 4);

  const local = L.resolveLookupLocal(LIB, { title: 'Ostatnie życzenie', authorName: 'Andrzej Sapkowski', seriesName: '' }, {}, { isNew: true });
  assert.deepEqual(local, { libraryBookId: 100, libraryBookOwned: true, seriesName: 'Wiedźmin', volumeNumber: 1 });
});

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------

test('szkic zapisu: normalizacja i klucz coverId tylko przy zmianie', () => {
  const form = emptyForm({
    title: '  Nowa   książka ',
    authorName: ' Ktoś ',
    seriesName: '',
    volume: 4,
    notes: '\n  notatka \n',
    isbnText: '978-83-7578-063-5',
    publisher: '  ',
    year: 0,
    pageCount: 120,
  });
  const draft = L.buildBookDraft(form);
  assert.deepEqual(draft, {
    title: 'Nowa książka',
    authorName: 'Ktoś',
    seriesName: '',
    volumeNumber: null,
    isOwned: true,
    notes: 'notatka',
    isbn: '9788375780635',
    publisher: null,
    publicationYear: null,
    pageCount: 120,
  });
  assert.equal(L.buildBookDraft({ ...form, seriesName: 'S', volume: 4 }).volumeNumber, 4);
  assert.equal(L.buildBookDraft({ ...form, isbnText: ' 123 ' }).isbn, '123', 'niepoprawny ISBN zapisany jako tekst');
  assert.equal(L.buildBookDraft({ ...form, isbnText: '  ' }).isbn, null);

  assert.equal(L.buildBookDraft({ ...form, coverId: COVER_A }).coverId, COVER_A, 'nowa z okładką');
  assert.ok(!('coverId' in L.buildBookDraft({ ...form, coverId: COVER_A }, { hasTarget: true, targetCoverId: COVER_A })));
  assert.equal(L.buildBookDraft({ ...form, coverId: COVER_B }, { hasTarget: true, targetCoverId: COVER_A }).coverId, COVER_B);
  assert.equal(L.buildBookDraft({ ...form, coverId: null }, { hasTarget: true, targetCoverId: COVER_A }).coverId, null, 'usunięcie');
  assert.ok(!('coverId' in L.buildBookDraft({ ...form, coverId: null }, { hasTarget: true, targetCoverId: null })));
});

test('dane wydania do „Mam ją…” / „Zapisz okładkę…”', () => {
  const form = emptyForm({ isbnText: '9788375780635', publisher: ' Wyd ', year: 2001, coverId: COVER_A });
  assert.deepEqual(L.buildEdition(form), {
    isbn: '9788375780635',
    publisher: 'Wyd',
    publicationYear: 2001,
    pageCount: null,
    coverId: COVER_A,
  });
  assert.equal(L.hasEditionInfo(emptyForm()), false);
  assert.equal(L.hasEditionInfo(emptyForm({ isbnText: ' ' })), false);
  assert.equal(L.hasEditionInfo(emptyForm({ pageCount: 10 })), true);
  assert.equal(L.hasEditionInfo(emptyForm({ coverId: COVER_A })), true);
});

test('przycisk pod duplikatem: nieaktywny w czasie zapisu i wysyłania okładki (ed-4)', () => {
  const owned = LIB.booksById.get(100);
  const notOwned = LIB.booksById.get(103);
  const withEdition = emptyForm({ isbnText: '9781593279509' });

  const mark = L.duplicateAction(notOwned, emptyForm(), { isNew: true });
  assert.deepEqual(mark, {
    markOwned: true,
    label: 'Mam ją – oznacz istniejącą jako posiadaną',
    icon: 'check-circle',
    disabled: false,
  });
  const complete = L.duplicateAction(owned, withEdition, { isNew: true });
  assert.equal(complete.markOwned, false);
  assert.equal(complete.label, 'Zapisz okładkę i dane wydania w mojej książce');
  assert.equal(complete.disabled, false);

  // Okładka w drodze: dane wydania nie mają jeszcze jej coverId – oba przyciski czekają.
  assert.equal(L.duplicateAction(owned, withEdition, { isNew: true, coverBusy: true }).disabled, true);
  assert.equal(L.duplicateAction(notOwned, emptyForm(), { isNew: true, coverBusy: true }).disabled, true);
  assert.equal(L.duplicateAction(owned, withEdition, { isNew: true, busy: true }).disabled, true);

  assert.equal(L.duplicateAction(owned, emptyForm(), { isNew: true }), null, 'posiadana bez danych wydania');
  assert.equal(L.duplicateAction(notOwned, emptyForm(), { isNew: false }), null, 'tylko nowa książka');
  assert.equal(L.duplicateAction(null, withEdition, { isNew: true }), null);
});

// ---------------------------------------------------------------------------
// ISBN: pole w edytorze, strażnicy szukania, ręczne wpisanie
// ---------------------------------------------------------------------------

test('pole ISBN w edytorze: ostrzeżenie tylko dla niepustego, niepoprawnego numeru', () => {
  assert.equal(L.isbnFieldWarning(''), null);
  assert.equal(L.isbnFieldWarning('   '), null);
  assert.equal(L.isbnFieldWarning('9788375780635'), null);
  assert.equal(L.isbnFieldWarning('83-7054-061-9'), null);
  assert.equal(L.isbnFieldWarning('9788375780636'), 'Ten numer ISBN wygląda na niepoprawny – sprawdź cyfry.');
});

test('strażnicy szukania (§9.3): jedno naraz, nie ten sam numer, nieaktualny wynik', () => {
  assert.equal(L.typedLookupTarget('123'), null);
  assert.equal(L.typedLookupTarget('9788375780635', { searching: true }), null);
  assert.equal(L.typedLookupTarget('978-83-7578-063-5', { lastLookedUp: '9788375780635' }), null);
  assert.equal(L.typedLookupTarget('8370540619', { lastLookedUp: '9788375780635' })?.digits, '9788370540616');
  assert.equal(L.isStaleLookup('978-83-7578-063-5', '9788375780635'), false);
  assert.equal(L.isStaleLookup('978837578063', '9788375780635'), true);
  assert.equal(L.isStaleLookup('', '9788375780635'), true);
});

test('błąd szukania po ISBN: odmowa serwera pozwala szukać tego samego numeru ponownie (ed-2)', () => {
  const digits = '9780140328721';
  for (const status of [500, 502, 503, 504, 401]) {
    const error = new ApiError(status === 401 ? 'Sesja Home Assistant wygasła. Odśwież stronę.' : 'Biblioteczka nie odpowiada. Spróbuj ponownie za chwilę.', { status });
    const failure = L.lookupFailure(error);
    assert.equal(failure.status, 'idle', `HTTP ${status}`);
    assert.equal(failure.toast, error.message);
    assert.equal(failure.forget, true);
    // Po zapomnieniu numeru „Pobierz dane” i Enter znów działają dla tego samego numeru.
    const lastLookedUp = failure.forget ? null : digits;
    assert.equal(L.typedLookupTarget(digits, { lastLookedUp })?.digits, digits);
  }
  assert.equal(L.lookupFailure(new Error('')).toast, 'Nie udało się wyszukać książki.');

  // Brak połączenia i przekroczony czas: „Brak połączenia z internetem.” + „Spróbuj ponownie” (numer zostaje).
  for (const code of ['network', 'timeout']) {
    assert.deepEqual(L.lookupFailure(new ApiError('Brak połączenia z Home Assistant.', { code })), {
      status: 'offline',
      toast: null,
      forget: false,
    });
  }
  const abort = new Error('przerwano');
  abort.name = 'AbortError';
  assert.deepEqual(L.lookupFailure(abort), { status: 'idle', toast: null, forget: true });
});

test('komunikaty stanu szukania', () => {
  assert.equal(
    L.lookupMessage('idle', { isNew: true }).text,
    'Zeskanuj kod z tyłu książki – uzupełnię tytuł, autora, serię i wydanie.',
  );
  assert.equal(L.lookupMessage('idle', { isNew: false }).text, 'Zeskanuj kod, żeby uzupełnić ISBN, wydanie i okładkę.');
  assert.equal(L.lookupMessage('searching').text, 'Szukam książki…');
  assert.equal(L.lookupMessage('found', { sources: ['Biblioteka Narodowa', 'Open Library'] }).text, 'Dane z: Biblioteka Narodowa, Open Library');
  assert.equal(L.lookupMessage('inLibrary').text, 'Ten numer ISBN jest już w Twojej bazie.');
  assert.equal(L.lookupMessage('notFound').text, 'Nie znalazłem tego numeru w katalogach. Uzupełnij dane ręcznie.');
  assert.equal(L.lookupMessage('offline').text, 'Brak połączenia z internetem.');
  assert.equal(L.lookupMessage('offline').tone, 'warning');
});

test('ręczne wpisanie ISBN: komunikaty z iOS (tylko cyfry ASCII i X)', () => {
  const help = '10 albo 13 cyfr. Znajdziesz go nad kodem kreskowym albo na stronie redakcyjnej.';
  assert.equal(L.manualIsbnState('').footer, help);
  assert.equal(L.manualIsbnState('978-83-7578-063-5').isbn.digits, '9788375780635');
  assert.equal(L.manualIsbnState('978-83-7578-063-5').mistyped, false);
  assert.equal(L.manualIsbnState('9788375780636').mistyped, true);
  assert.equal(L.manualIsbnState('9788375780636').footer, 'Ten numer ma błąd – sprawdź cyfry.');
  assert.equal(L.manualIsbnState('080442957x').isbn.digits, '9780804429573');
  assert.equal(L.manualIsbnState('0804429579').mistyped, true);
  assert.equal(L.manualIsbnState('12345').mistyped, false);
  assert.equal(L.manualIsbnState('９７８８３７５７８０６３６').mistyped, false, 'cyfry pełnej szerokości nie liczą się');
});

// ---------------------------------------------------------------------------
// Skaner
// ---------------------------------------------------------------------------

test('wybór kodu z odczytu: książka ma pierwszeństwo', () => {
  assert.equal(L.pickBarcode([]), null);
  assert.equal(L.pickBarcode(['5901234123457', '9788375780635']).kind, 'book');
  assert.equal(L.pickBarcode([{ rawValue: '9771234567003' }]).kind, 'magazine');
  assert.equal(L.pickBarcode(['5901234123457']).kind, 'other');
  assert.equal(L.scanHint('magazine'), 'To kod czasopisma, a nie książki');
  assert.equal(L.scanHint('other'), 'To nie jest kod książki');
  assert.equal(L.scanHint('book'), null);
});

test('filtr odczytów: dwa zgodne odczyty, ten sam kod w kadrze tylko raz', () => {
  const filter = L.createScanFilter();
  assert.equal(filter.push(['9788375780635']), null, 'pierwszy odczyt');
  const hit = filter.push(['9788375780635']);
  assert.equal(hit.kind, 'book');
  assert.equal(hit.isbn.digits, '9788375780635');
  assert.equal(filter.push(['9788375780635']), null, 'kod wciąż w kadrze');
  assert.equal(filter.push(['9788375780635']), null);
  // Kod znika z kadru (3 puste klatki) i wraca – liczy się znowu.
  filter.push([]);
  filter.push([]);
  filter.push([]);
  assert.equal(filter.push(['9788375780635']), null);
  assert.equal(filter.push(['9788375780635']).kind, 'book');
});

test('filtr odczytów: różne kody i krótkie zniknięcie', () => {
  const filter = L.createScanFilter();
  assert.equal(filter.push(['9771234567003']), null);
  assert.equal(filter.push(['5901234123457']), null, 'inny kod – licznik od nowa');
  assert.equal(filter.push(['5901234123457']).kind, 'other');
  // Jedna pusta klatka (migotanie) nie powoduje powtórzenia komunikatu.
  filter.push([]);
  assert.equal(filter.push(['5901234123457']), null);
  assert.equal(filter.push(['5901234123457']), null);
  assert.equal(filter.push(['9771234567003']), null);
  assert.equal(filter.push(['9771234567003']).kind, 'magazine');
  filter.reset();
  assert.equal(filter.push(['9771234567003']), null);
});

test('wynik dekodowania na serwerze', () => {
  assert.equal(L.serverBarcodeResult(null).kind, 'none');
  assert.equal(L.serverBarcodeResult({ available: false, kind: 'none', codes: [] }).kind, 'none');
  const book = L.serverBarcodeResult({ available: true, kind: 'book', isbn: '9788375780635', codes: ['9788375780635'] });
  assert.equal(book.kind, 'book');
  assert.equal(book.isbn.digits, '9788375780635');
  assert.equal(L.serverBarcodeResult({ available: true, kind: 'magazine', isbn: null, codes: ['9771234567003'] }).kind, 'magazine');
  assert.equal(L.serverBarcodeResult({ available: true, kind: 'other', isbn: null, codes: [] }).kind, 'other');
  assert.equal(L.serverBarcodeResult({ available: true, kind: 'book', isbn: '9788375780636', codes: [] }).kind, 'none', 'zły numer');
});

test('błędy aparatu', () => {
  assert.equal(L.classifyCameraError({ name: 'NotAllowedError' }), 'permission');
  assert.equal(L.classifyCameraError({ name: 'SecurityError' }), 'permission');
  assert.equal(L.classifyCameraError({ name: 'NotFoundError' }), 'unsupported');
  assert.equal(L.classifyCameraError({ name: 'OverconstrainedError' }), 'unsupported');
  assert.equal(L.classifyCameraError({ name: 'NotReadableError' }), 'busy');
  assert.equal(L.classifyCameraError(new Error('x')), 'busy');
});

test('zmniejszanie obrazu bez powiększania', () => {
  assert.deepEqual(L.fitWithin(4000, 3000, 1800), { width: 1800, height: 1350, scale: 0.45 });
  assert.deepEqual(L.fitWithin(100, 50, 1800), { width: 100, height: 50, scale: 1 });
  assert.equal(L.fitWithin(1000, 5000, 2000).height, 2000);
});

test('skaner bez podglądu: żaden tekst nie twierdzi, że skanować się nie da (pl-6)', () => {
  const unsupported = L.SCANNER_UNAVAILABLE.unsupported;
  assert.equal(unsupported.title, 'Aparat jest niedostępny');
  assert.equal(
    unsupported.text,
    'Na tym urządzeniu nie da się skanować kodów na żywo. Wybierz zdjęcie kodu kreskowego – rozpoznam z niego ' +
      'numer ISBN – albo wpisz numer ISBN (jest nad kodem kreskowym albo na stronie redakcyjnej).',
  );
  // Pod każdym z tych tekstów jest sekcja „Zdjęcie kodu” – każdy ją wspomina.
  for (const [mode, info] of Object.entries(L.SCANNER_UNAVAILABLE)) {
    assert.match(info.text, /zdjęci/, mode);
    assert.doesNotMatch(info.text, /nie da się skanować kodów\./, mode);
    assert.doesNotMatch(info.text, /["']/, `${mode}: bez prostych cudzysłowów`);
  }
  assert.deepEqual(Object.keys(L.SCANNER_UNAVAILABLE).sort(), ['busy', 'insecure', 'permission', 'unsupported']);

  // Dekoder na żywo nie ruszył: zdjęcie pomoże tylko z dekoderem na serwerze.
  assert.equal(
    L.detectorFailedNote(true),
    'Nie udało się uruchomić rozpoznawania kodów na żywo. Rozpoznaj kod ze zdjęcia albo wpisz numer ISBN ręcznie.',
  );
  assert.equal(L.detectorFailedNote(false), 'Nie udało się uruchomić rozpoznawania kodów. Wpisz numer ISBN ręcznie.');
});

// ---------------------------------------------------------------------------
// Pole z podpowiedziami (ui/fields.js)
// ---------------------------------------------------------------------------

function pointerEvent(type, pointerId) {
  const event = new Event(type);
  event.pointerId = pointerId;
  return event;
}

test('puszczenie wskaźnika poza listą podpowiedzi też kończy wciśnięcie (ed-3)', () => {
  const doc = new EventTarget();
  const calls = [];
  onPointerRelease(1, (event) => calls.push(`${event.type}:${event.pointerId}`), doc);
  doc.dispatchEvent(pointerEvent('pointerup', 2));
  assert.deepEqual(calls, [], 'inny wskaźnik (drugi palec) się nie liczy');
  doc.dispatchEvent(pointerEvent('pointerup', 1));
  assert.deepEqual(calls, ['pointerup:1']);
  doc.dispatchEvent(pointerEvent('pointerup', 1));
  doc.dispatchEvent(pointerEvent('pointercancel', 1));
  assert.deepEqual(calls, ['pointerup:1'], 'jednorazowo');

  // Dotyk: przewinięcie arkusza anuluje wskaźnik.
  const cancelled = [];
  onPointerRelease(7, (event) => cancelled.push(event.type), doc);
  doc.dispatchEvent(pointerEvent('pointercancel', 7));
  doc.dispatchEvent(pointerEvent('pointerup', 7));
  assert.deepEqual(cancelled, ['pointercancel']);

  // Rezygnacja z nasłuchu.
  const none = [];
  const stop = onPointerRelease(3, () => none.push('x'), doc);
  stop();
  doc.dispatchEvent(pointerEvent('pointerup', 3));
  assert.deepEqual(none, []);
});
