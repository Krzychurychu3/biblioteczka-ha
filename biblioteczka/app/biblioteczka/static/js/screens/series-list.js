// Karta „Serie”: kafelki statystyk, filtr kompletności i lista serii z postępem.

import { html, useState } from '../../vendor/preact-htm.js';
import { api } from '../api.js';
import { mutate, useLibrary, visibleSeries } from '../store.js';
import {
  Button,
  EmptyState,
  Icon,
  ListButton,
  ListSection,
  ProgressBar,
  Segmented,
  StatTiles,
  useRetainedState,
} from '../ui/index.js';
import { openBookEditor, openSeriesEditor } from '../editors/index.js';
import { SeriesRow, seriesActions } from './common.js';
import {
  SERIES_FILTERS,
  coverJobProgress,
  emptyFilterRow,
  filterSeries,
  isLibraryEmpty,
  libraryStats,
} from './logic.js';

/** Pasek postępu pobierania brakujących okładek (widoczny na wszystkich urządzeniach). */
export function CoverJobCard({ job }) {
  const progress = coverJobProgress(job);
  if (!progress) return null;
  return html`<${ListSection} label="Pobieranie okładek">
    <div class="cell cover-job" role="status">
      <div class="cover-job-head">
        ${Icon('photo', { className: 'cover-job-icon' })}
        <span class="cover-job-title">Pobieram brakujące okładki…</span>
        <span class="cover-job-count digits">${progress.text}</span>
      </div>
      <${ProgressBar} fraction=${progress.fraction} tint="accent" />
      ${progress.foundText && html`<span class="cover-job-found">${progress.foundText}</span>`}
    </div>
  <//>`;
}

function insertSampleData() {
  return mutate(() => api.post('api/sample-data'));
}

function EmptyLibrary({ devMode }) {
  const [busy, setBusy] = useState(false);
  const loadSample = async () => {
    setBusy(true);
    try {
      await insertSampleData();
    } finally {
      setBusy(false);
    }
  };
  return html`<${EmptyState}
    icon="books"
    title="Pusta biblioteczka"
    message="Dodaj książki, które masz – przy wpisywaniu tytułu podpowiemy autorów, serie i tytuły z katalogu. Pokażemy też, których tomów serii Ci brakuje."
    action=${{ label: 'Dodaj książkę', onClick: () => openBookEditor({}) }}
    secondaryAction=${{ label: 'Dodaj serię', onClick: () => openSeriesEditor({}) }}
  >
    ${devMode &&
    html`<div class="empty-extra">
      <${Button} variant="plain" size="s" icon="sparkles" busy=${busy} onClick=${loadSample}>Wczytaj przykładowe dane<//>
    </div>`}
  <//>`;
}

function EmptyFilterRow({ filter }) {
  const row = emptyFilterRow(filter);
  if (row.action) {
    return html`<${ListButton} icon=${row.icon} label=${row.text} onClick=${() => openSeriesEditor({})} />`;
  }
  return html`<div class="cell list-cell empty-filter-row text-secondary">
    ${Icon(row.icon, { className: 'empty-filter-icon' })}<span>${row.text}</span>
  </div>`;
}

export function SeriesListScreen({ route }) {
  const lib = useLibrary();
  // Filtr zostaje po powrocie ze szczegółów serii (jak @State w iOS SeriesListView).
  const [filter, setFilter] = useRetainedState('serie.filter', 'all');
  const shelf = visibleSeries(lib);

  if (isLibraryEmpty(shelf, lib.books)) {
    return html`<${EmptyLibrary} devMode=${Boolean(lib.meta?.devMode)} />`;
  }

  const stats = libraryStats(lib);
  const visible = filterSeries(shelf, filter);

  return html`<div class="screen series-list">
    <${ListSection} plain label="Podsumowanie" className="series-dashboard">
      <${StatTiles}
        tiles=${[
          { value: stats.owned, title: 'Na półce', icon: 'books-fill', tint: 'indigo' },
          { value: stats.completeSeries, title: 'Pełne serie', icon: 'seal', tint: 'green' },
          { value: stats.missing, title: 'Brakuje', icon: 'cart-fill', tint: 'orange' },
        ]}
      />
      <${Segmented} label="Filtr" options=${SERIES_FILTERS} value=${filter} onChange=${setFilter} />
    <//>
    <${CoverJobCard} job=${lib.meta?.coverJob} />
    <${ListSection} label="Serie">
      ${visible.length === 0 && html`<${EmptyFilterRow} filter=${filter} />`}
      ${visible.map(
        (series) => html`<${SeriesRow} key=${series.id} series=${series} route=${route} actions=${seriesActions(series)} />`,
      )}
    <//>
  </div>`;
}
