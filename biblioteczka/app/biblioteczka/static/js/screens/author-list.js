// Karta „Autorzy”: autorzy, których książki są na półce (autorzy z samego katalogu są ukryci).

import { html } from '../../vendor/preact-htm.js';
import { useLibrary, visibleAuthors } from '../store.js';
import { EmptyState, ListSection } from '../ui/index.js';
import { openBookEditor } from '../editors/index.js';
import { AuthorRow, authorActions } from './common.js';

export function AuthorListScreen({ route }) {
  const lib = useLibrary();
  const authors = visibleAuthors(lib);

  if (!authors.length) {
    return html`<${EmptyState}
      icon="persons"
      title="Brak autorów"
      message="Autorzy pojawią się tu, gdy dodasz ich książki."
      action=${{ label: 'Dodaj książkę', onClick: () => openBookEditor({}) }}
    />`;
  }

  return html`<div class="screen author-list">
    <${ListSection} label="Autorzy">
      ${authors.map(
        (author) => html`<${AuthorRow} key=${author.id} author=${author} route=${route} actions=${authorActions(author)} />`,
      )}
    <//>
  </div>`;
}
