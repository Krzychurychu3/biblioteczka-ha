// Czysta logika edytorów (bez DOM i bez Preacta – testowana w node):
// podpowiedzi, wykrywanie duplikatów, automatyczny numer tomu, nakładanie danych z katalogów
// na formularz książki, walidacja ISBN i filtr odczytów skanera.
//
// `lib` to obiekt biblioteczki ze store.js (wystarczą pola `authors`, `series`, `books`,
// `authorsById`, `seriesById`, `booksById`). Formularz książki to zwykły obiekt:
//   {title, authorName, seriesName, volume, volumeSource, isOwned, notes, isbnText, publisher,
//    year, pageCount, coverId, adoptedId, adoptedTitle}
// `volume`, `year`, `pageCount`: 0 = brak. `volumeSource`: 'none' (pusto), 'auto' (numer
// podpowiedziany przez formularz), 'data' (z danych: książka, katalog, podpowiedź), 'user' (wpisany).

import {
  cleanedName,
  clusters,
  compareLocalized,
  looseKey,
  matchRank,
  nameKey,
  searchKey,
  wordsKey,
} from '../core/text.js';
import { classifyBarcode, parseISBN } from '../core/isbn.js';
// Jedna reguła biernika w aplikacji (ta sama co w menu wiersza serii, screens/logic.js).
import { countAccusative } from '../core/polish.js';

/** Najwięcej podpowiedzi pod polem (jak w iOS). */
export const SUGGESTION_LIMIT = 5;
/** Najwięcej „podobnych autorów” w edytorze autora. */
export const SIMILAR_AUTHORS_LIMIT = 3;

// Zakresy liczb (§9.7): spoza zakresu = brak wartości.
export const VOLUME_RANGE = [1, 999];
export const YEAR_RANGE = [1000, 2100];
export const PAGES_RANGE = [1, 9999];

// ---------------------------------------------------------------------------
// Drobne narzędzia
// ---------------------------------------------------------------------------

function inRange(value, [min, max]) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 0;
  const n = typeof value === 'number' ? value : /^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : 0;
}

/** Numer tomu 1…999, inaczej 0 (brak). */
export const clampVolume = (value) => inRange(value, VOLUME_RANGE);
/** Rok wydania 1000…2100, inaczej 0 (brak). */
export const clampYear = (value) => inRange(value, YEAR_RANGE);
/** Liczba stron 1…9999, inaczej 0 (brak). */
export const clampPages = (value) => inRange(value, PAGES_RANGE);

const isBlank = (s) => cleanedName(s) === '';

function byName(items, key = 'name') {
  return [...(items || [])].sort(
    (a, b) => compareLocalized(String(a?.[key] ?? ''), String(b?.[key] ?? '')) || (a?.id ?? 0) - (b?.id ?? 0),
  );
}

function byId(items) {
  return [...(items || [])].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0));
}

function authorName(lib, authorId) {
  if (authorId === null || authorId === undefined) return null;
  return lib.authorsById?.get(authorId)?.name ?? null;
}

function seriesName(lib, seriesId) {
  if (seriesId === null || seriesId === undefined) return null;
  return lib.seriesById?.get(seriesId)?.name ?? null;
}

function createdTime(item) {
  const t = Date.parse(item?.createdAt ?? '');
  return Number.isFinite(t) ? t : 0;
}

// Pamięć posortowanych list dla tej samej biblioteczki (obiekt lib zmienia się przy każdym odświeżeniu).
const sortedCache = new WeakMap();

function sortedFor(lib, name, compute) {
  if (!lib || typeof lib !== 'object') return compute();
  let cache = sortedCache.get(lib);
  if (!cache) {
    cache = {};
    sortedCache.set(lib, cache);
  }
  if (!(name in cache)) cache[name] = compute();
  return cache[name];
}

const authorsByName = (lib) => sortedFor(lib, 'authorsByName', () => byName(lib.authors));
const seriesByName = (lib) => sortedFor(lib, 'seriesByName', () => byName(lib.series));
const booksById = (lib) => sortedFor(lib, 'booksById', () => byId(lib.books));

/** Etykieta postępu serii: „brak tomów”, „3/5” albo „3/?” (gdy liczba tomów jest nieznana). */
export function progressLabel(series) {
  const progress = series?.progress || {};
  if (typeof progress.label === 'string' && progress.label) return progress.label;
  const total = Number(progress.total) || 0;
  const owned = Number(progress.owned) || 0;
  if (total === 0) return 'brak tomów';
  const known = progress.isTotalKnown ?? (series?.plannedVolumeCount !== null && series?.plannedVolumeCount !== undefined);
  return known ? `${owned}/${total}` : `${owned}/?`;
}

/** Liczba wszystkich książek serii (także „nie mam”). */
export function seriesBookCount(lib, series) {
  if (!series) return 0;
  if (Number.isInteger(series.bookCount)) return series.bookCount;
  return (lib.books || []).filter((b) => b.seriesId === series.id).length;
}

/**
 * Przyciski dialogu „Usunąć serię?” w edytorze serii: `[{label, role, withBooks}]`.
 * Liczba książek w bierniku („Usuń serię i 1 książkę”) – tak samo jak w menu wiersza serii
 * (screens/logic.js `seriesDeletion`); iOS ma tu mianownik („1 książka”).
 */
