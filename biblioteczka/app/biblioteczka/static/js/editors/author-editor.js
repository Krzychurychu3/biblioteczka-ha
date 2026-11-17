// Edytor autora (iOS AuthorEditorView): imię i nazwisko, ostrzeżenie o istniejącym autorze,
// łączenie przy zmianie nazwy na istniejącą, „Podobni autorzy w bazie”, usuwanie.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { api } from '../api.js';
import { getLibrary, mutate, useLibrary } from '../store.js';
import {
  Avatar,
  ListButton,
  ListRow,
  ListSection,
  Note,
  Sheet,
  TextField,
  confirmDialog,
  openSheet,
  toast,
} from '../ui/index.js';
import { cleanedName } from '../core/text.js';
import * as L from './logic.js';
import { ensureEditorStyles, leaveDeletedEntry, toId } from './shared.js';

/**
 * Otwiera edytor autora: `authorId` – edycja, inaczej nowy autor.
 * `onDelete` (opcjonalnie) – po usunięciu albo połączeniu z innym autorem; bez niego zamyka się
 * ekran tego autora, jeśli jest na wierzchu. `onMerged(targetId)` – dodatkowo po połączeniu.
 */
export function openAuthorEditor({ authorId = null, onDelete, onMerged } = {}) {
  ensureEditorStyles();
  const id = toId(authorId);
  if (id !== null && !getLibrary().authorsById.has(id)) {
    toast('Nie znaleziono tego autora – możliwe, że ktoś właśnie go usunął.', { tone: 'error' });
    return null;
  }
  return openSheet(
    ({ close }) => html`<${AuthorEditor} close=${close} authorId=${id} onDelete=${onDelete} onMerged=${onMerged} />`,
  );
}

function AuthorEditor({ close, authorId, onDelete, onMerged }) {
  const lib = useLibrary();
  const isNew = authorId === null;
  const [name, setName] = useState(() => (isNew ? '' : lib.authorsById.get(authorId)?.name ?? ''));
  const [busy, setBusy] = useState(false);
  const frozenLib = useRef(null);
  const alive = useRef(true);

  useEffect(() => () => {
    alive.current = false;
  }, []);

  const viewLib = frozenLib.current || lib;
  const author = isNew ? null : viewLib.authorsById.get(authorId) ?? null;
  const state = L.authorEditorState(viewLib, { name, editingId: authorId });
  const similar = L.similarAuthors(viewLib, name, { excludingId: authorId });

  const run = async (task, onSuccess) => {
    frozenLib.current = getLibrary();
    setBusy(true);
    const result = await mutate(task);
    if (!alive.current) return;
    if (result === undefined) {
      frozenLib.current = null;
      setBusy(false);
      return;
    }
    close();
    onSuccess?.(result);
  };

  const save = () => {
    if (!state.canSave || busy) return;
    const clean = cleanedName(name);
    const mergeTarget = state.willMerge ? state.exactMatch : null;
    const oldName = author?.name ?? '';
    run(
      () => (isNew ? api.post('api/authors', { name: clean }) : api.put(`api/authors/${authorId}`, { name: clean })),
      (result) => {
        const mergedInto = result && result.mergedInto !== null && result.mergedInto !== undefined ? result.mergedInto : null;
        if (mergedInto === null) return;
        // Połączenie: edytowany wpis znika, jego książki i serie ma teraz istniejący autor.
        const targetName = mergeTarget?.name || clean;
        toast(`„${oldName}” i „${targetName}” to teraz jeden autor – książki i serie zostały połączone.`, { tone: 'success' });
        leaveDeletedEntry('author', authorId, onDelete);
        if (typeof onMerged === 'function') {
          try {
            onMerged(mergedInto);
          } catch (error) {
            console.error(error);
          }
        }
      },
    );
  };

  const remove = async () => {
    if (!author) return;
    const hasContent = (Number(author.bookCount) || 0) > 0 || (author.seriesIds || []).length > 0;
    const actions = hasContent
      ? [
          { label: `Usuń razem z książkami (${Number(author.bookCount) || 0})`, role: 'destructive', withBooks: true },
          { label: 'Usuń tylko autora', role: 'destructive', withBooks: false },
        ]
      : [{ label: 'Usuń autora', role: 'destructive', withBooks: false }];
    const choice = await confirmDialog({
      title: 'Usunąć autora?',
      message: 'Jeśli usuniesz tylko autora, jego książki i serie zostaną w biblioteczce bez przypisanego autora.',
      actions,
    });
    if (!choice || !alive.current) return;
    run(
      () => api.del(`api/authors/${authorId}?withBooks=${choice.withBooks ? 1 : 0}`),
      () => leaveDeletedEntry('author', authorId, onDelete),
    );
  };

  const footer = state.message
    ? html`<${Note} icon=${state.willMerge ? 'merge' : 'warning'} tone=${state.willMerge ? 'secondary' : 'warning'}>
        ${state.message}
      <//>`
    : null;

  return html`<${Sheet}
    title=${isNew ? 'Nowy autor' : 'Edycja autora'}
    onSave=${save}
    saveDisabled=${!state.canSave}
    busy=${busy}
  >
    <${ListSection} header="Imię i nazwisko" footer=${footer}>
      <${TextField}
        value=${name}
        onInput=${setName}
        placeholder="Np. Stanisław Lem"
        size="title"
        enterKeyHint="done"
        autofocus=${isNew}
        onEnter=${save}
      />
    <//>

    ${similar.length > 0 &&
    html`<${ListSection} header="Podobni autorzy w bazie" className="editor-similar">
      ${similar.map(
        (other) => html`<${ListRow}
          key=${other.id}
          leading=${html`<${Avatar} name=${other.name} size=${32} />`}
          title=${other.name}
          subtitle=${other.summary}
        />`,
      )}
    <//>`}

    ${!isNew &&
    html`<${ListSection} label="Usuwanie">
      <${ListButton} label="Usuń autora" role="destructive" align="center" disabled=${busy || !author} onClick=${remove} />
    <//>`}
  <//>`;
}
