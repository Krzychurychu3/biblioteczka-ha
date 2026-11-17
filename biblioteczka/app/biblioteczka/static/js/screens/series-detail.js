// Szczegóły serii: karta postępu, autor, „półka” tomów (także puste miejsca i brakujące tomy), notatki.

import { html } from '../../vendor/preact-htm.js';
import { useLibrary } from '../store.js';
import {
  Button,
  Cover,
  EmptyState,
  Icon,
  ListButton,
  ListCell,
  ListRow,
  ListSection,
  MissingBadge,
  OwnedToggle,
  PlaceholderCover,
  ProgressBar,
  ToolbarButton,
  getRoute,
  goBack,
  useChrome,
} from '../ui/index.js';
import { openBookEditor, openSeriesEditor } from '../editors/index.js';
import { AuthorRow, bookActions, useOwnedToggle, useRowLink } from './common.js';
import { isTotalKnown, seriesCountCaption, volumeCaption, volumeRows } from './logic.js';

/** Po usunięciu serii w edytorze wracamy z jej ekranu (iOS `onDelete: dismiss`). */
function popIfShowing(route) {
  return () => {
    if (getRoute().path === route.path) goBack();
  };
}

function SeriesHeader({ series, onEdit }) {
  const progress = series.progress || {};
  const known = isTotalKnown(series);
  const total = progress.total || 0;
  let status;
  if (!known) {
    status = html`<div class="series-status-stack">
      ${series.missingDescription
        ? html`<span class="text-orange">${series.missingDescription}</span>`
        : total === 0 && html`<span class="text-secondary">Dodaj tomy, żeby śledzić, które już masz.</span>`}
      <${Button} variant="plain" size="s" icon="number-circle" className="series-size-btn" onClick=${onEdit}>
        Podaj, ile tomów ma seria
      <//>
    </div>`;
  } else if (progress.isComplete) {
    status = html`<span class="series-status-complete text-green">${Icon('seal')}Seria kompletna</span>`;
  } else if (series.missingDescription) {
    status = html`<span class="text-orange series-status-missing">${series.missingDescription}</span>`;
  }
  return html`<${ListSection} plain label="Podsumowanie serii" className="detail-header">
    <div class="card card-header series-header">
      <${Cover} title=${series.name} coverId=${series.coverId} size="l" stack />
      <div class="series-header-body">
        ${total > 0 &&
        html`<p class="series-count">
          <span class="series-count-value digits">${progress.owned || 0}</span>
          <span class="series-count-caption">${seriesCountCaption(series)}</span>
        </p>`}
        ${known &&
        total > 0 &&
        html`<${ProgressBar} fraction=${progress.fraction} complete=${progress.isComplete} seed=${series.name} height=${8} />`}
        ${status && html`<div class="series-status">${status}</div>`}
      </div>
    </div>
  <//>`;
}

function PlaceholderVolumeRow({ series, number }) {
  const add = () => openBookEditor({ seriesId: series.id, volumeNumber: number });
  return html`<${ListRow}
    className="placeholder-row"
    onClick=${add}
    ariaLabel=${`Tom ${number} – nie dodano. Dodaj`}
    leading=${html`<${PlaceholderCover} label=${number} size="xs" />`}
    title=${`Tom ${number}`}
    subtitle="Jeszcze go nie dodano"
    trailing=${html`<button type="button" class="placeholder-add" tabindex="-1" aria-hidden="true" onClick=${add}>
      ${Icon('plus-circle')}
    </button>`}
  />`;
}

/** Tom serii: w wąskim układzie otwiera edytor, w trybie dwóch paneli – szczegóły książki. */
function VolumeRow({ series, book, number, lib, route }) {
  const [owned, toggle] = useOwnedToggle(book);
  const link = useRowLink(route, 'book', book.id);
  const caption = volumeCaption(book, number, series, lib.authorsById);
  const detail =
    caption || !owned
      ? html`${caption && html`<span class="row-detail-text">${caption}</span>`} ${!owned && html`<${MissingBadge} />`}`
      : null;
  return html`<${ListRow}
    className="volume-row title-medium"
    href=${link ? link.href : undefined}
    onClick=${link ? link.onClick : () => openBookEditor({ bookId: book.id })}
    chevron=${Boolean(link)}
    dimmed=${!owned}
    leading=${html`<${Cover}
      title=${book.title}
      seed=${series.name}
      label=${number ?? undefined}
      coverId=${book.coverId}
      size="xs"
      dimmed=${!owned}
    />`}
    title=${book.title}
    detail=${detail}
    trailing=${html`<${OwnedToggle} owned=${owned} onToggle=${toggle} />`}
    actions=${bookActions(book, { owned, onToggle: toggle })}
    actionsLabel=${`Akcje książki „${book.title}”`}
  />`;
}

export function SeriesDetailScreen({ id, route }) {
  const lib = useLibrary();
  const series = lib.seriesById.get(id);
  const onDelete = popIfShowing(route);
  const edit = () => openSeriesEditor({ seriesId: id, onDelete });
  const addVolume = () => openBookEditor({ seriesId: id });

  useChrome(
    series
      ? {
          trailing: html`<${ToolbarButton} icon="pencil" label="Edytuj serię" onClick=${edit} />
            <${ToolbarButton} icon="plus" label="Dodaj tom" onClick=${addVolume} />`,
        }
      : { trailing: null },
  );

  if (!series) {
    return html`<${EmptyState} icon="trash" title="Seria została usunięta" />`;
  }

  const author = series.authorId != null ? lib.authorsById.get(series.authorId) : null;
  const rows = volumeRows(series, lib.booksById);

  return html`<div class="screen series-detail">
    <${SeriesHeader} series=${series} onEdit=${edit} />
    ${author &&
    html`<${ListSection} header="Autor">
      <${AuthorRow} author=${author} route=${route} avatarSize=${34} />
    <//>`}
    <${ListSection} header="Tomy">
      ${rows.length === 0 && html`<${ListButton} icon="plus-circle" label="Dodaj pierwszy tom" onClick=${addVolume} />`}
      ${rows.map((row) =>
        row.kind === 'placeholder'
          ? html`<${PlaceholderVolumeRow} key=${`n${row.number}`} series=${series} number=${row.number} />`
          : html`<${VolumeRow}
              key=${`b${row.book.id}`}
              series=${series}
              book=${row.book}
              number=${row.number}
              lib=${lib}
              route=${route}
            />`,
      )}
    <//>
    ${series.notes &&
    html`<${ListSection} header="Notatki">
      <${ListCell}>${series.notes}<//>
    <//>`}
  </div>`;
}
