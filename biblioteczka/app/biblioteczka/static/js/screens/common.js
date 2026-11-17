// Wspólne elementy ekranów: wiersze serii, autora i książki, akcje wierszy, dialogi usuwania.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { api, APP_VERSION } from '../api.js';
import { getLibrary, mutate } from '../store.js';
import {
  Avatar,
  CompleteBadge,
  Cover,
  Icon,
  ListRow,
  MissingBadge,
  ProgressBar,
  confirmDialog,
  getRoute,
  goBack,
  hrefFor,
  navigate,
  paneHeading,
  refocusIfLost,
  resetAnnouncement,
  selectEntry,
  usePane,
} from '../ui/index.js';
import { isSelectedEntry, pushRouteEntry, selectionRoute, topEntry } from '../ui/pure.js';
import { openBookEditor, openSeriesEditor, openAuthorEditor } from '../editors/index.js';
import { authorDeletion, bookDeletion, createOwnedQueue, seriesDeletion, seriesRowStatus } from './logic.js';

// ---------------------------------------------------------------------------
// Arkusz stylów ekranów (dołączany raz, przy pierwszym wczytaniu modułu)
// ---------------------------------------------------------------------------

const STYLE_ID = 'screens-css';

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  const version = APP_VERSION ? `?v=${encodeURIComponent(APP_VERSION)}` : '';
  link.href = new URL(`../../css/screens.css${version}`, import.meta.url).href;
  document.head.append(link);
}

// ---------------------------------------------------------------------------
// Nawigacja
// ---------------------------------------------------------------------------

/**
 * Link do ekranu szczegółów dołożonego na stos trasy `route` (trasy ekranu, a nie bieżącej –
 * ekrany kart w tle też mają poprawne adresy). Zwraca propsy `{href, onClick}` dla ListRow.
 */
export function entryLink(route, type, id) {
  const path = pushRouteEntry(route, { type, id }).path;
  return { href: hrefFor(path), onClick: () => navigate(path) };
}

/**
 * Link wiersza zależny od panelu. Lista w trybie dwóch paneli → wybór (selectEntry) i `selected`;
 * inaczej → ekran dokładany na stos trasy `route` (entryLink). Książka w wąskim układzie → null
 * (wiersz otwiera edytor, jak dotąd).
 * Zwraca `{href, onClick(event), selected}` albo `null`.
 */
export function useRowLink(route, type, id) {
  const pane = usePane();
  if (!route) return null;
  if (pane.pane === 'list' && pane.split) {
    const entry = { type, id: Number(id) };
    return {
      href: hrefFor(selectionRoute(route, entry).path),
      onClick: (event) => {
        // Enter na linku to „click” z detail 0: wybór i fokus na tytule szczegółów.
        const focusDetail = event?.detail === 0;
        if (focusDetail) resetAnnouncement();
        if (!selectEntry(entry, { focusDetail }) && focusDetail) paneHeading('detail')?.focus({ preventScroll: true });
      },
      selected: isSelectedEntry(pane.selected, type, id),
    };
  }
  if (type === 'book' && !pane.split) return null;
  return { ...entryLink(route, type, id), selected: false };
}

/**
 * Po usunięciu obiektu z jego własnego wiersza: cofa się, gdy na wierzchu stosu jest właśnie on.
 * Dwa panele: gdy fokus był na usuniętym wierszu (spadł na <body>), wraca na tytuł panelu.
 */
function leaveIfShowing(type, id) {
  const top = topEntry(getRoute());
  if (top && top.type === type && top.id === id) goBack();
  refocusIfLost();
}

// ---------------------------------------------------------------------------
// Operacje na danych
// ---------------------------------------------------------------------------

/** Zmiana statusu „mam / nie mam” (iOS toggleOwned: posiadana trafia na górę „Ostatnio dodanych”). */
export function setOwned(book, isOwned) {
  return mutate(() => api.post(`api/books/${book.id}/owned`, { isOwned }));
}

/**
 * Usunięcie książki – po potwierdzeniu, bo tej operacji nie da się cofnąć. `onDeleted` – po udanym
 * usunięciu; domyślnie powrót z ekranu tej książki, jeśli jest na wierzchu stosu.
 */
export async function confirmDeleteBook(book, { onDeleted } = {}) {
  const dialog = bookDeletion(book);
  const choice = await confirmDialog({
    title: dialog.title,
    message: dialog.message,
    actions: [{ label: dialog.label, role: 'destructive' }],
  });
  if (!choice) return;
  const result = await mutate(() => api.del(`api/books/${book.id}`));
  if (result !== undefined) (onDeleted || (() => leaveIfShowing('book', book.id)))();
}

