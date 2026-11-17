// Menu paska: „+” (Dodaj) i „…” (Więcej) na karcie Serie.
// Obie funkcje są zwykłymi funkcjami (bez hooków) – Menu wywołuje je przy każdym otwarciu,
// więc pozycje zawsze odpowiadają bieżącym danym.

import { html } from '../../vendor/preact-htm.js';
import { api } from '../api.js';
import { parseISBN } from '../core/isbn.js';
import { getLibrary, mutate, subscribe } from '../store.js';
import { alertDialog, confirmDialog, toast } from '../ui/index.js';
import { openAuthorEditor, openBookEditor, openScanner, openSeriesEditor } from '../editors/index.js';
import {
  catalogImportMessage,
  coverJobProgress,
  coverJobResultMessage,
  coverJobStartMessage,
  csvImportReport,
  csvImportTitle,
  hasExportableBooks,
} from './logic.js';

/**
 * Pozycje menu „Dodaj”. `ctx.authorId` – ekran autora: książka i seria z tym autorem,
 * bez „Dodaj autora”. Skanowanie zawsze otwiera nową książkę bez kontekstu.
 */
export function AddMenuItems(ctx = {}) {
  const authorId = ctx && ctx.authorId != null ? ctx.authorId : undefined;
  return [
    { label: 'Skanuj kod kreskowy', icon: 'barcode', onClick: () => openScanner() },
    { label: 'Dodaj książkę', icon: 'book', onClick: () => openBookEditor(authorId !== undefined ? { authorId } : {}) },
    { label: 'Dodaj serię', icon: 'books', onClick: () => openSeriesEditor(authorId !== undefined ? { authorId } : {}) },
    authorId === undefined && { label: 'Dodaj autora', icon: 'person', onClick: () => openAuthorEditor({}) },
  ];
}

// ---------------------------------------------------------------------------
// Katalog bajek
// ---------------------------------------------------------------------------

let catalogBusy = false;

