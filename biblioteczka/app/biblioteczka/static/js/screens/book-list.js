// Karta „Książki”: posiadane książki z wyborem sortowania (tytuł, autor i seria, ostatnio dodane).

import { html, useState } from '../../vendor/preact-htm.js';
import { ownedBooks, useLibrary } from '../store.js';
import { EmptyState, Icon, ListSection, Menu, useChrome } from '../ui/index.js';
import { openBookEditor } from '../editors/index.js';
import { BookRow } from './common.js';
import { BOOK_SORTS, isBookSort, shelfHeader, sortBooks } from './logic.js';

// Wybór sortowania pamiętany na tym urządzeniu (w iOS – tylko do zamknięcia aplikacji).
const SORT_KEY = 'biblioteczka.bookSort';

function loadSort() {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    return isBookSort(saved) ? saved : 'title';
  } catch {
    return 'title';
  }
}

function saveSort(value) {
  try {
    localStorage.setItem(SORT_KEY, value);
  } catch {
    // Bez localStorage (tryb prywatny) – wybór tylko do odświeżenia strony.
  }
}

export function BookListScreen({ route }) {
  const lib = useLibrary();
  const [sort, setSortState] = useState(loadSort);
  const owned = ownedBooks(lib);

  const setSort = (value) => {
    setSortState(value);
    saveSort(value);
  };

  useChrome({
    leading: html`<${Menu}
      label="Sortuj"
      trigger=${Icon('sort')}
      align="start"
      disabled=${owned.length === 0}
      items=${() => [
        { header: 'Sortowanie' },
        ...BOOK_SORTS.map((option) => ({
          label: option.label,
          icon: option.icon,
          checked: option.value === sort,
          onClick: () => setSort(option.value),
        })),
      ]}
    />`,
  });

  if (!owned.length) {
    return html`<${EmptyState}
      icon="book"
      title="Brak książek na półce"
      message="Dodaj książkę – zacznij wpisywać tytuł, a podpowiemy pozycje z katalogu."
      action=${{ label: 'Dodaj książkę', onClick: () => openBookEditor({}) }}
    />`;
  }

  const books = sortBooks(owned, sort, lib);

  return html`<div class="screen book-list">
    <${ListSection} header=${shelfHeader(books.length)}>
      ${books.map((book) => html`<${BookRow} key=${book.id} book=${book} lib=${lib} route=${route} />`)}
    <//>
  </div>`;
}