export function seriesDeleteActions(bookCount) {
  return bookCount > 0
    ? [
        { label: `Usuń serię i ${countAccusative(bookCount, 'book')}`, role: 'destructive', withBooks: true },
        { label: 'Usuń tylko serię', role: 'destructive', withBooks: false },
      ]
    : [{ label: 'Usuń serię', role: 'destructive', withBooks: false }];
}

// ---------------------------------------------------------------------------
// Dopasowania nazw
// ---------------------------------------------------------------------------

/** Autor o tej samej nazwie (`nameKey`), pierwszy według nazwy; pusto → null. */
export function findMatchingAuthor(lib, name, { excludingId = null } = {}) {
  const key = nameKey(name);
  if (!key) return null;
  return authorsByName(lib).find((a) => a.id !== excludingId && nameKey(a.name) === key) ?? null;
}

/** Seria o tej samej nazwie – najpierw seria wskazanego autora, inaczej pierwsza według nazwy. */
export function findMatchingSeries(lib, name, matchingAuthor) {
  const key = nameKey(name);
  if (!key) return null;
  const candidates = seriesByName(lib).filter((s) => nameKey(s.name) === key);
  if (matchingAuthor) {
    const own = candidates.find((s) => s.authorId === matchingAuthor.id);
    if (own) return own;
  }
  return candidates[0] ?? null;
}

/** Nazwa autora z bazy zapisanego nieco inaczej („J.K. Rowling” → „J. K. Rowling”), inaczej sama nazwa. */
export function existingAuthorName(lib, name) {
  const key = looseKey(name);
  if (!key) return name;
  return authorsByName(lib).find((a) => looseKey(a.name) === key)?.name ?? name;
}

// ---------------------------------------------------------------------------
// Podpowiedzi
// ---------------------------------------------------------------------------

/**
 * Podpowiedzi autorów: brak przy dokładnym dopasowaniu; inaczej pasujący autorzy według trafności,
 * potem liczby wszystkich książek (malejąco), nazwy i id; najwyżej 5. Puste pole – najpłodniejsi autorzy.
 */
