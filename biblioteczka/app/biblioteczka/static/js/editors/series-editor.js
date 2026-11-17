// Edytor serii (iOS SeriesEditorView): nazwa z blokadą duplikatu, autor z podpowiedziami,
// liczba tomów, notatki, usuwanie serii (z książkami albo bez).

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { api } from '../api.js';
import { getLibrary, mutate, useLibrary } from '../store.js';
import {
  ListButton,
  ListSection,
  Note,
  NumberField,
  Sheet,
  SuggestionField,
  TextField,
  confirmDialog,
  openSheet,
  toast,
} from '../ui/index.js';
import { cleanedName } from '../core/text.js';
import * as L from './logic.js';
import { ensureEditorStyles, leaveDeletedEntry, nextFrame, toId } from './shared.js';

/**
 * Otwiera edytor serii: `seriesId` – edycja, inaczej nowa seria (z autorem `authorId`, jeśli podany).
 * `onDelete` (opcjonalnie) – wywoływane po usunięciu serii; bez niego zamyka się ekran tej serii,
 * jeśli jest na wierzchu.
 */
export function openSeriesEditor({ seriesId = null, authorId = null, onDelete } = {}) {
  ensureEditorStyles();
  const id = toId(seriesId);
  if (id !== null && !getLibrary().seriesById.has(id)) {
    toast('Nie znaleziono tej serii – możliwe, że ktoś właśnie ją usunął.', { tone: 'error' });
    return null;
  }
  return openSheet(
    ({ close }) => html`<${SeriesEditor} close=${close} seriesId=${id} authorId=${toId(authorId)} onDelete=${onDelete} />`,
  );
}

function initialForm(lib, seriesId, authorId) {
  const series = seriesId !== null ? lib.seriesById.get(seriesId) : null;
  const seriesAuthor = series && series.authorId !== null ? lib.authorsById.get(series.authorId) : null;
  const contextAuthor = authorId !== null ? lib.authorsById.get(authorId) : null;
  const planned = Number(series?.plannedVolumeCount);
  return {
    name: series?.name ?? '',
    authorName: seriesAuthor?.name ?? contextAuthor?.name ?? '',
    planned: Number.isInteger(planned) && planned > 0 && planned <= 999 ? planned : 0,
    notes: series?.notes ?? '',
  };
}

function SeriesEditor({ close, seriesId, authorId, onDelete }) {
  const lib = useLibrary();
  const isNew = seriesId === null;
  const [form, setForm] = useState(() => initialForm(lib, seriesId, authorId));
  const [busy, setBusy] = useState(false);
  const frozenLib = useRef(null);
  const alive = useRef(true);
  const authorRef = useRef(null);
  const countRef = useRef(null);

  useEffect(() => () => {
    alive.current = false;
  }, []);

  const viewLib = frozenLib.current || lib;
  const series = isNew ? null : viewLib.seriesById.get(seriesId) ?? null;
  const matchingAuthor = L.findMatchingAuthor(viewLib, form.authorName);
  const suggestions = L.authorSuggestions(viewLib, form.authorName);
  const duplicate = L.findDuplicateSeries(viewLib, { name: form.name, authorName: form.authorName, editingId: seriesId });
  const canSave = cleanedName(form.name) !== '' && !duplicate;

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

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
    if (!canSave || busy) return;
    const draft = {
      name: cleanedName(form.name),
      authorName: cleanedName(form.authorName),
      plannedVolumeCount: form.planned > 0 ? form.planned : null,
      notes: String(form.notes ?? '').trim(),
    };
    run(() => (isNew ? api.post('api/series', { draft }) : api.put(`api/series/${seriesId}`, { draft })));
  };

  const remove = async () => {
    if (!series) return;
    const choice = await confirmDialog({
      title: 'Usunąć serię?',
      message: 'Jeśli usuniesz tylko serię, jej książki zostaną w biblioteczce jako pojedyncze tytuły.',
      actions: L.seriesDeleteActions(L.seriesBookCount(lib, series)),
    });
    if (!choice || !alive.current) return;
    run(
      () => api.del(`api/series/${seriesId}?withBooks=${choice.withBooks ? 1 : 0}`),
      () => leaveDeletedEntry('series', seriesId, onDelete),
    );
  };

  return html`<${Sheet}
    title=${isNew ? 'Nowa seria' : 'Edycja serii'}
    onSave=${save}
    saveDisabled=${!canSave}
    busy=${busy}
  >
    <${ListSection} header="Nazwa serii">
      <${TextField}
        value=${form.name}
        onInput=${(text) => update({ name: text })}
        placeholder="Np. Wiedźmin"
        size="title"
        enterKeyHint="next"
        autofocus=${isNew}
        onEnter=${() => authorRef.current?.focus()}
      />
      ${duplicate &&
      html`<${Note} className="cell" icon="warning" tone="warning" role="status">${L.duplicateSeriesMessage(duplicate)}<//>`}
    <//>

    <${ListSection}
      header="Autor"
      footer=${cleanedName(form.authorName) && !matchingAuthor
        ? html`<${Note} icon="person-plus">Zostanie dodany nowy autor<//>`
        : null}
    >
      <${SuggestionField}
        value=${form.authorName}
        onInput=${(text) => update({ authorName: text })}
        placeholder="Imię i nazwisko"
        enterKeyHint="next"
        inputRef=${authorRef}
        suggestions=${suggestions}
        onPick=${(item) => {
          update({ authorName: item.title });
          nextFrame(() => countRef.current?.focus());
        }}
        onEnter=${() => countRef.current?.focus()}
      />
    <//>

    <${ListSection}
      header="Wielkość serii"
      footer="Podaj, ile tomów liczy cała seria – od razu zobaczysz, których Ci brakuje."
    >
      <${NumberField}
        label="Liczba tomów"
        placeholder="nieznana"
        value=${form.planned}
        min=${0}
        max=${999}
        stepper
        inputRef=${countRef}
        onChange=${(n) => update({ planned: n })}
      />
    <//>

    <${ListSection} header="Notatki">
      <${TextField}
        multiline
        value=${form.notes}
        onInput=${(text) => update({ notes: text })}
        placeholder="Opcjonalnie"
        autocapitalize="sentences"
        ariaLabel="Notatki"
      />
    <//>

    ${!isNew &&
    html`<${ListSection} label="Usuwanie">
      <${ListButton} label="Usuń serię" role="destructive" align="center" disabled=${busy || !series} onClick=${remove} />
    <//>`}
  <//>`;
}
