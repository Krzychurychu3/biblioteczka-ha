// Szczegóły książki (tylko do odczytu): okładka, autor, seria i tom, status „Mam / Brakuje mi”,
// dane wydania, notatki i usuwanie. Edycja – w arkuszu edytora (ołówek na pasku).
//
// Ekran działa tak samo w prawym panelu widoku na komputerze i jako zwykły ekran na stosie
// (wąskie okno, adres `#/ksiazki/ksiazka/12`) – nie zależy od układu. Tytuł (duży i w pasku)
// app.js bierze z tytułu książki. Wygląd: css/book-detail.css (dołączany w index.html).

import { html } from '../../vendor/preact-htm.js';
import { useLibrary } from '../store.js';
import {
  Cover,
  EmptyState,
  ListButton,
  ListCell,
  ListSection,
  Segmented,
  ToolbarButton,
  useChrome,
} from '../ui/index.js';
import { openBookEditor } from '../editors/index.js';
import { confirmDeleteBook, entryLink, useOwnedToggle } from './common.js';
import {
  STATUS_OPTIONS,
  TEXT,
  addedCaption,
  bookNotes,
  ownedNote,
  seriesVolumeText,
  visibleEditionRows,
} from './book-detail-logic.js';

/** Szerokość okładki w nagłówku (px); wysokość wynika z proporcji okładki. */
const COVER_WIDTH = 120;

/**
 * Link do autora albo serii – dokłada ekran na stos trasy tego ekranu (w obu układach).
 * Kliknięcie z klawiszem modyfikującym albo środkowym przyciskiem zostawiamy przeglądarce.
 */
function DetailLink({ route, type, id, prefix, children }) {
  const link = entryLink(route, type, id);
  const onClick = (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault();
    link.onClick();
  };
  return html`<a class="book-detail-link" href=${link.href} onClick=${onClick}>
    <span class="visually-hidden">${prefix}</span>${children}
  </a>`;
}

function EditionSection({ book }) {
  const rows = visibleEditionRows(book);
  return html`<${ListSection} header=${TEXT.edition}>
    ${rows.length
      ? html`<dl class="book-detail-facts">
          ${rows.map(
            (row) => html`<div class="cell book-detail-fact" key=${row.key}>
              <dt class="book-detail-fact-label">${row.label}</dt>
              <dd class=${`book-detail-fact-value ${row.mono ? 'font-mono' : ''}`} translate=${row.mono ? 'no' : undefined}>
                ${row.value}
              </dd>
            </div>`,
          )}
        </dl>`
      : html`<${ListCell} className="book-detail-missing">${TEXT.noEdition}<//>`}
  <//>`;
}

/** Treść ekranu – tylko dla istniejącej książki (useOwnedToggle czyta `book.isOwned`). */
function BookDetail({ book, route, lib }) {
  const [owned, , setOwnedStatus] = useOwnedToggle(book);
  const author = book.authorId != null ? lib.authorsById.get(book.authorId) : null;
  const series = book.seriesId != null ? lib.seriesById.get(book.seriesId) : null;
  const volume = series ? seriesVolumeText(book) : '';
  const notes = bookNotes(book);
  // Data z serwera opisuje zapisany stan: przy „Mam” jeszcze w trakcie zapisu stara data byłaby myląca.
  const added = addedCaption(book.addedAt, owned && book.isOwned);

  return html`<div class="screen book-detail">
    <${ListSection} plain label=${TEXT.summary} className="detail-header">
      <div class="card card-header book-detail-header">
        <${Cover}
          title=${book.title}
          seed=${book.coverSeed}
          label=${book.coverLabel ?? undefined}
          coverId=${book.coverId}
          width=${COVER_WIDTH}
          dimmed=${!owned}
          className="book-detail-cover"
        />
        <div class="book-detail-summary">
          <p class="book-detail-author">
            ${author
              ? html`<${DetailLink} route=${route} type="author" id=${author.id} prefix=${TEXT.authorPrefix}>
                  ${author.name}
                <//>`
              : html`<span class="book-detail-unknown">${TEXT.unknownAuthor}</span>`}
          </p>
          ${series &&
          html`<p class="book-detail-series">
            <${DetailLink} route=${route} type="series" id=${series.id} prefix=${TEXT.seriesPrefix}>${series.name}<//>
            ${volume &&
            // Kropka środkowa tylko dla oka; czytnik ekranu słyszy „Seria: Wiedźmin, tom 3”.
            html`<span class="book-detail-volume"><span aria-hidden="true"> · </span><span class="visually-hidden">, </span>${volume}</span>`}
          </p>`}
          <div class="book-detail-status">
            <${Segmented}
              label=${TEXT.status}
              options=${STATUS_OPTIONS}
              value=${owned}
              onChange=${setOwnedStatus}
            />
          </div>
          <p class="book-detail-status-note">${ownedNote(owned, Boolean(series))}</p>
          ${added && html`<p class="book-detail-added">${added}</p>`}
        </div>
      </div>
    <//>
    <${EditionSection} book=${book} />
    ${notes &&
    html`<${ListSection} header=${TEXT.notes}>
      <${ListCell}>${notes}<//>
    <//>`}
    <${ListSection} label=${TEXT.removal}>
      <${ListButton} label=${TEXT.remove} role="destructive" align="center" onClick=${() => confirmDeleteBook(book)} />
    <//>
  </div>`;
}

/** Ekran szczegółów książki `{type: 'book', id}` (kontrakt tras w app.js). */
export function BookDetailScreen({ id, route }) {
  const lib = useLibrary();
  const book = lib.booksById.get(id);

  // Hooki przed wczesnym powrotem: liczba hooków nie może zależeć od tego, czy książka istnieje.
  useChrome(
    book
      ? {
          trailing: html`<${ToolbarButton}
            icon="pencil"
            label=${TEXT.edit}
            onClick=${() => openBookEditor({ bookId: id })}
          />`,
        }
      : { trailing: null },
  );

  if (!book) {
    return html`<${EmptyState} icon="trash" title=${TEXT.deleted} />`;
  }
  return html`<${BookDetail} book=${book} route=${route} lib=${lib} />`;
}