export function authorSuggestions(lib, query, { limit = SUGGESTION_LIMIT } = {}) {
  if (findMatchingAuthor(lib, query)) return [];
  const ranked = [];
  for (const author of authorsByName(lib)) {
    const rank = matchRank(author.name, query);
    if (rank !== null) ranked.push({ author, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      (Number(b.author.bookCount) || 0) - (Number(a.author.bookCount) || 0) ||
      compareLocalized(a.author.name, b.author.name) ||
      a.author.id - b.author.id,
  );
  return ranked.slice(0, limit).map(({ author }) => ({
    id: author.id,
    kind: 'author',
    title: author.name,
    subtitle: author.summary || null,
    icon: 'person-fill',
  }));
}

/**
 * Podpowiedzi serii (także z katalogu): brak, gdy nazwa pasuje do istniejącej serii; serie innych
 * autorów niż dopasowany dostają +10 do rangi; potem najnowsze najpierw, nazwa, id; najwyżej 5.
 */
export function seriesSuggestions(lib, query, matchingAuthor, { limit = SUGGESTION_LIMIT } = {}) {
  if (findMatchingSeries(lib, query, matchingAuthor)) return [];
  const ranked = [];
  for (const series of seriesByName(lib)) {
    let rank = matchRank(series.name, query);
    if (rank === null) continue;
    if (matchingAuthor && series.authorId !== matchingAuthor.id) rank += 10;
    ranked.push({ series, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      createdTime(b.series) - createdTime(a.series) ||
      compareLocalized(a.series.name, b.series.name) ||
      a.series.id - b.series.id,
  );
  return ranked.slice(0, limit).map(({ series }) => ({
    id: series.id,
    kind: 'series',
    title: series.name,
    subtitle: `${series.authorLine || 'Autor nieznany'} · ${progressLabel(series)}`,
    icon: 'books-fill',
  }));
}

/**
 * Podpowiedzi tytułów: tylko w nowej książce, bez przejętego wpisu i od 2 znaków; pozycje „nie mam”
 * (katalog, brakujące tomy) według trafności, potem tytułu; najwyżej 5.
 */
export function titleSuggestions(lib, title, { isNew = true, adoptedId = null, limit = SUGGESTION_LIMIT } = {}) {
  if (!isNew || adoptedId !== null) return [];
  if (clusters(cleanedName(title)).length < 2) return [];
  const ranked = [];
  for (const book of lib.books || []) {
    if (book.isOwned) continue;
    const rank = matchRank(book.title, title);
    if (rank !== null) ranked.push({ book, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || compareLocalized(a.book.title, b.book.title) || a.book.id - b.book.id);
  return ranked.slice(0, limit).map(({ book }) => ({
    id: book.id,
    kind: 'book',
    title: book.title,
    subtitle: book.suggestionSubtitle || null,
    icon: 'book-fill',
  }));
}

/**
 * „Podobni autorzy w bazie”: słowa (≥ 3 znaki) z `searchKey(name)` szukane jako podciąg w nazwach
 * innych autorów (według nazwy, bez edytowanego); pierwsi 3. Bez dokładnego dopasowania.
 */
export function similarAuthors(lib, name, { excludingId = null, limit = SIMILAR_AUTHORS_LIMIT } = {}) {
  if (findMatchingAuthor(lib, name, { excludingId })) return [];
  const words = searchKey(name)
    .split(' ')
    .filter((w) => clusters(w).length >= 3);
  if (!words.length) return [];
  const result = [];
  for (const author of authorsByName(lib)) {
    if (author.id === excludingId) continue;
    const key = searchKey(author.name);
    if (words.some((w) => key.includes(w))) result.push(author);
    if (result.length >= limit) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Duplikaty
// ---------------------------------------------------------------------------

/**
 * Ta sama książka już w bazie: pierwsza (wg id) inna niż edytowana i przejęta, o tym samym tytule
 * (`nameKey`) i zgodnym autorze (pusty autor w formularzu lub książce pasuje do każdego).
 */
export function findDuplicateBook(lib, { title, authorName: author, editingId = null, adoptedId = null }) {
  const key = nameKey(title);
  if (!key) return null;
  const authorKey = nameKey(author);
  return (
    booksById(lib).find((other) => {
      if (other.id === editingId || other.id === adoptedId || nameKey(other.title) !== key) return false;
      const otherAuthor = authorName(lib, other.authorId);
      if (!authorKey || otherAuthor === null) return true;
      return nameKey(otherAuthor) === authorKey;
    }) ?? null
  );
}

/** Komunikat ostrzeżenia o duplikacie książki. */
export function duplicateBookMessage(duplicate) {
  if (!duplicate) return null;
  return duplicate.isOwned ? 'Masz już tę książkę w biblioteczce.' : 'Ta książka jest już w bazie jako „nie mam”.';
}

/**
 * Przycisk pod ostrzeżeniem o duplikacie (tylko nowa książka): `{markOwned, label, icon, disabled}` albo null.
 * - istniejąca „nie mam” → „Mam ją – oznacz istniejącą jako posiadaną”;
 * - istniejąca posiadana i formularz ma dane wydania → „Zapisz okładkę i dane wydania w mojej książce”.
 * Oba wysyłają dane wydania razem z okładką, więc są nieaktywne w czasie zapisu (`busy`)
 * i w czasie wysyłania okładki (`coverBusy`) – inaczej nowa okładka by przepadła.
 */
export function duplicateAction(duplicate, form, { isNew = true, busy = false, coverBusy = false } = {}) {
  if (!duplicate || !isNew) return null;
  const disabled = Boolean(busy || coverBusy);
  if (!duplicate.isOwned) {
    return { markOwned: true, label: 'Mam ją – oznacz istniejącą jako posiadaną', icon: 'check-circle', disabled };
  }
  if (!hasEditionInfo(form)) return null;
  return { markOwned: false, label: 'Zapisz okładkę i dane wydania w mojej książce', icon: 'download-fill', disabled };
}

/**
 * Seria o tej samej nazwie blokująca zapis: pierwsza inna (wg id), gdy pole autora jest puste,
 * tamta seria nie ma autora albo autor ma tę samą nazwę.
 */
export function findDuplicateSeries(lib, { name, authorName: author, editingId = null }) {
  const key = nameKey(name);
  if (!key) return null;
  const authorKey = nameKey(author);
  return (
    byId(lib.series).find((other) => {
      if (other.id === editingId || nameKey(other.name) !== key) return false;
      const otherAuthor = authorName(lib, other.authorId);
      if (!authorKey || otherAuthor === null) return true;
      return nameKey(otherAuthor) === authorKey;
    }) ?? null
  );
}

/** Komunikat o duplikacie serii. */
export function duplicateSeriesMessage(duplicate) {
  if (!duplicate) return null;
  return duplicate.isOnShelf
    ? 'Taka seria jest już w biblioteczce.'
    : 'Ta seria jest już w katalogu podpowiedzi. Dodaj książkę z tej serii, a seria pojawi się na liście.';
}

/**
 * Stan edytora autora: `exactMatch` (inny autor o tej samej nazwie), komunikat, czy można zapisać
 * i czy zapis połączy autorów.
 */
export function authorEditorState(lib, { name, editingId = null }) {
  const exactMatch = findMatchingAuthor(lib, name, { excludingId: editingId });
  const editing = editingId !== null;
  let message = null;
  if (exactMatch) {
    if (editing) message = `Autor „${exactMatch.name}” już istnieje – po zapisaniu oba wpisy zostaną połączone.`;
    else if (exactMatch.isOnShelf) message = 'Ten autor jest już w biblioteczce.';
    else message = 'Ten autor jest już w katalogu podpowiedzi – pojawi się na liście, gdy dodasz jego książkę.';
  }
  return {
    exactMatch,
    message,
    willMerge: Boolean(editing && exactMatch),
    canSave: !isBlank(name) && (editing || !exactMatch),
  };
}

// ---------------------------------------------------------------------------
// Dopasowanie danych z katalogów do bazy (iOS `apply(info)`)
// ---------------------------------------------------------------------------

/**
 * Książka z bazy o tym tytule i autorze (bez edytowanej): najpierw dokładnie (tytuł `nameKey`,
 * autor `looseKey` albo brak autora), potem – przy znanym autorze – wspólny początek tytułu
 * o co najmniej dwóch słowach („Bon czy ton” ~ „Bon czy ton. Savoir-vivre dla dzieci”).
 */
export function findLibraryBook(lib, title, author, { editingId = null } = {}) {
  const titleKey = nameKey(title);
  if (!titleKey) return null;
  const authorKey = looseKey(author);
  const candidates = booksById(lib).filter((b) => b.id !== editingId);
  const exact = candidates.find((other) => {
    if (nameKey(other.title) !== titleKey) return false;
    const otherAuthor = authorName(lib, other.authorId);
    if (!authorKey || otherAuthor === null) return true;
    return looseKey(otherAuthor) === authorKey;
  });
  if (exact) return exact;
  if (!authorKey) return null;
  const words = wordsKey(title);
  return (
    candidates.find((other) => {
      const otherAuthor = authorName(lib, other.authorId);
      if (otherAuthor === null || looseKey(otherAuthor) !== authorKey) return false;
      const otherWords = wordsKey(other.title);
      const shorter = clusters(words).length < clusters(otherWords).length ? words : otherWords;
      if (shorter.split(' ').filter(Boolean).length < 2) return false;
      return otherWords.startsWith(words + ' ') || words.startsWith(otherWords + ' ');
    }) ?? null
  );
}

/**
 * Seria dla znalezionej książki: (1) seria dopasowanego autora, której nazwa jest słowami w tytule,
 * (2) seria z katalogu, jeśli już jest w bazie (pisownia z bazy), (3) nowa – tylko pewny cykl.
 */
export function suggestedSeries(lib, info, title, matchingAuthor) {
  if (matchingAuthor) {
    const titleWords = ` ${wordsKey(title)} `;
    const own = seriesByName(lib).find((s) => {
      if (s.authorId !== matchingAuthor.id) return false;
      const words = wordsKey(s.name);
      return words !== '' && titleWords.includes(` ${words} `);
    });
    if (own) return own.name;
  }
  const name = info?.seriesName;
  if (!name) return null;
  const key = looseKey(name);
  const existing = key ? seriesByName(lib).find((s) => looseKey(s.name) === key) : null;
  if (existing) return existing.name;
  return info.isSeriesCertain ? name : null;
}

/**
 * Dane książki z katalogów po oczyszczeniu: puste teksty → null, liczby spoza zakresu → null (§9.5, §9.7).
 */
export function sanitizeInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const text = (value) => (typeof value === 'string' && cleanedName(value) !== '' ? cleanedName(value) : null);
  const number = (value, clamp) => clamp(value) || null;
  return {
    isbn: typeof info.isbn === 'string' ? info.isbn : null,
    title: text(info.title),
    authorName: text(info.authorName),
    seriesName: text(info.seriesName),
    isSeriesCertain: Boolean(info.isSeriesCertain),
    volumeNumber: number(info.volumeNumber, clampVolume),
    publisher: text(info.publisher),
    year: number(info.year ?? info.publicationYear, clampYear),
    pageCount: number(info.pageCount, clampPages),
    coverId: typeof info.coverId === 'string' && info.coverId ? info.coverId : null,
    sources: Array.isArray(info.sources) ? info.sources.filter((s) => typeof s === 'string') : [],
  };
}

/**
 * Lokalny odpowiednik `resolve_lookup` z serwera (dla formularza PO wpisaniu tytułu i autora z danych):
 * `{libraryBookId, libraryBookOwned, seriesName, volumeNumber}`.
 */
export function resolveLookupLocal(lib, form, info, { isNew = true, editingId = null } = {}) {
  const result = { libraryBookId: null, libraryBookOwned: null, seriesName: null, volumeNumber: null };
  const entry = isNew ? findLibraryBook(lib, form.title, form.authorName, { editingId }) : null;
  if (entry) {
    result.libraryBookId = entry.id;
    result.libraryBookOwned = Boolean(entry.isOwned);
    result.seriesName = seriesName(lib, entry.seriesId);
    result.volumeNumber = clampVolume(entry.volumeNumber) || null;
    return result;
  }
  if (isNew || isBlank(form.seriesName)) {
    const matching = findMatchingAuthor(lib, form.authorName);
    const name = suggestedSeries(lib, info, form.title, matching);
    if (name) {
      const key = nameKey(name);
      const existing = seriesByName(lib).find((s) => nameKey(s.name) === key);
      const volume = clampVolume(info?.volumeNumber) || (existing ? clampVolume(existing.suggestedVolumeNumber) : 0);
      result.seriesName = name;
      result.volumeNumber = volume || null;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Formularz książki
// ---------------------------------------------------------------------------

/**
 * Stan początkowy formularza (iOS BookEditorView.init).
 * `book` – edytowana książka; `authorId`, `seriesId`, `volumeNumber` – kontekst; `scannedIsbn` – cyfry.
 */
export function initialBookForm(lib, { book = null, authorId = null, seriesId = null, volumeNumber = null, scannedIsbn = null } = {}) {
  const contextAuthor = authorId !== null && authorId !== undefined ? lib.authorsById?.get(authorId) ?? null : null;
  const contextSeries = seriesId !== null && seriesId !== undefined ? lib.seriesById?.get(seriesId) ?? null : null;
  const author =
    (book && authorName(lib, book.authorId)) ??
    contextAuthor?.name ??
    (contextSeries ? authorName(lib, contextSeries.authorId) : null) ??
    '';
  const series = (book && seriesName(lib, book.seriesId)) ?? contextSeries?.name ?? '';
  let volume;
  if (book) volume = clampVolume(book.volumeNumber);
  else if (volumeNumber !== null && volumeNumber !== undefined) volume = clampVolume(volumeNumber);
  else if (contextSeries) volume = clampVolume(contextSeries.suggestedVolumeNumber);
  else volume = 0;
  const scanned = scannedIsbn ? parseISBN(String(scannedIsbn))?.digits ?? String(scannedIsbn) : '';
  return {
    title: book?.title ?? '',
    authorName: author,
    seriesName: series,
    volume,
    // Numer z danych (książka, kontekst serii) nie jest podmieniany automatycznie.
    volumeSource: book || series !== '' || volume > 0 ? 'data' : 'none',
    isOwned: book ? Boolean(book.isOwned) : true,
    notes: book?.notes ?? '',
    isbnText: book?.isbn ?? scanned,
    publisher: book?.publisher ?? '',
    year: clampYear(book?.publicationYear),
    pageCount: clampPages(book?.pageCount),
    coverId: book?.coverId ?? null,
    adoptedId: null,
    adoptedTitle: null,
  };
}

/** Seria i tom ustawione z danych (katalog, skan, podpowiedź) – bez automatycznej podmiany numeru. */
export function setSeries(form, name, volume) {
  return { ...form, seriesName: name ?? '', volume: clampVolume(volume), volumeSource: 'data' };
}

/**
 * Automatyczny numer tomu (§9.4), wywoływany ~300 ms po zmianie serii lub autora:
 * dopóki numer jest pusty albo podpowiedziany automatycznie, nazwa istniejącej serii daje jej
 * `suggestedVolumeNumber` (0 = brak), nowa nazwa – 1; wyczyszczenie serii czyści taki numer.
 * Numer z danych lub wpisany ręcznie zostaje; przy przejętym wpisie nic się nie zmienia.
 */
export function autoVolume(form, lib) {
  if (form.adoptedId !== null && form.adoptedId !== undefined) return form;
  if (isBlank(form.seriesName)) {
    if (form.volumeSource === 'auto' || (form.volume === 0 && form.volumeSource !== 'none')) {
      return { ...form, volume: 0, volumeSource: 'none' };
    }
    return form;
  }
  if (form.volumeSource !== 'none' && form.volumeSource !== 'auto') return form;
  const matching = findMatchingSeries(lib, form.seriesName, findMatchingAuthor(lib, form.authorName));
  const volume = matching ? clampVolume(matching.suggestedVolumeNumber) : 1;
  if (form.volume === volume && form.volumeSource === 'auto') return form;
  return { ...form, volume, volumeSource: 'auto' };
}

/** Numer tomu wpisany ręcznie (pole „Tom”). */
export function setVolumeByUser(form, volume) {
  return { ...form, volume: clampVolume(volume), volumeSource: 'user' };
}

/** Zmiana tytułu: inny `nameKey` niż przejęta pozycja → to już inna książka (koniec przejęcia). */
export function setTitle(form, title) {
  const next = { ...form, title };
  if (next.adoptedId !== null && next.adoptedId !== undefined && nameKey(title) !== nameKey(next.adoptedTitle)) {
    next.adoptedId = null;
    next.adoptedTitle = null;
  }
  return next;
}

/**
 * Przejęcie wpisu „nie mam” (podpowiedź tytułu, dopasowanie ISBN): tytuł, autor (wpisany zostaje,
 * gdy wpis go nie ma), seria i tom z wpisu, status „Mam”. Poprawka §9.1: formularz dostaje też
 * notatki, dane wydania i okładkę wpisu – wartości już wpisane przez użytkownika mają pierwszeństwo.
 */
export function adoptBook(form, book, lib) {
  let next = {
    ...form,
    adoptedId: book.id,
    adoptedTitle: book.title,
    title: book.title,
    authorName: authorName(lib, book.authorId) ?? form.authorName,
    isOwned: true,
  };
  next = setSeries(next, seriesName(lib, book.seriesId) ?? '', book.volumeNumber ?? 0);
  next.notes = String(form.notes ?? '').trim() ? form.notes : book.notes || '';
  next.isbnText = isBlank(form.isbnText) ? book.isbn || '' : form.isbnText;
  next.publisher = isBlank(form.publisher) ? book.publisher || '' : form.publisher;
  next.year = form.year > 0 ? form.year : clampYear(book.publicationYear);
  next.pageCount = form.pageCount > 0 ? form.pageCount : clampPages(book.pageCount);
  next.coverId = form.coverId ?? book.coverId ?? null;
  return next;
}

/** Puste dane wydania formularza uzupełnione z innego źródła (książka z bazy lub katalog). */
function fillEdition(form, { publisher, year, pageCount, coverId }) {
  const next = { ...form };
  if (isBlank(next.publisher) && publisher) next.publisher = publisher;
  if (!(next.year > 0) && clampYear(year)) next.year = clampYear(year);
  if (!(next.pageCount > 0) && clampPages(pageCount)) next.pageCount = clampPages(pageCount);
  if (!next.coverId && coverId) next.coverId = coverId;
  return next;
}

/**
 * Formularz z książki o tym samym ISBN (iOS `fill(from:)`): posiadana → jej tytuł, autor, seria i tom
 * (ostrzeżenie o duplikacie pojawi się samo); „nie mam” → przejęcie. Potem puste dane wydania.
 */
export function fillFromExisting(form, book, lib) {
  let next;
  if (book.isOwned) {
    next = setSeries(
      { ...form, title: book.title, authorName: authorName(lib, book.authorId) ?? '' },
      seriesName(lib, book.seriesId) ?? '',
      book.volumeNumber ?? 0,
    );
    next = dropStaleAdoption(next);
  } else {
    next = adoptBook(form, book, lib);
  }
  return fillEdition(next, {
    publisher: book.publisher,
    year: book.publicationYear,
    pageCount: book.pageCount,
    coverId: book.coverId,
  });
}

function dropStaleAdoption(form) {
  if (form.adoptedId !== null && form.adoptedId !== undefined && nameKey(form.title) !== nameKey(form.adoptedTitle)) {
    return { ...form, adoptedId: null, adoptedTitle: null };
  }
  return form;
}

/**
 * Pierwsza książka z bazy z tym numerem ISBN (wg id; pomija edytowaną). `extraIds` – identyfikatory
 * z odpowiedzi serwera (`resolution.isbnBookIds`), gdy lokalny stan jeszcze ich nie zna.
 */
export function findIsbnBook(lib, digits, { editingId = null, extraIds = [] } = {}) {
  if (!digits) return null;
  const local = booksById(lib).find((b) => b.id !== editingId && b.isbn === digits);
  if (local) return local;
  for (const id of extraIds || []) {
    const book = lib.booksById?.get(id);
    if (book && book.id !== editingId) return book;
  }
  return null;
}

/**
 * Nakłada dane znalezione w katalogach na formularz (iOS `apply(info)` z poprawkami §9.5, §9.7).
 * Nowa książka: tytuł i autor z danych; edycja: tylko puste pola. Potem książka z bazy (przejęcie
 * albo dane posiadanej) albo podpowiedziana seria; dane wydania i okładka tylko w puste pola.
 * `resolution` – wynik serwera (`resolve_lookup`); bez niego liczony lokalnie.
 */
export function applyLookup(form, rawInfo, { lib, isNew = true, editingId = null, resolution = null } = {}) {
  const info = sanitizeInfo(rawInfo);
  if (!info) return form;
  let next = { ...form };
  if (info.title && (isNew || isBlank(next.title))) next.title = info.title;
  if (info.authorName && (isNew || isBlank(next.authorName))) next.authorName = existingAuthorName(lib, info.authorName);

  const res = resolution && typeof resolution === 'object' ? resolution : resolveLookupLocal(lib, next, info, { isNew, editingId });
  const entry =
    isNew && res.libraryBookId !== null && res.libraryBookId !== undefined ? lib.booksById?.get(res.libraryBookId) ?? null : null;
  if (entry) {
    if (entry.isOwned) {
      next.title = entry.title;
      const name = authorName(lib, entry.authorId);
      if (name) next.authorName = name;
      next = setSeries(next, seriesName(lib, entry.seriesId) ?? '', entry.volumeNumber ?? 0);
    } else {
      next = adoptBook(next, entry, lib);
    }
  } else if ((isNew || isBlank(next.seriesName)) && res.seriesName) {
    next = setSeries(next, res.seriesName, res.volumeNumber ?? 0);
  }
  next = fillEdition(next, info);
  return dropStaleAdoption(next);
}

/** Czy formularz ma dane wydania, które można dopisać do istniejącej książki. */
export function hasEditionInfo(form) {
  return !isBlank(form.isbnText) || Boolean(form.coverId) || !isBlank(form.publisher) || form.year > 0 || form.pageCount > 0;
}

/** ISBN do zapisu: 13 cyfr, gdy poprawny; inaczej oczyszczony tekst albo null. */
export function normalizeIsbnText(text) {
  const parsed = parseISBN(text);
  if (parsed) return parsed.digits;
  return cleanedName(text) || null;
}

/** Dane wydania z formularza (zapis „tylko brakujące” – POST api/books/{id}/complete). */
export function buildEdition(form) {
  return {
    isbn: normalizeIsbnText(form.isbnText),
    publisher: cleanedName(form.publisher) || null,
    publicationYear: form.year > 0 ? form.year : null,
    pageCount: form.pageCount > 0 ? form.pageCount : null,
    coverId: form.coverId || null,
  };
}

/**
 * Szkic do zapisu (POST/PUT api/books). `targetCoverId` – okładka zapisywanego rekordu (edytowanego
 * albo przejętego); `hasTarget` – czy zapis trafia do istniejącego rekordu. Klucz `coverId` jest
 * wysyłany tylko przy zmianie okładki (null = usunięcie), więc cudza zmiana okładki nie ginie.
 */
export function buildBookDraft(form, { hasTarget = false, targetCoverId = null } = {}) {
  const series = cleanedName(form.seriesName);
  const edition = buildEdition(form);
  const draft = {
    title: cleanedName(form.title),
    authorName: cleanedName(form.authorName),
    seriesName: series,
    volumeNumber: series && form.volume > 0 ? form.volume : null,
    isOwned: Boolean(form.isOwned),
    notes: String(form.notes ?? '').trim(),
    isbn: edition.isbn,
    publisher: edition.publisher,
    publicationYear: edition.publicationYear,
    pageCount: edition.pageCount,
  };
  const cover = form.coverId || null;
  if (!hasTarget) {
    if (cover) draft.coverId = cover;
  } else if (cover !== (targetCoverId || null)) {
    draft.coverId = cover;
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Szukanie po ISBN – stan i strażnicy (§9.3)
// ---------------------------------------------------------------------------

/** Ostrzeżenie pod polem ISBN w edytorze (zapis i tak jest możliwy). */
export function isbnFieldWarning(text) {
  return !isBlank(text) && !parseISBN(text) ? 'Ten numer ISBN wygląda na niepoprawny – sprawdź cyfry.' : null;
}

/**
 * Czy wpisany numer można wyszukać (przycisk „Pobierz dane” i Enter): poprawny ISBN, nic nie trwa
 * i inny niż ostatnio wyszukany. Zwraca ISBN albo null.
 */
export function typedLookupTarget(isbnText, { searching = false, lastLookedUp = null } = {}) {
  const parsed = parseISBN(isbnText);
  if (!parsed || searching || parsed.digits === lastLookedUp) return null;
  return parsed;
}

/**
 * Co zrobić po nieudanym szukaniu po ISBN (wyjątek z `api.post('api/lookup')`): `{status, toast, forget}`.
 * - brak połączenia / przekroczony czas → 'offline' z przyciskiem „Spróbuj ponownie” (numer zostaje
 *   zapamiętany – ponawia go ten przycisk);
 * - przerwanie → 'idle' bez komunikatu;
 * - odmowa serwera (502/503 w czasie restartu, 500, 401…) → 'idle' z komunikatem błędu.
 * `forget` – zapomnij ostatnio szukany numer, żeby „Pobierz dane” i Enter znów działały dla tego
 * samego numeru (bez tego jedyną drogą byłoby ponowne skanowanie).
 */
export function lookupFailure(error) {
  if (error?.name === 'AbortError') return { status: 'idle', toast: null, forget: true };
  if (error?.isNetwork) return { status: 'offline', toast: null, forget: false };
  return { status: 'idle', toast: error?.message || 'Nie udało się wyszukać książki.', forget: true };
}

/** Wynik szukania jest nieaktualny, gdy numer w polu zmienił się w trakcie. */
export function isStaleLookup(isbnText, digits) {
  return parseISBN(isbnText)?.digits !== digits;
}

/** Komunikat stanu szukania: `{text, icon, tone}`; dla `searching` tekst bez ikony. */
export function lookupMessage(status, { isNew = true, sources = [] } = {}) {
  switch (status) {
    case 'searching':
      return { text: 'Szukam książki…', icon: null, tone: 'secondary' };
    case 'found':
      return { text: `Dane z: ${sources.join(', ')}`, icon: 'check-circle', tone: 'success' };
    case 'inLibrary':
      return { text: 'Ten numer ISBN jest już w Twojej bazie.', icon: 'books-fill', tone: 'secondary' };
    case 'notFound':
      return { text: 'Nie znalazłem tego numeru w katalogach. Uzupełnij dane ręcznie.', icon: 'question-circle', tone: 'warning' };
    case 'offline':
      return { text: 'Brak połączenia z internetem.', icon: 'wifi-slash', tone: 'warning' };
    default:
      return {
        text: isNew
          ? 'Zeskanuj kod z tyłu książki – uzupełnię tytuł, autora, serię i wydanie.'
          : 'Zeskanuj kod, żeby uzupełnić ISBN, wydanie i okładkę.',
        icon: null,
        tone: 'secondary',
      };
  }
}

// ---------------------------------------------------------------------------
// Ręczne wpisanie ISBN i skaner
// ---------------------------------------------------------------------------

/**
 * Pole „Numer ISBN” w skanerze: `{isbn, mistyped, footer}`. Ostrzeżenie, gdy cyfr ASCII i liter X
 * jest dokładnie 10 albo 13, a numer jest niepoprawny.
 */
export function manualIsbnState(text) {
  const isbn = parseISBN(text);
  const count = [...String(text ?? '')].filter((c) => (c >= '0' && c <= '9') || c === 'X' || c === 'x').length;
  const mistyped = (count === 10 || count === 13) && !isbn;
  return {
    isbn,
    mistyped,
    footer: mistyped
      ? 'Ten numer ma błąd – sprawdź cyfry.'
      : '10 albo 13 cyfr. Znajdziesz go nad kodem kreskowym albo na stronie redakcyjnej.',
  };
}

/** Podpowiedź skanera dla kodu, który nie jest książką. */
export function scanHint(kind) {
  if (kind === 'magazine') return 'To kod czasopisma, a nie książki';
  if (kind === 'other') return 'To nie jest kod książki';
  return null;
}

/**
 * Teksty skanera bez podglądu na żywo (`{icon, title, text}` wg trybu). Pod nimi zawsze jest sekcja
 * „Zdjęcie kodu” (zdjęcie rozpoznaje przeglądarka albo serwer) i ręczne wpisanie numeru, więc żaden
 * tekst nie może twierdzić, że skanować się nie da – w iOS nie było drogi przez zdjęcie.
 */
export const SCANNER_UNAVAILABLE = Object.freeze({
  insecure: Object.freeze({
    icon: 'camera-slash',
    title: 'Skanowanie na żywo wymaga HTTPS',
    text:
      'Podgląd z aparatu działa tylko wtedy, gdy Home Assistant jest otwarty przez bezpieczne połączenie HTTPS ' +
      '(np. Nabu Casa albo własny certyfikat). Teraz możesz zrobić zdjęcie kodu kreskowego – rozpoznam go ze zdjęcia – ' +
      'albo wpisać numer ISBN.',
  }),
  // Brak aparatu albo przeglądarka bez dostępu do niego (NotFoundError, brak getUserMedia…).
  unsupported: Object.freeze({
    icon: 'camera-slash',
    title: 'Aparat jest niedostępny',
    text:
      'Na tym urządzeniu nie da się skanować kodów na żywo. Wybierz zdjęcie kodu kreskowego – rozpoznam z niego ' +
      'numer ISBN – albo wpisz numer ISBN (jest nad kodem kreskowym albo na stronie redakcyjnej).',
  }),
  permission: Object.freeze({
    icon: 'camera-fill',
    title: 'Brak dostępu do aparatu',
    text:
      'Żeby skanować kody, pozwól Biblioteczce korzystać z aparatu: w ustawieniach przeglądarki (ikona obok adresu strony) ' +
      'albo aplikacji Home Assistant, a potem spróbuj ponownie. Do tego czasu możesz zrobić zdjęcie kodu albo wpisać numer ISBN.',
  }),
  busy: Object.freeze({
    icon: 'camera-fill',
    title: 'Brak dostępu do aparatu',
    text:
      'Aparat jest teraz zajęty albo zablokowany. Zamknij inne aplikacje, które z niego korzystają, i spróbuj ponownie. ' +
      'Do tego czasu możesz zrobić zdjęcie kodu albo wpisać numer ISBN.',
  }),
});

/**
 * Uwaga pod podglądem na żywo, gdy dekoder w przeglądarce nie ruszył. Ze zdjęcia kod da się wtedy
 * rozpoznać tylko na serwerze (`serverDecode` – meta `barcodeServerDecode`).
 */
export function detectorFailedNote(serverDecode) {
  return serverDecode
    ? 'Nie udało się uruchomić rozpoznawania kodów na żywo. Rozpoznaj kod ze zdjęcia albo wpisz numer ISBN ręcznie.'
    : 'Nie udało się uruchomić rozpoznawania kodów. Wpisz numer ISBN ręcznie.';
}

/**
 * Najlepszy kod z jednego odczytu (klatka filmu lub zdjęcie): kod książki ma pierwszeństwo,
 * inaczej pierwszy rozpoznany. Zwraca `{kind, isbn?, raw}` albo null.
 */
export function pickBarcode(values) {
  const list = (values || []).map((v) => (typeof v === 'string' ? v : v?.rawValue)).filter((v) => typeof v === 'string' && v);
  if (!list.length) return null;
  const classified = list.map((raw) => ({ ...classifyBarcode(raw), raw }));
  return classified.find((c) => c.kind === 'book') || classified[0];
}

/**
 * Filtr odczytów na żywo: kod liczy się po `confirmations` identycznych odczytach z rzędu i tylko
 * wtedy, gdy „pojawił się na nowo” – ten sam kod trzymany w kadrze nie powtarza komunikatu.
 * Kod musi zniknąć z kadru na `clearAfterEmpty` pustych klatek, żeby znów się liczyć.
 * `push(values)` zwraca wynik `pickBarcode` albo null.
 */
export function createScanFilter({ confirmations = 2, clearAfterEmpty = 3 } = {}) {
  let candidate = null;
  let count = 0;
  let handled = null;
  let empty = 0;
  return {
    push(values) {
      const pick = pickBarcode(values);
      if (!pick) {
        candidate = null;
        count = 0;
        empty += 1;
        if (empty >= clearAfterEmpty) handled = null;
        return null;
      }
      empty = 0;
      const key = pick.raw.replace(/[^0-9]/g, '') || pick.raw;
      if (key === candidate) count += 1;
      else {
        candidate = key;
        count = 1;
      }
      if (count < confirmations || key === handled) return null;
      handled = key;
      return pick;
    },
    reset() {
      candidate = null;
      count = 0;
      handled = null;
      empty = 0;
    },
  };
}

/**
 * Rodzaj błędu `getUserMedia`: 'permission' (brak zgody), 'unsupported' (brak aparatu)
 * albo 'busy' (zgoda jest, ale aparat nie ruszył – zajęty, zablokowany) – iOS „denied”.
 */
export function classifyCameraError(error) {
  const name = error && typeof error === 'object' ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'permission';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError' || name === 'TypeError') {
    return 'unsupported';
  }
  return 'busy';
}

/**
 * Wynik rozpoznania kodu przez serwer (`POST api/barcode`) jako `{kind, isbn?}`; numer jest
 * sprawdzany ponownie po stronie klienta. `none` – nic nie znaleziono albo dekoder niedostępny.
 */
export function serverBarcodeResult(response) {
  if (!response || typeof response !== 'object' || response.available === false) return { kind: 'none' };
  if (typeof response.isbn === 'string') {
    const classified = classifyBarcode(response.isbn);
    if (classified.kind === 'book') return { kind: 'book', isbn: classified.isbn, raw: response.isbn };
  }
  const codes = Array.isArray(response.codes) ? response.codes : [];
  const pick = pickBarcode(codes.map((c) => (typeof c === 'string' ? c : c?.text ?? c?.rawValue)));
  if (pick) return pick;
  if (response.kind === 'magazine' || response.kind === 'other') return { kind: response.kind };
  return { kind: 'none' };
}

/** Wymiary obrazu zmniejszonego tak, by dłuższy bok ≤ `max` (bez powiększania). */
export function fitWithin(width, height, max) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}
