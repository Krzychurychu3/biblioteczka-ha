// Testy ekranu szczegółów książki: dane wydania, data „Na półce od…”, podpisy statusu,
// tom w serii, notatki, teksty interfejsu oraz strażnicy pliku CSS i niezależności od układu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../../biblioteczka/app/biblioteczka/static/js');
const logic = await import(path.join(js, 'screens/book-detail-logic.js'));

const {
  STATUS_OPTIONS,
  TEXT,
  addedCaption,
  bookNotes,
  editionRows,
  formatAddedDate,
  ownedNote,
  seriesVolumeText,
  visibleEditionRows,
} = logic;

function book(extra = {}) {
  return {
    id: 1,
    title: 'Ostatnie życzenie',
    authorId: null,
    seriesId: null,
    volumeNumber: null,
    isOwned: true,
    notes: '',
    addedAt: '2025-03-12T12:00:00Z',
    isbn: null,
    publisher: null,
    publicationYear: null,
    pageCount: null,
    coverId: null,
    coverSeed: 'Ostatnie życzenie',
    coverLabel: null,
    seriesLine: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// „Wydanie”
// ---------------------------------------------------------------------------

test('editionRows: komplet danych w stałej kolejności, ISBN czcionką o stałej szerokości', () => {
  const rows = editionRows(
    book({ isbn: '9788375780635', publisher: 'SuperNOWA', publicationYear: 2014, pageCount: 332 }),
  );
  assert.deepEqual(
    rows.map((r) => r.key),
    ['isbn', 'publisher', 'publicationYear', 'pageCount'],
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    ['ISBN', 'Wydawnictwo', 'Rok wydania', 'Liczba stron'],
  );
  assert.deepEqual(
    rows.map((r) => r.value),
    ['9788375780635', 'SuperNOWA', '2014', '332'],
  );
  assert.equal(rows[0].mono, true);
  assert.ok(rows.slice(1).every((r) => !r.mono));
});

test('editionRows: ISBN-10 i ISBN z kreskami pokazujemy jako 13 cyfr', () => {
  assert.equal(editionRows(book({ isbn: '83-7578-063-4' }))[0].value, '9788375780635');
  assert.equal(editionRows(book({ isbn: 'ISBN 978-83-7578-063-5' }))[0].value, '9788375780635');
  // Tekst, który nie jest poprawnym ISBN, zostaje (po przycięciu) – nie gubimy danych użytkownika.
  assert.equal(editionRows(book({ isbn: '  12345 ' }))[0].value, '12345');
});

test('editionRows: brak danych (null, pusty tekst, 0) → cztery wiersze z value === null', () => {
  for (const empty of [null, undefined, '', '   ', 0]) {
    const rows = editionRows(book({ isbn: empty, publisher: empty, publicationYear: empty, pageCount: empty }));
    assert.equal(rows.length, 4);
    assert.ok(
      rows.every((r) => r.value === null),
      `wartość ${JSON.stringify(empty)}`,
    );
  }
  assert.equal(editionRows(null).length, 4);
  assert.ok(editionRows(null).every((r) => r.value === null));
});

test('editionRows: ujemne i nieliczbowe rok/strony → brak; wydawnictwo bez nadmiarowych spacji', () => {
  const rows = editionRows(book({ publisher: '  Wydawnictwo   Literackie \n', publicationYear: -5, pageCount: 'dużo' }));
  assert.equal(rows[1].value, 'Wydawnictwo Literackie');
  assert.equal(rows[2].value, null);
  assert.equal(rows[3].value, null);
});

test('visibleEditionRows: tylko wiersze z wartością, w tej samej kolejności', () => {
  assert.deepEqual(visibleEditionRows(book()), []);
  assert.deepEqual(
    visibleEditionRows(book({ publisher: 'Znak', pageCount: 120 })).map((r) => [r.label, r.value]),
    [
      ['Wydawnictwo', 'Znak'],
      ['Liczba stron', '120'],
    ],
  );
});

// ---------------------------------------------------------------------------
// Data na półce
// ---------------------------------------------------------------------------

test('formatAddedDate: dzień, miesiąc w dopełniaczu i rok', () => {
  // Południe UTC – strefa czasowa komputera z testami nie przesunie dnia.
  assert.equal(formatAddedDate('2025-03-12T12:00:00Z'), '12 marca 2025');
  assert.equal(formatAddedDate('2025-01-05T12:00:00Z'), '5 stycznia 2025');
  assert.equal(formatAddedDate('2024-12-24T12:00:00Z'), '24 grudnia 2024');
});

test('formatAddedDate: brak albo niepoprawna data → pusty tekst', () => {
  for (const bad of ['', '   ', 'wczoraj', '2025-13-45T00:00:00Z', null, undefined, 0, {}]) {
    assert.equal(formatAddedDate(bad), '', `wartość ${JSON.stringify(bad)}`);
  }
});

test('addedCaption: „Na półce od …” tylko dla posiadanej książki z prawdziwą datą', () => {
  assert.equal(addedCaption('2025-03-12T12:00:00Z', true), 'Na półce od 12 marca 2025');
  assert.equal(addedCaption('2025-03-12T12:00:00Z', false), '');
  assert.equal(addedCaption('', true), '');
  assert.equal(addedCaption('nie-data', true), '');
  // Data zastępcza pozycji z katalogu (db.CATALOG_DATE) nie jest datą dodania na półkę.
  assert.equal(addedCaption('2001-01-01T00:00:00Z', true), '');
  assert.equal(addedCaption('2001-01-02T12:00:00Z', true), 'Na półce od 2 stycznia 2001');
});

// ---------------------------------------------------------------------------
// Status, seria, notatki
// ---------------------------------------------------------------------------

test('ownedNote: trzy warianty, dokładne teksty', () => {
  assert.equal(ownedNote(true, true), 'Książka stoi na Twojej półce.');
  assert.equal(ownedNote(true, false), 'Książka stoi na Twojej półce.');
  assert.equal(
    ownedNote(false, true),
    'Książka jest w bazie, ale nie pojawia się na listach. Zobaczysz ją w szczegółach serii jako brakujący tom.',
  );
  assert.equal(ownedNote(false, false), 'Książka jest w bazie, ale nie pojawia się na listach.');
});

test('STATUS_OPTIONS: słownictwo edytora („Mam” / „Brakuje mi”), wartości logiczne', () => {
  assert.deepEqual(
    STATUS_OPTIONS.map((o) => [o.value, o.label]),
    [
      [true, 'Mam'],
      [false, 'Brakuje mi'],
    ],
  );
  assert.ok(Object.isFrozen(STATUS_OPTIONS));
});

test('seriesVolumeText: „tom N” tylko w serii z numerem > 0', () => {
  assert.equal(seriesVolumeText(book({ seriesId: 2, volumeNumber: 3 })), 'tom 3');
  assert.equal(seriesVolumeText(book({ seriesId: 2, volumeNumber: 12 })), 'tom 12');
  assert.equal(seriesVolumeText(book({ seriesId: null, volumeNumber: 3 })), '');
  assert.equal(seriesVolumeText(book({ seriesId: 2, volumeNumber: null })), '');
  assert.equal(seriesVolumeText(book({ seriesId: 2, volumeNumber: 0 })), '');
  assert.equal(seriesVolumeText(book({ seriesId: 2, volumeNumber: -1 })), '');
  assert.equal(seriesVolumeText(null), '');
});

test('bookNotes: przycięte; same białe znaki → brak sekcji', () => {
  assert.equal(bookNotes(book({ notes: '\n  Pożyczona Ani.\nWróci w maju.  \n' })), 'Pożyczona Ani.\nWróci w maju.');
  assert.equal(bookNotes(book({ notes: ' \n\t ' })), '');
  assert.equal(bookNotes(book({ notes: null })), '');
  assert.equal(bookNotes(null), '');
});

test('teksty ekranu: poprawna polszczyzna i spójność z resztą aplikacji', () => {
  assert.equal(TEXT.deleted, 'Książka została usunięta');
  assert.equal(TEXT.unknownAuthor, 'Autor nieznany');
  assert.equal(TEXT.noEdition, 'Brak danych wydania.');
  assert.equal(TEXT.edit, 'Edytuj książkę');
  assert.equal(TEXT.remove, 'Usuń książkę');
  assert.equal(TEXT.authorPrefix, 'Autor: ');
  assert.equal(TEXT.seriesPrefix, 'Seria: ');
  // Bez prostych cudzysłowów i „ - ” zamiast półpauzy.
  for (const value of Object.values(TEXT)) {
    assert.doesNotMatch(value, /["']| - /, value);
  }
});

// ---------------------------------------------------------------------------
// Strażnicy plików
// ---------------------------------------------------------------------------

/** Selektory reguł pliku CSS (poza preludiami @media/@supports/@container i wnętrzem @keyframes). */
function cssSelectors(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(start, i).trim();
      const inKeyframes = stack.includes('keyframes');
      if (/^@(-webkit-)?keyframes\b/.test(prelude)) stack.push('keyframes');
      else if (prelude.startsWith('@')) stack.push('group');
      else {
        stack.push('rule');
        if (!inKeyframes) selectors.push(...prelude.split(',').map((s) => s.trim()));
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    } else if (ch === ';' && stack.at(-1) !== 'rule') {
      start = i + 1;
    }
  }
  return selectors;
}

test('book-detail.css: każdy selektor ma klasę .book-detail… (bez globalnych zmian wspólnych klas)', () => {
  const css = readFileSync(path.resolve(js, '../css/book-detail.css'), 'utf8');
  const selectors = cssSelectors(css);
  assert.ok(selectors.length > 5, 'parser nie znalazł reguł');
  for (const selector of selectors) {
    assert.match(selector, /\.book-detail\b/, `selektor bez .book-detail: ${selector}`);
  }
  assert.doesNotMatch(css, /@keyframes|animation\s*:/, 'ekran szczegółów nie ma animacji');
});

test('strażnik parsera CSS: wykrywa obcy selektor także wewnątrz @media', () => {
  const selectors = cssSelectors('.book-detail-a{color:red}@media (max-width: 9px){.card,.book-detail-b{gap:0}}');
  assert.deepEqual(selectors, ['.book-detail-a', '.card', '.book-detail-b']);
});

test('book-detail.js: nie zależy od układu (bez usePane, matchMedia, ui/split.js, app.js)', () => {
  const source = readFileSync(path.join(js, 'screens/book-detail.js'), 'utf8');
  assert.doesNotMatch(source, /usePane|PaneContext|matchMedia|useMediaQuery|isSplitView|useSplitView/);
  assert.doesNotMatch(source, /from '\.\.\/(app|ui\/split|ui\/router)\.js'/);
  assert.match(source, /export function BookDetailScreen\(\{ id, route \}\)/);
});

test('book-detail.js: przełącznik statusu zapisuje każdy wybór (set z kolejką), a nie pomija go w trakcie zapisu', () => {
  const source = readFileSync(path.join(js, 'screens/book-detail.js'), 'utf8');
  const segmented = /<\$\{Segmented\}([\s\S]*?)\/>/.exec(source);
  assert.ok(segmented, 'Segmented');
  assert.match(segmented[1], /onChange=\$\{setOwnedStatus\}/);
  assert.doesNotMatch(source, /toggle\(\)/);
  assert.match(source, /const \[owned, , setOwnedStatus\] = useOwnedToggle\(book\);/);
  // Hook zwraca trzecią funkcję, która korzysta z kolejki zapisów.
  const common = readFileSync(path.join(js, 'screens/common.js'), 'utf8');
  assert.match(common, /createOwnedQueue\(/);
  assert.match(common, /return \[owned, toggle, set\];/);
});
