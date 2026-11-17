// Karta „Szukaj”: autorzy, serie i tytuły z półki (bez wielkości liter i polskich znaków);
// przy pustym zapytaniu – ostatnio dodane książki.

import { html, useMemo } from '../../vendor/preact-htm.js';
import { ownedBooks, useLibrary, visibleAuthors, visibleSeries } from '../store.js';
import { EmptyState, ListSection, SearchField, useRetainedState } from '../ui/index.js';
import { AuthorRow, BookRow, SeriesRow } from './common.js';
import { isQueryEmpty, queryForDisplay, recentBooks, searchLibrary } from './logic.js';

/** Krótki komunikat dla czytników ekranu (zamiast odczytywania całej listy przy każdej literze). */
function announcement(empty, results) {
  if (empty || !results) return '';
  if (results.isEmpty) return 'Brak wyników';
  return `Znaleziono: ${results.authors.length + results.series.length + results.books.length}`;
}

export function SearchScreen({ route }) {
  const lib = useLibrary();
  // Zapytanie zostaje po powrocie z otwartej serii albo autora (jak @State w iOS SearchView).
  const [query, setQuery] = useRetainedState('szukaj.query', '');
  const empty = isQueryEmpty(query);

  const owned = ownedBooks(lib);
  const recent = useMemo(() => (empty ? recentBooks(owned) : []), [empty, owned]);
  const results = useMemo(
    () => (empty ? null : searchLibrary({ authors: visibleAuthors(lib), series: visibleSeries(lib), books: owned }, query)),
    [empty, lib, owned, query],
  );

  let content;
  if (empty) {
    content = recent.length
      ? html`<${ListSection} header="Ostatnio dodane">
          ${recent.map((book) => html`<${BookRow} key=${book.id} book=${book} lib=${lib} route=${route} />`)}
        <//>`
      : html`<${EmptyState} icon="search" title="Szukaj w biblioteczce" message="Wpisz tytuł, autora albo nazwę serii." />`;
  } else if (results.isEmpty) {
    content = html`<${EmptyState}
      icon="search"
      title=${`Brak wyników dla „${queryForDisplay(query)}”`}
      message="Sprawdź pisownię albo spróbuj innego zapytania."
    />`;
  } else {
    content = html`
      ${results.authors.length > 0 &&
      html`<${ListSection} header="Autorzy">
        ${results.authors.map(
          (author) => html`<${AuthorRow} key=${author.id} author=${author} route=${route} avatarSize=${34} />`,
        )}
      <//>`}
      ${results.series.length > 0 &&
      html`<${ListSection} header="Serie">
        ${results.series.map((series) => html`<${SeriesRow} key=${series.id} series=${series} route=${route} />`)}
      <//>`}
      ${results.books.length > 0 &&
      html`<${ListSection} header="Książki">
        ${results.books.map((book) => html`<${BookRow} key=${book.id} book=${book} lib=${lib} route=${route} />`)}
      <//>`}
    `;
  }

  return html`<div class="screen search">
    <${SearchField} value=${query} onInput=${setQuery} placeholder="Tytuł, autor lub seria" />
    <p class="visually-hidden" role="status">${announcement(empty, results)}</p>
    <div class="search-results">${content}</div>
  </div>`;
}