async function importCatalog() {
  if (catalogBusy) return;
  catalogBusy = true;
  try {
    const result = await mutate(() => api.post('api/catalog/import'));
    if (result !== undefined) {
      await alertDialog({ title: 'Katalog bajek dla dzieci', message: catalogImportMessage(Number(result.added) || 0) });
    }
  } finally {
    catalogBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Import CSV
// ---------------------------------------------------------------------------

const CSV_MAX_BYTES = 15 * 1024 * 1024;
let csvBusy = false;

/** Tekst pliku: UTF-8 (z BOM albo bez), a gdy to nie UTF-8 – Windows-1250 (polski Excel). */
async function readCsvText(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('windows-1250').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

function reportMessage(lines) {
  const parts = [];
  lines.forEach((line, i) => {
    if (i) parts.push(html`<br />`);
    parts.push(line);
  });
  return parts;
}

async function importCsvFile(file) {
  if (csvBusy) return;
  if (file.size > CSV_MAX_BYTES) {
    toast('Plik jest za duży – CSV z Biblioteczki ma zwykle kilkaset kilobajtów.', { tone: 'error' });
    return;
  }
  csvBusy = true;
  const progress = toast('Importuję plik CSV…', { duration: 0 });
  try {
    let text;
    try {
      text = await readCsvText(file);
    } catch {
      toast('Nie udało się odczytać pliku.', { tone: 'error' });
      return;
    }
    const report = await mutate(() => api.upload('api/import/csv', text, 'text/csv; charset=utf-8', { timeout: 120000 }));
    progress.dismiss();
    if (report !== undefined) {
      await alertDialog({ title: csvImportTitle(report), message: reportMessage(csvImportReport(report)) });
    }
  } finally {
    progress.dismiss();
    csvBusy = false;
  }
}

/** Okno wyboru pliku (musi zostać otwarte w obsłudze kliknięcia pozycji menu). */
function pickCsvFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv,text/comma-separated-values,text/plain';
  input.hidden = true;
  const cleanup = () => input.remove();
  input.addEventListener(
    'change',
    () => {
      const file = input.files && input.files[0];
      cleanup();
      if (file) importCsvFile(file);
    },
    { once: true },
  );
  input.addEventListener('cancel', cleanup, { once: true });
  // Safari na iOS otwiera okno wyboru tylko dla pola obecnego w dokumencie.
  document.body.append(input);
  input.click();
}

// ---------------------------------------------------------------------------
// Eksport CSV
// ---------------------------------------------------------------------------

function exportCsv() {
  const link = document.createElement('a');
  link.href = api.url('api/export.csv');
  link.download = 'Biblioteczka.csv';
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

// ---------------------------------------------------------------------------
// Brakujące okładki
// ---------------------------------------------------------------------------

// Zadanie zlecone z tego urządzenia – tylko tu pokazujemy komunikat o wyniku.
let coverJobStartedHere = false;
let coverJobSeenRunning = false;

async function fetchMissingCovers() {
  const lib = getLibrary();
  const alreadyRunning = Boolean(lib.meta?.coverJob?.running);
  const result = await mutate(() => api.post('api/covers/fetch-missing'));
  if (result === undefined) return;
  if (result.started && Number(result.total) > 0) {
    const job = getLibrary().meta?.coverJob;
    if (job && !job.running) {
      // Zadanie skończyło się, zanim zdążyliśmy pobrać stan.
      toast(coverJobResultMessage(job.found), { tone: Number(job.found) > 0 ? 'success' : 'default' });
      return;
    }
    coverJobStartedHere = true;
    coverJobSeenRunning = Boolean(job?.running);
  }
  toast(coverJobStartMessage(result, alreadyRunning));
}

/** Czy jest książka z poprawnym ISBN i bez okładki (tylko takim szukamy okładek). */
function hasCoverCandidates(lib) {
  return lib.books.some((b) => !b.coverId && b.isbn && parseISBN(b.isbn));
}

function watchCoverJob(lib) {
  const job = lib.meta?.coverJob;
  if (job?.running) {
    coverJobSeenRunning = true;
    return;
  }
  if (coverJobStartedHere && coverJobSeenRunning) {
    coverJobStartedHere = false;
    coverJobSeenRunning = false;
    toast(coverJobResultMessage(job?.found), { tone: Number(job?.found) > 0 ? 'success' : 'default' });
  }
}

subscribe(watchCoverJob);

// ---------------------------------------------------------------------------
// Przykładowe dane, usuwanie wszystkiego
// ---------------------------------------------------------------------------

function insertSampleData() {
  return mutate(() => api.post('api/sample-data'));
}

async function deleteAll() {
  const choice = await confirmDialog({
    title: 'Usunąć wszystkie dane?',
    message: 'Znikną wszystkie książki, serie i autorzy – także katalog podpowiedzi. Tej operacji nie można cofnąć.',
    actions: [{ label: 'Usuń wszystko', role: 'destructive' }],
  });
  if (choice) await mutate(() => api.del('api/library'));
}

/** Pozycje menu „Więcej” (karta Serie). */
export function LibraryMenuItems() {
  const lib = getLibrary();
  const meta = lib.meta || {};
  const anyOwned = lib.books.some((b) => b.isOwned);
  const job = coverJobProgress(meta.coverJob);
  return [
    meta.catalogAvailable && {
      label: 'Uzupełnij katalog bajek dla dzieci',
      icon: 'book-text',
      onClick: importCatalog,
    },
    meta.devMode && !anyOwned && { label: 'Wczytaj przykładowe dane', icon: 'sparkles', onClick: insertSampleData },
    { divider: true },
    { label: 'Importuj z CSV', icon: 'import', onClick: pickCsvFile },
    { label: 'Eksportuj do CSV', icon: 'export', disabled: !hasExportableBooks(lib), onClick: exportCsv },
    {
      label: 'Pobierz brakujące okładki',
      icon: 'photo',
      subtitle: job ? `Trwa pobieranie – ${job.text.toLocaleLowerCase('pl')}` : undefined,
      disabled: Boolean(job) || !hasCoverCandidates(lib),
      onClick: fetchMissingCovers,
    },
    { divider: true },
    {
      label: 'Usuń wszystkie dane',
      icon: 'trash',
      role: 'destructive',
      disabled: lib.books.length === 0,
      onClick: deleteAll,
    },
  ];
}