/**
 * Dialog usuwania serii (z książkami albo bez). `onDeleted` – po udanym usunięciu; domyślnie powrót
 * z ekranu tej serii, jeśli jest na wierzchu stosu (np. wybranej na liście w trybie dwóch paneli).
 */
export async function confirmDeleteSeries(series, { onDeleted } = {}) {
  const lib = getLibrary();
  const bookCount = (lib.booksBySeries.get(series.id) || []).length;
  const dialog = seriesDeletion(series, bookCount);
  const choice = await confirmDialog({
    title: dialog.title,
    message: dialog.message,
    actions: dialog.options.map((option) => ({ label: option.label, role: 'destructive', withBooks: option.withBooks })),
  });
  if (!choice) return;
  const result = await mutate(() => api.del(`api/series/${series.id}?withBooks=${choice.withBooks ? 1 : 0}`));
  if (result !== undefined) (onDeleted || (() => leaveIfShowing('series', series.id)))();
}

/** Dialog usuwania autora (z książkami i jego seriami albo tylko autora); `onDeleted` jak wyżej. */
export async function confirmDeleteAuthor(author, { onDeleted } = {}) {
  const lib = getLibrary();
  const bookCount = (lib.booksByAuthor.get(author.id) || []).length;
  const seriesCount = (lib.seriesByAuthor.get(author.id) || []).length;
  const dialog = authorDeletion(author, bookCount, seriesCount);
  const choice = await confirmDialog({
    title: dialog.title,
    message: dialog.message,
    actions: dialog.options.map((option) => ({ label: option.label, role: 'destructive', withBooks: option.withBooks })),
  });
  if (!choice) return;
  const result = await mutate(() => api.del(`api/authors/${author.id}?withBooks=${choice.withBooks ? 1 : 0}`));
  if (result !== undefined) (onDeleted || (() => leaveIfShowing('author', author.id)))();
}

/**
 * Hook przełącznika „mam”: od razu pokazuje nowy stan (bez czekania na serwer),
 * wraca do stanu z serwera po błędzie. Zwraca `[owned, toggle, set]`.
 * `toggle()` (wiersze: przycisk, przesunięcie, menu) – kolejne stuknięcia w trakcie zapisu są pomijane.
 * `set(value)` (przełącznik „Mam / Brakuje mi” w szczegółach książki) – wybór w trakcie zapisu
 * od razu widać i zostaje zapisany po bieżącym (liczy się ostatni), więc zaznaczona opcja zawsze
 * zgadza się z wyborem użytkownika.
 */
export function useOwnedToggle(book) {
  const [pending, setPending] = useState(null);
  const bookRef = useRef(book);
  bookRef.current = book;
  const queue = useRef(null);
  if (!queue.current) queue.current = createOwnedQueue((value) => setOwned(bookRef.current, value));
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  // Nowy snapshot z serwera zastępuje przewidywany stan (gdy zapis już się zakończył).
  useEffect(() => {
    if (!queue.current.busy && pending !== null) setPending(null);
  }, [book]);
  const owned = pending ?? book.isOwned;
  const save = async (target) => {
    setPending(target);
    const outcome = await queue.current.request(target);
    // Wybór dołączony do trwającego zapisu – stan ustawi pierwszy z serii.
    if (!outcome || !alive.current) return;
    if (outcome.result === undefined) setPending(null);
    else if (getLibrary().booksById.get(book.id)?.isOwned === outcome.target) setPending(null);
  };
  const toggle = () => {
    if (!queue.current.busy) save(!owned);
  };
  const set = (value) => {
    if (value !== owned) save(value);
  };
  return [owned, toggle, set];
}

// ---------------------------------------------------------------------------
// Akcje wierszy (odpowiedniki swipe actions i menu kontekstowych iOS)
// ---------------------------------------------------------------------------

/**
 * Akcje wiersza książki: w prawo „Nie mam”/„Mam” (pełne przesunięcie wykonuje),
 * w lewo „Usuń”; w menu także „Edytuj”.
 */
export function bookActions(book, { owned = book.isOwned, onToggle } = {}) {
  const toggle = onToggle || (() => setOwned(book, !owned));
  return [
    { label: 'Edytuj', icon: 'pencil', onClick: () => openBookEditor({ bookId: book.id }) },
    {
      label: owned ? 'Nie mam' : 'Mam',
      subtitle: owned ? 'Oznacz jako brakującą' : 'Oznacz jako posiadaną',
      icon: owned ? 'minus-circle' : 'check',
      swipe: 'leading',
      fullSwipe: true,
      tint: owned ? 'orange' : 'green',
      onClick: toggle,
    },
    { divider: true },
    { label: 'Usuń', icon: 'trash', role: 'destructive', swipe: 'trailing', onClick: () => confirmDeleteBook(book) },
  ];
}

