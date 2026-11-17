// Czyste funkcje ekranów: filtry, sortowanie, wyszukiwanie, statystyki i teksty komunikatów.
// Bez DOM i bez Preacta – testowane w node (tests/js/screens-pure.test.mjs).
//
// Funkcje przyjmują obiekt biblioteczki z store.js (`buildLibrary`) albo jego części
// (listy, mapy `authorsById`, `seriesById`, `booksById`, `booksByAuthor`, `seriesByAuthor`).

import { cleanedName, compareLocalized, matchRank } from '../core/text.js';
import { count, countAccusative, form } from '../core/polish.js';

// ---------------------------------------------------------------------------
// Drobne narzędzia
// ---------------------------------------------------------------------------

/** Odmiana dowolnego rzeczownika po liczbie (jak Polish.form): [jedna, kilka, wiele]. */
export function plural(n, [one, few, many]) {
  if (n === 1) return one;
  const last = n % 10;
  const lastTwo = n % 100;
  if (n > 0 && last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

function compareNumbers(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Kopia listy posortowana komparatorem; remisy rozstrzyga `id` (ta sama kolejność na każdym urządzeniu). */
function sortWith(items, compare) {
  return [...(items || [])].sort((a, b) => compare(a, b) || compareNumbers(a?.id ?? 0, b?.id ?? 0));
}

const byTitle = (a, b) => compareLocalized(a.title, b.title);
const byName = (a, b) => compareLocalized(a.name, b.name);

// ---------------------------------------------------------------------------
// Serie: postęp, wiersze, nagłówek
// ---------------------------------------------------------------------------

/** Czy liczba tomów serii jest znana (iOS `isTotalKnown`). */
export function isTotalKnown(series) {
  return series?.plannedVolumeCount !== null && series?.plannedVolumeCount !== undefined;
}

/** Liczba brakujących miejsc na półce serii (puste tomy i nieposiadane książki). */
export function missingCount(series) {
  const progress = series?.progress || {};
  return Math.max(0, (progress.total || 0) - (progress.owned || 0));
}

/** Podpis postępu: „brak tomów”, „5/8” albo „3/?”. */
export function progressLabel(series) {
  const { owned = 0, total = 0 } = series?.progress || {};
  if (total === 0) return 'brak tomów';
  return isTotalKnown(series) ? `${owned}/${total}` : `${owned}/?`;
}

/**
 * Trzecia linia wiersza serii (SeriesRow): pasek z podpisem „5/8”, gdy liczba tomów jest znana,
 * w przeciwnym razie tekst „Brak tomów” albo „3 tomy na półce”.
 */
export function seriesRowStatus(series) {
  const { owned = 0, total = 0 } = series?.progress || {};
  if (isTotalKnown(series)) return { kind: 'progress', label: progressLabel(series) };
  return { kind: 'text', text: total === 0 ? 'Brak tomów' : `${count(owned, 'volume')} na półce` };
}

/** Podpis obok dużej liczby w nagłówku serii: „z 1 tomu”, „z 8 tomów”, „tomy na półce”. */
export function seriesCountCaption(series) {
  const { owned = 0, total = 0 } = series?.progress || {};
  if (isTotalKnown(series)) return `z ${total} ${total === 1 ? 'tomu' : 'tomów'}`;
  return `${form(owned, 'volume')} na półce`;
}

/**
 * Wiersze sekcji „Tomy”: puste miejsca (`placeholder`) i książki (`book`) w kolejności półki.
 * Kilka książek z tym samym numerem to kilka wierszy jednego miejsca.
 */
export function volumeRows(series, booksById) {
  const rows = [];
  for (const slot of series?.slots || []) {
    const books = (slot.bookIds || []).map((id) => booksById.get(id)).filter(Boolean);
    if (!books.length) {
      if (slot.number !== null && slot.number !== undefined) rows.push({ kind: 'placeholder', number: slot.number });
      continue;
    }
    for (const book of books) rows.push({ kind: 'book', book, number: slot.number ?? null });
  }
  return rows;
}

/**
 * Podpis tomu w szczegółach serii: „Tom 3”, a w serii bez autora (wielu autorów) także autor
 * tomu: „Tom 3 · Nikola Kucharska”. `null`, gdy nie ma czego pokazać.
 */
export function volumeCaption(book, number, series, authorsById) {
  const parts = [];
  if (number !== null && number !== undefined) parts.push(`Tom ${number}`);
  if (series && (series.authorId === null || series.authorId === undefined) && book.authorId != null) {
    const author = authorsById.get(book.authorId);
    if (author) parts.push(author.name);
  }
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Karta „Serie”: statystyki i filtr
// ---------------------------------------------------------------------------

export const SERIES_FILTERS = Object.freeze([
  { value: 'all', label: 'Wszystkie' },
  { value: 'incomplete', label: 'Niekompletne' },
  { value: 'complete', label: 'Kompletne' },
]);

/**
 * Kafelki biblioteczki (iOS LibraryStatsView): posiadane książki, kompletne serie i braki –
 * liczone tylko dla serii z co najmniej jedną posiadaną książką (katalog się nie liczy).
 */
export function libraryStats({ books = [], series = [] }) {
  let owned = 0;
  for (const book of books) if (book.isOwned) owned += 1;
  let completeSeries = 0;
  let missing = 0;
  for (const item of series) {
    if (!item.hasOwnedBooks) continue;
    if (item.progress?.isComplete) completeSeries += 1;
    missing += missingCount(item);
  }
  return { owned, completeSeries, missing };
}

/** Serie na półce po filtrze: wszystkie, niekompletne (także o nieznanej wielkości) albo kompletne. */
export function filterSeries(shelfSeries, filter) {
  switch (filter) {
    case 'incomplete':
      return shelfSeries.filter((s) => !s.progress?.isComplete);
    case 'complete':
      return shelfSeries.filter((s) => Boolean(s.progress?.isComplete));
    default:
      return shelfSeries;
  }
}

/** Pusta biblioteczka: żadnej serii na półce i żadnej posiadanej książki. */
export function isLibraryEmpty(shelfSeries, books) {
  return shelfSeries.length === 0 && !books.some((b) => b.isOwned);
}

/** Pusty wiersz listy serii dla danego filtra. */
export function emptyFilterRow(filter) {
  switch (filter) {
    case 'incomplete':
      return { icon: 'party', text: 'Wszystkie serie są kompletne. Brawo!', action: false };
    case 'complete':
      return { icon: 'hourglass', text: 'Żadna seria nie jest jeszcze kompletna.', action: false };
    default:
      return { icon: 'plus-circle', text: 'Nie masz jeszcze żadnej serii – dodaj pierwszą', action: true };
  }
}

// ---------------------------------------------------------------------------
// Karta „Książki”: sortowanie
// ---------------------------------------------------------------------------

export const BOOK_SORTS = Object.freeze([
  { value: 'title', label: 'Tytuł', icon: 'textformat' },
  { value: 'author', label: 'Autor i seria', icon: 'person' },
  { value: 'recent', label: 'Ostatnio dodane', icon: 'clock' },
]);

export function isBookSort(value) {
  return BOOK_SORTS.some((s) => s.value === value);
}

/**
 * Porządek „Autor i seria”: autor (książki bez autora na końcu) → seria (bez serii najpierw)
 * → numer tomu (brak = 0) → tytuł. Wszystkie napisy w porządku „po polsku”.
 */
export function compareByAuthorAndSeries(a, b, { authorsById, seriesById }) {
  const authorA = a.authorId != null ? authorsById.get(a.authorId)?.name ?? null : null;
  const authorB = b.authorId != null ? authorsById.get(b.authorId)?.name ?? null : null;
  if (authorA !== authorB) {
    if (authorA === null) return 1;
    if (authorB === null) return -1;
    const result = compareLocalized(authorA, authorB);
    if (result) return result;
  }
  const seriesA = a.seriesId != null ? seriesById.get(a.seriesId)?.name ?? '' : '';
  const seriesB = b.seriesId != null ? seriesById.get(b.seriesId)?.name ?? '' : '';
  if (seriesA !== seriesB) {
    const result = compareLocalized(seriesA, seriesB);
    if (result) return result;
  }
  const volumeA = a.volumeNumber ?? 0;
  const volumeB = b.volumeNumber ?? 0;
  if (volumeA !== volumeB) return volumeA - volumeB;
  return compareLocalized(a.title, b.title);
}

/** Porównanie dat dodania (ISO 8601 UTC) – nowsze najpierw. */
function compareRecent(a, b) {
  const x = String(a.addedAt ?? '');
  const y = String(b.addedAt ?? '');
  return x === y ? 0 : x < y ? 1 : -1;
}

/**
 * Posiadane książki w wybranym porządku. `books` są już posortowane wg tytułu
 * (store.ownedBooks), więc remisy „Ostatnio dodanych” zostają alfabetyczne.
 */
export function sortBooks(books, sort, indexes) {
  switch (sort) {
    case 'author':
      return sortWith(books, (a, b) => compareByAuthorAndSeries(a, b, indexes));
    case 'recent':
      return [...books].sort(compareRecent);
    default:
      return sortWith(books, byTitle);
  }
}

/** Nagłówek listy książek: „1 książka na półce”, „5 książek na półce”. */
export function shelfHeader(n) {
  return `${count(n, 'book')} na półce`;
}

// ---------------------------------------------------------------------------
// Szukaj
// ---------------------------------------------------------------------------

export const RECENT_LIMIT = 8;

/** Zapytanie jest puste, gdy po oczyszczeniu nic nie zostaje (same spacje = puste). */
export function isQueryEmpty(query) {
  return cleanedName(query ?? '') === '';
}

/** „Ostatnio dodane”: posiadane książki od najnowszej, najwyżej `limit`. */
export function recentBooks(ownedBooksByTitle, limit = RECENT_LIMIT) {
  return [...ownedBooksByTitle].sort(compareRecent).slice(0, limit);
}

/**
 * Ranking trafień: najpierw początek nazwy (0), potem początek słowa (1), potem środek (2);
 * w obrębie tej samej trafności zostaje kolejność wejściowa (alfabetyczna).
 */
export function rankByMatch(items, getText, query) {
  if (isQueryEmpty(query)) return [];
  const ranked = [];
  items.forEach((item, index) => {
    const rank = matchRank(getText(item), query);
    if (rank !== null && rank !== undefined) ranked.push({ item, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.item);
}

/**
 * Wyniki wyszukiwania: autorzy i serie na półce (po nazwie) i posiadane książki (po tytule).
 * Listy wejściowe mają być już posortowane alfabetycznie i przefiltrowane do „półki”.
 */
export function searchLibrary({ authors = [], series = [], books = [] }, query) {
  const result = {
    authors: rankByMatch(authors, (a) => a.name, query),
    series: rankByMatch(series, (s) => s.name, query),
    books: rankByMatch(books, (b) => b.title, query),
  };
  result.isEmpty = !result.authors.length && !result.series.length && !result.books.length;
  return result;
}

/** Zapytanie do komunikatu „Brak wyników dla „…””. */
export function queryForDisplay(query) {
  return cleanedName(query ?? '');
}

// ---------------------------------------------------------------------------
// Szczegóły autora
// ---------------------------------------------------------------------------

/**
 * Sekcje ekranu autora:
 * - `series` – jego serie na półce (wg nazwy);
 * - `standalone` – posiadane książki bez serii („Pojedyncze tytuły”);
 * - `otherSeries` – posiadane książki w seriach wspólnych albo innych autorów
 *   („W innych seriach”, poprawka §9.9: inaczej nagłówek liczyłby książki, których nie widać);
 * - `missing` – suma braków w jego seriach na półce (do nagłówka „N brakuje”).
 */
export function authorSections(lib, authorId) {
  const series = sortWith(
    (lib.seriesByAuthor.get(authorId) || []).filter((s) => s.isOnShelf),
    byName,
  );
  const owned = (lib.booksByAuthor.get(authorId) || []).filter((b) => b.isOwned);
  const standalone = sortWith(
    owned.filter((b) => b.seriesId === null || b.seriesId === undefined),
    byTitle,
  );
  const otherSeries = sortWith(
    owned.filter((b) => {
      if (b.seriesId === null || b.seriesId === undefined) return false;
      const item = lib.seriesById.get(b.seriesId);
      return !item || item.authorId !== authorId;
    }),
    (a, b) => compareByAuthorAndSeries(a, b, { authorsById: new Map(), seriesById: lib.seriesById }),
  );
  const missing = series.reduce((sum, s) => sum + missingCount(s), 0);
  return { series, standalone, otherSeries, missing };
}

// ---------------------------------------------------------------------------
// Usuwanie (teksty dialogów jak w iOS DeletionDialogs)
// ---------------------------------------------------------------------------

/**
 * Dialog usuwania serii. `bookCount` – wszystkie książki serii (także nieposiadane).
 * Zwraca `{title, message, options: [{label, withBooks}]}`.
 */
export function seriesDeletion(series, bookCount) {
  return {
    title: 'Usunąć serię?',
    message: `„${series.name}” – jeśli usuniesz tylko serię, jej książki zostaną w biblioteczce jako pojedyncze tytuły.`,
    options:
      bookCount > 0
        ? [
            { label: `Usuń serię i ${countAccusative(bookCount, 'book')}`, withBooks: true },
            { label: 'Usuń tylko serię', withBooks: false },
          ]
        : [{ label: 'Usuń serię', withBooks: false }],
  };
}

/** Dialog usuwania autora: z książkami (i jego seriami) albo tylko autora. */
export function authorDeletion(author, bookCount, seriesCount) {
  return {
    title: 'Usunąć autora?',
    message: `„${author.name}” – jeśli usuniesz tylko autora, jego książki i serie zostaną w biblioteczce bez przypisanego autora.`,
    options:
      bookCount > 0 || seriesCount > 0
        ? [
            { label: `Usuń razem z książkami (${bookCount})`, withBooks: true },
            { label: 'Usuń tylko autora', withBooks: false },
          ]
        : [{ label: 'Usuń autora', withBooks: false }],
  };
}

/** Dialog usuwania książki z listy (w iOS bez pytania – tu bez możliwości cofnięcia, więc pytamy). */
export function bookDeletion(book) {
  return {
    title: 'Usunąć tę książkę?',
    message: `„${book.title}” – tej operacji nie można cofnąć.`,
    label: 'Usuń książkę',
  };
}

// ---------------------------------------------------------------------------
// Menu „Więcej”
// ---------------------------------------------------------------------------

/** Czy jest co eksportować: posiadane książki albo brakujące tomy serii, z których coś masz. */
export function hasExportableBooks({ books = [], seriesById }) {
  return books.some((b) => b.isOwned || (b.seriesId != null && Boolean(seriesById.get(b.seriesId)?.hasOwnedBooks)));
}

/** Treść alertu „Katalog bajek dla dzieci” po imporcie. */
export function catalogImportMessage(added) {
  // Liczba pojedyncza wymaga też czasownika i zaimka w liczbie pojedynczej.
  if (added === 1) {
    return 'Dodano 1 książkę do bazy podpowiedzi. Nie pojawi się na listach – zobaczysz ją, gdy zaczniesz wpisywać tytuł przy dodawaniu książki.';
  }
  if (added > 0) {
    return `Dodano ${countAccusative(added, 'book')} do bazy podpowiedzi. Nie pojawią się na listach – zobaczysz je, gdy zaczniesz wpisywać tytuł przy dodawaniu książki.`;
  }
  return 'Wszystkie pozycje z katalogu są już w bazie.';
}

export const CSV_ERROR_LIMIT = 5;

/** Komunikaty błędów z raportu (serwer przysyła najwyżej kilkadziesiąt pierwszych). */
function csvReportErrors(report) {
  return Array.isArray(report?.errors) ? report.errors.map(String) : [];
}

/**
 * Łączna liczba błędów importu: `errorCount` z serwera (także te, których komunikatów
 * nie przysłano), a w starszych raportach bez tego pola – długość listy `errors`.
 */
function csvErrorTotal(report, errors) {
  return Math.max(Number(report?.errorCount) || 0, errors.length);
}

/**
 * Raport importu CSV jako linie tekstu.
 * `report` = `{added, updated, skipped, errors: [str], errorCount}` z serwera;
 * `skipped` liczy wiersze bez zmian i wiersze odrzucone (np. bez tytułu).
 */
export function csvImportReport(report) {
  const added = Number(report?.added) || 0;
  const updated = Number(report?.updated) || 0;
  const skipped = Number(report?.skipped) || 0;
  const errors = csvReportErrors(report);
  const total = csvErrorTotal(report, errors);
  const lines = [];
  if (added > 0) lines.push(`Dodano ${countAccusative(added, 'book')}.`);
  if (updated > 0) lines.push(`Uzupełniono dane: ${updated} ${plural(updated, ['książka', 'książki', 'książek'])}.`);
  if (skipped > 0) lines.push(`Pominięto: ${skipped} ${plural(skipped, ['pozycja', 'pozycje', 'pozycji'])}.`);
  if (!added && !updated && !skipped && !total) lines.push('Plik nie zawiera żadnych książek do zaimportowania.');
  if (total) {
    lines.push(total === 1 ? 'Błąd:' : `Błędy (${total}):`);
    const shown = errors.slice(0, CSV_ERROR_LIMIT);
    for (const error of shown) lines.push(`• ${error}`);
    if (total > shown.length) lines.push(`…i ${total - shown.length} więcej.`);
  }
  return lines;
}

/** Tytuł alertu po imporcie CSV. */
export function csvImportTitle(report) {
  const changed = (Number(report?.added) || 0) + (Number(report?.updated) || 0);
  const errors = csvErrorTotal(report, csvReportErrors(report));
  return !changed && errors ? 'Nie udało się zaimportować' : 'Import z CSV';
}

/**
 * Postęp pobierania okładek z `state.meta.coverJob` (`{running, total, done, found}`) albo `null`,
 * gdy zadanie nie trwa.
 */
export function coverJobProgress(job) {
  if (!job || !job.running) return null;
  const total = Math.max(0, Number(job.total) || 0);
  const done = Math.min(total, Math.max(0, Number(job.done) || 0));
  const found = Math.max(0, Number(job.found) || 0);
  return {
    total,
    done,
    found,
    fraction: total ? done / total : 0,
    text: total ? `Sprawdzono ${done} z ${total}` : 'Przygotowuję…',
    foundText: found ? `Znaleziono: ${found}` : '',
  };
}

/** Komunikat po zakończeniu pobierania okładek. */
export function coverJobResultMessage(found) {
  const n = Math.max(0, Number(found) || 0);
  if (!n) return 'Nie znaleziono nowych okładek.';
  return `Pobrano ${n} ${plural(n, ['okładkę', 'okładki', 'okładek'])}.`;
}

/** Komunikat po zleceniu pobierania okładek (`{started, total}` z serwera). */
export function coverJobStartMessage(result, alreadyRunning) {
  const total = Number(result?.total) || 0;
  if (result?.started && total > 0) {
    return `Szukam okładek – ${total} ${plural(total, ['książka', 'książki', 'książek'])} bez okładki.`;
  }
  if (alreadyRunning || (!result?.started && total > 0)) return 'Okładki są już pobierane.';
  return 'Wszystkie książki z numerem ISBN mają już okładki.';
}

// ---------------------------------------------------------------------------
// Status „mam / nie mam”: zapisy jeden po drugim
// ---------------------------------------------------------------------------

/**
 * Kolejka zapisów statusu książki. `save(value)` → Promise z wynikiem `mutate` (`undefined` = błąd).
 * Wybór w trakcie zapisu nie jest gubiony: zostaje zapamiętany i zapisany po bieżącym – liczy się
 * ostatni (przełącznik w szczegółach książki: dwie strzałki szybko po sobie). Po błędzie zapamiętany
 * wybór przepada (ekran wraca do stanu z serwera).
 * `request(value)` zwraca `{target, result}` po ostatnim zapisie serii albo `undefined`, gdy wybór
 * tylko dołączył do trwającego zapisu. `busy` – czy zapis trwa.
 */
export function createOwnedQueue(save) {
  let busy = false;
  let wanted = null;
  return {
    get busy() {
      return busy;
    },
    async request(value) {
      if (busy) {
        wanted = value;
        return undefined;
      }
      busy = true;
      let target = value;
      let result;
      try {
        for (;;) {
          result = await save(target);
          const next = wanted;
          wanted = null;
          if (result === undefined || next === null || next === target) break;
          target = next;
        }
      } finally {
        busy = false;
        wanted = null;
      }
      return { target, result };
    },
  };
}
