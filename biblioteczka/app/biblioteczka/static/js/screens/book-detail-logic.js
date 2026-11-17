// Czyste funkcje ekranu szczegółów książki: dane wydania, podpisy statusu, data dodania na półkę.
// Bez DOM i bez Preacta – testowane w node (tests/js/book-detail.test.mjs).
//
// `book` ma kształt jak w `GET api/state` (views._book_json): title, authorId, seriesId,
// volumeNumber, isOwned, notes, addedAt, isbn, publisher, publicationYear, pageCount, coverId…

import { formatISBN } from '../core/isbn.js';
import { cleanedName } from '../core/text.js';

/** Teksty ekranu (jedno miejsce – łatwo sprawdzić polszczyznę w testach). */
export const TEXT = Object.freeze({
  deleted: 'Książka została usunięta',
  summary: 'Podsumowanie książki',
  unknownAuthor: 'Autor nieznany',
  authorPrefix: 'Autor: ',
  seriesPrefix: 'Seria: ',
  status: 'Status',
  edition: 'Wydanie',
  noEdition: 'Brak danych wydania.',
  notes: 'Notatki',
  removal: 'Usuwanie',
  remove: 'Usuń książkę',
  edit: 'Edytuj książkę',
});

/** Opcje przełącznika statusu – to samo słownictwo co w edytorze książki („Mam” / „Brakuje mi”). */
export const STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: true, label: 'Mam' }),
  Object.freeze({ value: false, label: 'Brakuje mi' }),
]);

/** Data „dodania” pozycji z katalogu podpowiedzi (db.CATALOG_DATE) – nie jest prawdziwą datą. */
const CATALOG_TIME = Date.UTC(2001, 0, 1);

function positiveNumberText(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/**
 * Wiersze sekcji „Wydanie”: zawsze cztery, w stałej kolejności
 * `[{key, label, value: string|null, mono?: true}]`; `value === null` – brak danych.
 */
export function editionRows(book) {
  const b = book || {};
  // Pola tekstowe przychodzą jako tekst albo null; cokolwiek innego traktujemy jak brak.
  const isbn = typeof b.isbn === 'string' ? formatISBN(b.isbn) : '';
  const publisher = typeof b.publisher === 'string' ? cleanedName(b.publisher) : '';
  return [
    { key: 'isbn', label: 'ISBN', value: isbn || null, mono: true },
    { key: 'publisher', label: 'Wydawnictwo', value: publisher || null },
    { key: 'publicationYear', label: 'Rok wydania', value: positiveNumberText(b.publicationYear) },
    { key: 'pageCount', label: 'Liczba stron', value: positiveNumberText(b.pageCount) },
  ];
}

/** Wiersze „Wydania”, które ekran pokazuje – tylko te z wartością (zwykle domowe książki nie mają żadnej). */
export function visibleEditionRows(book) {
  return editionRows(book).filter((row) => row.value !== null);
}

const DATE_FORMAT = new Intl.DateTimeFormat('pl', { day: 'numeric', month: 'long', year: 'numeric' });

/** „12 marca 2025” (miesiąc w dopełniaczu, czas lokalny); brak albo niepoprawna data → ''. */
export function formatAddedDate(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return DATE_FORMAT.format(new Date(time));
}

/**
 * Podpis „Na półce od 12 marca 2025”. Data ma sens tylko dla posiadanej książki: serwer ustawia ją
 * na nowo, gdy książka staje się posiadana, a pozycje z katalogu mają datę zastępczą 2001-01-01.
 * Nieposiadana książka, data zastępcza albo niepoprawna data → ''.
 */
export function addedCaption(iso, isOwned) {
  if (!isOwned) return '';
  if (typeof iso === 'string' && Date.parse(iso) === CATALOG_TIME) return '';
  const date = formatAddedDate(iso);
  return date ? `Na półce od ${date}` : '';
}

/** Podpis pod przełącznikiem statusu (czas teraźniejszy, jak stopki w edytorze). */
export function ownedNote(isOwned, inSeries) {
  if (isOwned) return 'Książka stoi na Twojej półce.';
  return inSeries
    ? 'Książka jest w bazie, ale nie pojawia się na listach. Zobaczysz ją w szczegółach serii jako brakujący tom.'
    : 'Książka jest w bazie, ale nie pojawia się na listach.';
}

/** „tom 3” dla książki w serii z numerem tomu > 0, inaczej ''. */
export function seriesVolumeText(book) {
  if (!book || book.seriesId == null) return '';
  const n = book.volumeNumber;
  return Number.isInteger(n) && n > 0 ? `tom ${n}` : '';
}

/** Notatki do pokazania: przycięte z obu stron; '' – sekcji „Notatki” nie ma. */
export function bookNotes(book) {
  return String(book?.notes ?? '').trim();
}