/** Akcje wiersza serii na karcie „Serie”. */
export function seriesActions(series) {
  return [
    {
      label: 'Dodaj tom',
      icon: 'plus',
      // Numer tomu (suggestedVolumeNumber) podstawia edytor na podstawie serii.
      onClick: () => openBookEditor({ seriesId: series.id }),
    },
    {
      label: 'Edytuj serię',
      icon: 'pencil',
      swipe: 'trailing',
      tint: 'indigo',
      onClick: () => openSeriesEditor({ seriesId: series.id }),
    },
    { divider: true },
    {
      label: 'Usuń serię',
      icon: 'trash',
      role: 'destructive',
      swipe: 'trailing',
      onClick: () => confirmDeleteSeries(series),
    },
  ];
}

/** Akcje wiersza autora na karcie „Autorzy”. */
export function authorActions(author) {
  return [
    {
      label: 'Edytuj autora',
      icon: 'pencil',
      swipe: 'trailing',
      tint: 'indigo',
      onClick: () => openAuthorEditor({ authorId: author.id }),
    },
    { divider: true },
    {
      label: 'Usuń autora',
      icon: 'trash',
      role: 'destructive',
      swipe: 'trailing',
      onClick: () => confirmDeleteAuthor(author),
    },
  ];
}

// ---------------------------------------------------------------------------
// Wiersze
// ---------------------------------------------------------------------------

/** Wiersz serii (SeriesRow): stosik okładek, nazwa, autor, postęp. */
export function SeriesRow({ series, route, actions }) {
  const progress = series.progress || {};
  const status = seriesRowStatus(series);
  const link = useRowLink(route, 'series', series.id);
  const detail =
    status.kind === 'progress'
      ? html`<span class="progress-row series-row-progress">
          <${ProgressBar} fraction=${progress.fraction} complete=${progress.isComplete} seed=${series.name} />
          <span class="progress-label">${status.label}</span>
        </span>`
      : html`<span class="row-detail-text series-row-status">${status.text}</span>`;
  return html`<${ListRow}
    className="series-row"
    href=${link.href}
    onClick=${link.onClick}
    selected=${link.selected}
    chevron
    leading=${html`<${Cover}
      title=${series.name}
      coverId=${series.coverId}
      size="m"
      stack
      badge=${progress.isComplete ? CompleteBadge() : null}
    />`}
    title=${series.name}
    subtitle=${series.authorLine}
    detail=${detail}
    actions=${actions}
    actionsLabel=${`Akcje serii „${series.name}”`}
  />`;
}

/** Wiersz autora (AuthorRow): awatar, imię i nazwisko, co jest na półce. */
export function AuthorRow({ author, route, avatarSize = 42, actions }) {
  const link = useRowLink(route, 'author', author.id);
  return html`<${ListRow}
    className="author-row"
    href=${link.href}
    onClick=${link.onClick}
    selected=${link.selected}
    chevron
    leading=${html`<${Avatar} name=${author.name} size=${avatarSize} />`}
    title=${author.name}
    subtitle=${author.ownedSummary}
    actions=${actions}
    actionsLabel=${`Akcje autora „${author.name}”`}
  />`;
}

/**
 * Wiersz książki (BookRow): okładka, tytuł, autor, seria i znacznik „Brakuje”. W wąskim układzie
 * otwiera edytor; w trybie dwóch paneli wybiera książkę (lista) albo otwiera jej szczegóły (`route`).
 */
export function BookRow({ book, lib, route }) {
  const link = useRowLink(route, 'book', book.id);
  const author = book.authorId != null ? lib.authorsById.get(book.authorId) : null;
  const showDetail = book.seriesId != null || !book.isOwned;
  const detail = showDetail
    ? html`${book.seriesLine &&
        html`<span class="book-row-series">${Icon('books')}<span class="row-detail-text">${book.seriesLine}</span></span>`}
      ${!book.isOwned && html`<${MissingBadge} />`}`
    : null;
  return html`<${ListRow}
    className="book-row"
    href=${link ? link.href : undefined}
    onClick=${link ? link.onClick : () => openBookEditor({ bookId: book.id })}
    selected=${link ? link.selected : false}
    chevron=${Boolean(link)}
    dimmed=${!book.isOwned}
    leading=${html`<${Cover}
      title=${book.title}
      seed=${book.coverSeed}
      label=${book.coverLabel}
      coverId=${book.coverId}
      size="s"
      dimmed=${!book.isOwned}
    />`}
    title=${book.title}
    subtitle=${author ? author.name : 'Autor nieznany'}
    detail=${detail}
    actions=${bookActions(book)}
    actionsLabel=${`Akcje książki „${book.title}”`}
  />`;
}
