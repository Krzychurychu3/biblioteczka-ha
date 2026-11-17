// Edytor książki (iOS BookEditorView): podpowiedzi tytułów, autorów i serii, przejmowanie pozycji
// z katalogu, ostrzeżenia o duplikatach, szukanie danych po ISBN, okładka, zapis na serwerze.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { api } from '../api.js';
import { getLibrary, mutate, refresh, useLibrary } from '../store.js';
import {
  Button,
  Cover,
  IconButton,
  Icon,
  ListButton,
  ListSection,
  Menu,
  Note,
  NumberField,
  Segmented,
  Sheet,
  Spinner,
  SuggestionField,
  TextField,
  confirmDialog,
  openSheet,
  toast,
} from '../ui/index.js';
import { cleanedName } from '../core/text.js';
import { parseISBN } from '../core/isbn.js';
import { editorCover } from '../core/palette.js';
import * as L from './logic.js';
import { likelyHasCamera, pickImage, uploadCover } from './media.js';
import { openScanner } from './scanner.js';
import { blurActive, ensureEditorStyles, leaveDeletedEntry, nextFrame, toId } from './shared.js';

const AUTO_VOLUME_DELAY = 300;
const LOOKUP_TIMEOUT = 40000;

const STATUS_OPTIONS = [
  { value: true, label: 'Mam' },
  { value: false, label: 'Brakuje mi' },
];

function parseScanned(value) {
  if (!value) return null;
  const digits = typeof value === 'object' ? value.digits : value;
  return parseISBN(String(digits ?? ''));
}

/** Biblioteczka zawierająca podane książki – odświeża stan, gdy lokalnie ich jeszcze nie ma. */
async function libraryWithBooks(ids) {
  const wanted = (ids || []).filter((id) => id !== null && id !== undefined);
  let lib = getLibrary();
  if (wanted.every((id) => lib.booksById.has(id))) return lib;
  try {
    await refresh();
  } catch {
    // Bez świeżych danych – zostaje to, co już mamy.
  }
  lib = getLibrary();
  return lib;
}

/**
 * Otwiera edytor książki.
 * `bookId` – edycja; inaczej nowa książka z kontekstem `authorId`, `seriesId`, `volumeNumber`;
 * `scannedIsbn` (cyfry albo `{digits}`) – od razu szuka danych po tym numerze.
 * Zwraca uchwyt arkusza albo null (edytowanej książki już nie ma).
 */
export function openBookEditor({ bookId = null, seriesId = null, authorId = null, volumeNumber = null, scannedIsbn = null } = {}) {
  ensureEditorStyles();
  const id = toId(bookId);
  const lib = getLibrary();
  if (id !== null && !lib.booksById.has(id)) {
    toast('Nie znaleziono tej książki – możliwe, że ktoś właśnie ją usunął.', { tone: 'error' });
    return null;
  }
  const props = {
    bookId: id,
    seriesId: toId(seriesId),
    authorId: toId(authorId),
    volumeNumber: volumeNumber === null || volumeNumber === undefined ? null : Number(volumeNumber),
    scannedIsbn: parseScanned(scannedIsbn),
  };
  return openSheet(({ close }) => html`<${BookEditor} close=${close} ...${props} />`);
}

