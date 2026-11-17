// Szczegóły autora: podsumowanie, jego serie, pojedyncze tytuły i książki w innych seriach.

import { html } from '../../vendor/preact-htm.js';
import { useLibrary } from '../store.js';
import {
  Avatar,
  EmptyState,
  Icon,
  ListButton,
  ListSection,
  Menu,
  ToolbarButton,
  getRoute,
  goBack,
  useChrome,
} from '../ui/index.js';
import { openAuthorEditor, openBookEditor } from '../editors/index.js';
import { AddMenuItems } from './menus.js';
import { BookRow, SeriesRow } from './common.js';
import { authorSections } from './logic.js';

function AuthorHeader({ author, missing }) {
  return html`<${ListSection} plain label="Podsumowanie autora" className="detail-header">
    <div class="card card-header author-header">
      <${Avatar} name=${author.name} size=${64} />
      <div class="author-header-body">
        <p class="author-header-summary">${author.ownedSummary}</p>
        <p class="author-header-stats">
          <span class="text-indigo">${Icon('books-fill')}${author.ownedBookCount ?? 0} na półce</span>
          ${missing > 0 && html`<span class="text-orange">${Icon('cart-fill')}${missing} brakuje</span>`}
        </p>
      </div>
    </div>
  <//>`;
}

export function AuthorDetailScreen({ id, route }) {
  const lib = useLibrary();
  const author = lib.authorsById.get(id);
  // Po usunięciu albo połączeniu autora w edytorze wracamy z jego ekranu.
  const onDelete = () => {
    if (getRoute().path === route.path) goBack();
  };

  useChrome(
    author
      ? {
          trailing: html`<${ToolbarButton}
              icon="pencil"
              label="Edytuj autora"
              onClick=${() => openAuthorEditor({ authorId: id, onDelete })}
            />
            <${Menu} label="Dodaj" trigger=${Icon('plus')} items=${() => AddMenuItems({ authorId: id })} align="end" />`,
        }
      : { trailing: null },
  );

  if (!author) {
    return html`<${EmptyState} icon="trash" title="Autor został usunięty" />`;
  }

  const sections = authorSections(lib, id);
  const nothing = !sections.series.length && !sections.standalone.length && !sections.otherSeries.length;

  return html`<div class="screen author-detail">
    <${AuthorHeader} author=${author} missing=${sections.missing} />
    ${sections.series.length > 0 &&
    html`<${ListSection} header="Serie">
      ${sections.series.map((series) => html`<${SeriesRow} key=${series.id} series=${series} route=${route} />`)}
    <//>`}
    ${(nothing || sections.standalone.length > 0) &&
    html`<${ListSection} header=${sections.standalone.length ? 'Pojedyncze tytuły' : undefined} label="Książki">
      ${nothing &&
      html`<${ListButton}
        icon="plus-circle"
        label="Dodaj pierwszą książkę"
        onClick=${() => openBookEditor({ authorId: id })}
      />`}
      ${sections.standalone.map((book) => html`<${BookRow} key=${book.id} book=${book} lib=${lib} route=${route} />`)}
    <//>`}
    ${sections.otherSeries.length > 0 &&
    html`<${ListSection} header="W innych seriach">
      ${sections.otherSeries.map((book) => html`<${BookRow} key=${book.id} book=${book} lib=${lib} route=${route} />`)}
    <//>`}
  </div>`;
}