function LookupStatus({ status, sources, isNew, onRetry }) {
  if (status === 'searching') {
    return html`<div class="editor-status" aria-live="polite">
      <span class="editor-searching"><${Spinner} size=${16} /><span>Szukam książki…</span></span>
    </div>`;
  }
  const message = L.lookupMessage(status, { isNew, sources });
  const strong = message.tone === 'warning' || message.tone === 'success';
  return html`<div class="editor-status" key=${status} aria-live="polite">
    <${Note} icon=${message.icon} tone=${message.tone} className=${strong ? 'is-strong' : ''}>${message.text}<//>
    ${status === 'offline' &&
    onRetry &&
    html`<${Button} variant="plain" size="s" className="editor-retry" onClick=${onRetry}>Spróbuj ponownie<//>`}
  </div>`;
}

function BookEditor({ close, bookId, seriesId, authorId, volumeNumber, scannedIsbn }) {
  const lib = useLibrary();
  const libRef = useRef(lib);
  libRef.current = lib;
  const isNew = bookId === null;

  const [form, setFormState] = useState(() =>
    L.initialBookForm(lib, {
      book: isNew ? null : lib.booksById.get(bookId),
      authorId,
      seriesId,
      volumeNumber,
      scannedIsbn: scannedIsbn ? scannedIsbn.digits : null,
    }),
  );
  const formRef = useRef(form);
  const setForm = (update) => {
    const next = typeof update === 'function' ? update(formRef.current) : update;
    if (next === formRef.current) return;
    formRef.current = next;
    setFormState(next);
  };

  const [lookupView, setLookupView] = useState({ status: 'idle', sources: [] });
  const lookupRef = useRef({ status: 'idle', token: 0, controller: null, last: null });
  const [busy, setBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const alive = useRef(true);
  const autoTimer = useRef(0);
  // Na czas zapisu widok trzyma dane sprzed zapisu (bez mignięcia ostrzeżenia o duplikacie).
  const frozenLib = useRef(null);
  const titleRef = useRef(null);
  const authorRef = useRef(null);
  const seriesRef = useRef(null);

  const setLookupStatus = (status, sources = []) => {
    lookupRef.current.status = status;
    setLookupView({ status, sources });
  };

  const cancelLookup = (status = 'idle') => {
    const ls = lookupRef.current;
    ls.token += 1;
    ls.controller?.abort();
    ls.controller = null;
    if (ls.status === 'searching') setLookupStatus(status);
  };

  useEffect(() => {
    alive.current = true;
    if (scannedIsbn) lookUp(scannedIsbn);
    return () => {
      alive.current = false;
      clearTimeout(autoTimer.current);
      const ls = lookupRef.current;
      ls.token += 1;
      ls.controller?.abort();
    };
  }, []);

  // --- Numer tomu (§9.4) ---

  const scheduleAutoVolume = () => {
    clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      if (alive.current) setForm((f) => L.autoVolume(f, libRef.current));
    }, AUTO_VOLUME_DELAY);
  };

  const flushAutoVolume = () => {
    clearTimeout(autoTimer.current);
    setForm((f) => L.autoVolume(f, libRef.current));
  };

  // --- Szukanie po ISBN ---

  async function lookUp(isbn) {
    const digits = isbn.digits;
    blurActive();
    const ls = lookupRef.current;
    ls.controller?.abort();
    const token = ++ls.token;
    ls.last = digits;
    setForm((f) => ({ ...f, isbnText: digits }));

    // Ten numer ma już książka w bazie – bez pytania internetu (tylko nowa książka).
    if (isNew) {
      const existing = L.findIsbnBook(libRef.current, digits);
      if (existing) {
        setForm((f) => L.fillFromExisting(f, existing, libRef.current));
        setLookupStatus('inLibrary');
        return;
      }
    }

    const controller = new AbortController();
    ls.controller = controller;
    setLookupStatus('searching');
    const current = formRef.current;
    let response;
    try {
      response = await api.post(
        'api/lookup',
        {
          isbn: digits,
          editingBookId: isNew ? null : bookId,
          form: { title: current.title, authorName: current.authorName, seriesName: current.seriesName },
        },
        { signal: controller.signal, timeout: LOOKUP_TIMEOUT },
      );
    } catch (error) {
      if (!alive.current || token !== ls.token) return;
      ls.controller = null;
      const failure = L.lookupFailure(error);
      // Bez „Spróbuj ponownie” ten sam numer musi dać się wyszukać jeszcze raz (Enter, „Pobierz dane”).
      if (failure.forget) ls.last = null;
      if (failure.toast) toast(failure.toast, { tone: 'error' });
      setLookupStatus(failure.status);
      return;
    }
    if (!alive.current || token !== ls.token) return;
    ls.controller = null;
    // Numer zmieniony w trakcie – wynik jest nieaktualny (bez zawieszonego „Szukam…”).
    if (L.isStaleLookup(formRef.current.isbnText, digits)) {
      ls.last = null;
      setLookupStatus('idle');
      return;
    }

    const status = response?.status;
    const resolution = response?.resolution && typeof response.resolution === 'object' ? response.resolution : null;
    if (status === 'found' && response.info) {
      const isbnIds = isNew && Array.isArray(resolution?.isbnBookIds) ? resolution.isbnBookIds : [];
      const needed = [...isbnIds];
      if (isNew && resolution?.libraryBookId != null) needed.push(resolution.libraryBookId);
      const fresh = needed.length ? await libraryWithBooks(needed) : libRef.current;
      if (!alive.current || token !== ls.token || L.isStaleLookup(formRef.current.isbnText, digits)) {
        if (alive.current && token === ls.token) {
          ls.last = null;
          setLookupStatus('idle');
        }
        return;
      }
      if (isbnIds.length) {
        // Inne urządzenie zapisało już książkę z tym numerem.
        const existing = L.findIsbnBook(fresh, digits, { extraIds: isbnIds });
        if (existing) {
          setForm((f) => L.fillFromExisting(f, existing, fresh));
          setLookupStatus('inLibrary');
          return;
        }
      }
      setForm((f) => L.applyLookup(f, response.info, { lib: fresh, isNew, editingId: bookId, resolution }));
      const sources = Array.isArray(response.info.sources) ? response.info.sources.filter((s) => typeof s === 'string') : [];
      setLookupStatus('found', sources);
    } else if (status === 'notFound') {
      setLookupStatus('notFound');
    } else if (status === 'offline') {
      setLookupStatus('offline');
    } else {
      // Nieznana odpowiedź nic nie wpisała – ten numer można wyszukać ponownie.
      ls.last = null;
      setLookupStatus('idle');
    }
  }

  const lookUpTyped = () => {
    const target = L.typedLookupTarget(formRef.current.isbnText, {
      searching: lookupRef.current.status === 'searching',
      lastLookedUp: lookupRef.current.last,
    });
    if (target) lookUp(target);
  };

  const retryLookup = () => {
    const isbn = parseISBN(lookupRef.current.last || '');
    if (isbn && lookupRef.current.status !== 'searching') lookUp(isbn);
  };

  const scanFromEditor = () => {
    blurActive();
    openScanner({ onIsbn: (isbn) => alive.current && lookUp(isbn) });
  };

  // --- Okładka ---

  const chooseCover = async (camera) => {
    blurActive();
    const file = await pickImage({ camera });
    if (!file || !alive.current) return;
    setCoverBusy(true);
    try {
      const coverId = await uploadCover(file);
      if (coverId && alive.current) setForm((f) => ({ ...f, coverId }));
    } catch (error) {
      console.warn(error);
      if (alive.current) toast(error?.message || 'Nie udało się zapisać okładki.', { tone: 'error' });
    } finally {
      if (alive.current) setCoverBusy(false);
    }
  };

  const coverItems = () => [
    likelyHasCamera() && { label: 'Zrób zdjęcie okładki', icon: 'camera', onClick: () => chooseCover(true) },
    { label: 'Wybierz ze zdjęć', icon: 'photo', onClick: () => chooseCover(false) },
    formRef.current.coverId && {
      label: 'Usuń okładkę',
      icon: 'trash',
      role: 'destructive',
      onClick: () => setForm((f) => ({ ...f, coverId: null })),
    },
  ];

  // --- Zapis ---

  const save = async () => {
    if (busy || coverBusy) return;
    flushAutoVolume();
    const f = formRef.current;
    if (!cleanedName(f.title)) return;
    const current = libRef.current;
    const hasTarget = !isNew || f.adoptedId !== null;
    const target = !isNew ? current.booksById.get(bookId) : f.adoptedId !== null ? current.booksById.get(f.adoptedId) : null;
    const draft = L.buildBookDraft(f, { hasTarget, targetCoverId: target ? target.coverId : null });
    frozenLib.current = current;
    setBusy(true);
    const result = await mutate(() =>
      isNew
        ? api.post('api/books', f.adoptedId !== null ? { draft, adoptId: f.adoptedId } : { draft })
        : api.put(`api/books/${bookId}`, { draft }),
    );
    if (!alive.current) return;
    if (result === undefined) {
      frozenLib.current = null;
      setBusy(false);
      return;
    }
    close();
    if (!draft.isOwned && !draft.seriesName && isNew) {
      toast('Zapisano jako „nie mam” – ta książka nie pojawi się na listach.');
    }
  };

  /** „Mam ją – oznacz…” / „Zapisz okładkę i dane wydania…”: tylko puste dane wydania istniejącej książki. */
  const completeExisting = async (duplicate, markOwned) => {
    // W trakcie wysyłania okładki dane wydania nie mają jeszcze nowego `coverId`.
    if (busy || coverBusy) return;
    frozenLib.current = libRef.current;
    setBusy(true);
    const edition = L.buildEdition(formRef.current);
    const result = await mutate(() => api.post(`api/books/${duplicate.id}/complete`, { edition, markOwned }), {
      success: markOwned ? 'Książka stoi już na Twojej półce.' : 'Uzupełniono dane Twojej książki.',
    });
    if (!alive.current) return;
    if (result === undefined) {
      frozenLib.current = null;
      setBusy(false);
    } else close();
  };

  const remove = async () => {
    const choice = await confirmDialog({
      title: 'Usunąć tę książkę?',
      message: 'Tej operacji nie można cofnąć.',
      actions: [{ label: 'Usuń książkę', role: 'destructive' }],
    });
    if (!choice || !alive.current) return;
    frozenLib.current = libRef.current;
    setBusy(true);
    const result = await mutate(() => api.del(`api/books/${bookId}`));
    if (!alive.current) return;
    if (result === undefined) {
      frozenLib.current = null;
      setBusy(false);
    } else {
      close();
      // Ekran szczegółów usuniętej książki (np. otwarty ołówkiem) nie zostaje pusty.
      leaveDeletedEntry('book', bookId);
    }
  };

  // --- Wyliczenia do widoku ---

  const viewLib = frozenLib.current || lib;
  const matchingAuthor = L.findMatchingAuthor(viewLib, form.authorName);
  const matchingSeries = L.findMatchingSeries(viewLib, form.seriesName, matchingAuthor);
  const titleSuggestions = L.titleSuggestions(viewLib, form.title, { isNew, adoptedId: form.adoptedId });
  const authorSuggestions = L.authorSuggestions(viewLib, form.authorName);
  const seriesSuggestions = L.seriesSuggestions(viewLib, form.seriesName, matchingAuthor);
  const duplicate = L.findDuplicateBook(viewLib, {
    title: form.title,
    authorName: form.authorName,
    editingId: bookId,
    adoptedId: form.adoptedId,
  });
  const hasSeries = cleanedName(form.seriesName) !== '';
  const searching = lookupView.status === 'searching';
  const canFetch = Boolean(
    L.typedLookupTarget(form.isbnText, { searching, lastLookedUp: lookupRef.current.last }),
  );
  const isbnWarning = L.isbnFieldWarning(form.isbnText);
  const cover = editorCover({ title: form.title, seriesName: form.seriesName, volume: form.volume });

  // --- Obsługa pól ---

  const onTitleInput = (text) => setForm((f) => L.setTitle(f, text));

  const pickTitle = (item) => {
    const book = libRef.current.booksById.get(item.id);
    if (!book) return;
    clearTimeout(autoTimer.current);
    setForm((f) => L.adoptBook(f, book, libRef.current));
    blurActive();
  };

  const onAuthorInput = (text) => {
    setForm((f) => ({ ...f, authorName: text }));
    if (formRef.current.volumeSource === 'auto') scheduleAutoVolume();
  };

  const pickAuthor = (item) => {
    setForm((f) => ({ ...f, authorName: item.title }));
    if (formRef.current.volumeSource === 'auto') scheduleAutoVolume();
    nextFrame(() => seriesRef.current?.focus());
  };

  const onSeriesInput = (text) => {
    setForm((f) => ({ ...f, seriesName: text }));
    scheduleAutoVolume();
  };

  const pickSeries = (item) => {
    const series = libRef.current.seriesById.get(item.id);
    if (!series) return;
    clearTimeout(autoTimer.current);
    setForm((f) => {
      let next = f;
      if (!cleanedName(f.authorName) && series.authorId !== null && series.authorId !== undefined) {
        const author = libRef.current.authorsById.get(series.authorId);
        if (author) next = { ...next, authorName: author.name };
      }
      return L.setSeries(next, series.name, isNew ? series.suggestedVolumeNumber : f.volume);
    });
    blurActive();
  };

  const onIsbnInput = (text) => {
    setForm((f) => ({ ...f, isbnText: text }));
    const ls = lookupRef.current;
    if (ls.status === 'searching' && ls.last && L.isStaleLookup(text, ls.last)) {
      // Przerwane szukanie nic nie wpisało – ten numer można potem wyszukać ponownie.
      ls.last = null;
      cancelLookup('idle');
    }
  };

  // --- Widok ---

  const coverTrigger = html`
    <${Cover}
      title=${cover.title}
      seed=${cover.seed}
      label=${cover.label}
      coverId=${form.coverId}
      size="xl"
      badge=${html`<span class="editor-cover-badge">${Icon(form.coverId ? 'pencil' : 'camera-fill')}</span>`}
    />
    ${coverBusy && html`<span class="editor-cover-busy"><${Spinner} size=${22} label="Zapisuję okładkę…" /></span>`}
  `;

  const dupAction = L.duplicateAction(duplicate, form, { isNew, busy, coverBusy });
  const duplicateActions = dupAction
    ? html`<div class="cell editor-actions">
        <${Button}
          variant="plain"
          size="s"
          icon=${dupAction.icon}
          disabled=${dupAction.disabled}
          onClick=${() => completeExisting(duplicate, dupAction.markOwned)}
        >
          ${dupAction.label}
        <//>
      </div>`
    : null;

  return html`<${Sheet}
    title=${isNew ? 'Nowa książka' : 'Edycja książki'}
    onSave=${save}
    saveDisabled=${!cleanedName(form.title) || coverBusy}
    busy=${busy}
  >
    <${ListSection} label="Okładka">
      <div class="cell editor-cover-row">
        <${Menu}
          className="editor-cover-btn"
          label=${form.coverId ? 'Zmień okładkę' : 'Dodaj okładkę'}
          trigger=${coverTrigger}
          items=${coverItems}
          align="start"
          disabled=${coverBusy || busy}
        />
        <div class="editor-lookup">
          <${LookupStatus} status=${lookupView.status} sources=${lookupView.sources} isNew=${isNew} onRetry=${retryLookup} />
          <${Button} variant="prominent" size="s" icon="barcode" disabled=${searching || busy} onClick=${scanFromEditor}>
            ${cleanedName(form.isbnText) ? 'Skanuj ponownie' : 'Skanuj kod kreskowy'}
          <//>
        </div>
      </div>
    <//>

    <${ListSection} header="Tytuł">
      <${SuggestionField}
        value=${form.title}
        onInput=${onTitleInput}
        placeholder="Tytuł książki"
        size="title"
        autocapitalize="sentences"
        enterKeyHint="next"
        autofocus=${isNew && !scannedIsbn}
        inputRef=${titleRef}
        suggestions=${titleSuggestions}
        onPick=${pickTitle}
        onEnter=${() => authorRef.current?.focus()}
      />
      ${form.adoptedId !== null &&
      html`<${Note} className="cell" icon="seal" tone="success">Pozycja z katalogu – po zapisaniu trafi na Twoją półkę.<//>`}
      ${duplicate && html`<${Note} className="cell" icon="warning" tone="warning">${L.duplicateBookMessage(duplicate)}<//>`}
      ${duplicateActions}
    <//>

    <${ListSection}
      header="Autor"
      footer=${cleanedName(form.authorName) && !matchingAuthor
        ? html`<${Note} icon="person-plus">Zostanie dodany nowy autor<//>`
        : null}
    >
      <${SuggestionField}
        value=${form.authorName}
        onInput=${onAuthorInput}
        placeholder="Imię i nazwisko"
        enterKeyHint="next"
        inputRef=${authorRef}
        suggestions=${authorSuggestions}
        onPick=${pickAuthor}
        onEnter=${() => seriesRef.current?.focus()}
        onBlur=${() => formRef.current.volumeSource === 'auto' && flushAutoVolume()}
      />
    <//>

    <${ListSection}
      header="Seria"
      footer=${hasSeries && !matchingSeries ? html`<${Note} icon="stack-plus">Zostanie utworzona nowa seria<//>` : null}
    >
      <${SuggestionField}
        value=${form.seriesName}
        onInput=${onSeriesInput}
        placeholder="Nazwa serii (opcjonalnie)"
        enterKeyHint="done"
        inputRef=${seriesRef}
        suggestions=${seriesSuggestions}
        onPick=${pickSeries}
        onEnter=${() => blurActive()}
        onBlur=${flushAutoVolume}
      />
      ${hasSeries &&
      html`<${NumberField}
        label="Tom"
        placeholder="brak"
        value=${form.volume}
        min=${0}
        max=${999}
        stepper
        onChange=${(n) => {
          clearTimeout(autoTimer.current);
          setForm((f) => L.setVolumeByUser(f, n));
        }}
      />`}
    <//>

    <${ListSection}
      header="Status"
      plain
      footer=${form.isOwned
        ? 'Książka stoi na Twojej półce.'
        : 'Książka zostanie w bazie, ale nie pojawi się na listach. Brakujące tomy serii zobaczysz w szczegółach serii.'}
    >
      <div class="editor-segment">
        <${Segmented}
          label="Status"
          options=${STATUS_OPTIONS}
          value=${form.isOwned}
          onChange=${(value) => setForm((f) => ({ ...f, isOwned: value }))}
        />
      </div>
    <//>

    <${ListSection}
      header="Wydanie"
      footer=${isbnWarning ? html`<${Note} icon="warning" tone="warning">${isbnWarning}<//>` : null}
    >
      <${TextField}
        label="ISBN"
        value=${form.isbnText}
        onInput=${onIsbnInput}
        placeholder="brak"
        mono
        autocapitalize="characters"
        enterKeyHint="search"
        onEnter=${lookUpTyped}
        trailing=${canFetch
          ? html`<${IconButton} icon="download-circle" label="Pobierz dane" className="editor-isbn-btn" onClick=${lookUpTyped} />`
          : null}
      />
      <${TextField}
        label="Wydawnictwo"
        value=${form.publisher}
        onInput=${(text) => setForm((f) => ({ ...f, publisher: text }))}
        placeholder="brak"
      />
      <${NumberField}
        label="Rok wydania"
        placeholder="brak"
        value=${form.year}
        min=${0}
        max=${2100}
        onChange=${(n) => setForm((f) => ({ ...f, year: n }))}
      />
      <${NumberField}
        label="Liczba stron"
        placeholder="brak"
        value=${form.pageCount}
        min=${0}
        max=${9999}
        onChange=${(n) => setForm((f) => ({ ...f, pageCount: n }))}
      />
    <//>

    <${ListSection} header="Notatki">
      <${TextField}
        multiline
        value=${form.notes}
        onInput=${(text) => setForm((f) => ({ ...f, notes: text }))}
        placeholder="Np. komu pożyczona, stan, dedykacja"
        autocapitalize="sentences"
        ariaLabel="Notatki"
      />
    <//>

    ${!isNew &&
    html`<${ListSection} label="Usuwanie">
      <${ListButton} label="Usuń książkę" role="destructive" align="center" disabled=${busy} onClick=${remove} />
    <//>`}
  <//>`;
}
