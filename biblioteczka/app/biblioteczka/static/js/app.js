// Biblioteczka – start aplikacji, router, pasek kart / szyna nawigacji, pasek tytułu, warstwy.
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// TABELA TRAS (ROUTES) – kontrakt dla autorów ekranów
// ═══════════════════════════════════════════════════════════════════════════════════════
//
//   Trasa                      Moduł                          Eksport               Propsy
//   ───────────────────────── ────────────────────────────── ───────────────────── ───────────
//   #/serie        (domyślna)  ./screens/series-list.js       SeriesListScreen      {route}
//   #/autorzy                  ./screens/author-list.js       AuthorListScreen      {route}
//   #/ksiazki                  ./screens/book-list.js         BookListScreen        {route}
//   #/szukaj                   ./screens/search.js            SearchScreen          {route}
//   #/serie/:id                ./screens/series-detail.js     SeriesDetailScreen    {id, route}
//   #/autorzy/:id              ./screens/author-detail.js     AuthorDetailScreen    {id, route}
//   …/seria/:id  (na stosie)   ./screens/series-detail.js     SeriesDetailScreen    {id, route}
//   …/autor/:id  (na stosie)   ./screens/author-detail.js     AuthorDetailScreen    {id, route}
//   …/ksiazka/:id (na stosie)  ./screens/book-detail.js       BookDetailScreen      {id, route}
//
//   Menu paska: ./screens/menus.js eksportuje zwykłe funkcje (bez hooków), wywoływane
//   w chwili otwarcia menu i zwracające pozycje dla ui/Menu:
//     AddMenuItems({authorId?})  → przycisk „+” (etykieta „Dodaj”) na Serie, Autorzy, Książki;
//                                  ekran autora sam wstawia Menu z AddMenuItems({authorId});
//     LibraryMenuItems()         → przycisk „…” (etykieta „Więcej”) po lewej na karcie Serie.
//
// Każda karta ma własny stos ekranów: `#/serie/5/autor/3` = karta Serie → seria 5 → autor 3,
// `#/szukaj/seria/5` = seria otwarta z wyników wyszukiwania, `#/ksiazki/ksiazka/12` = książka
// (karta „Książki” nie ma postaci naturalnej `#/ksiazki/12`). `id` to liczba.
// `route` = {tab: 'serie'|'autorzy'|'ksiazki'|'szukaj', stack: [{type, id}], query, path}.
//
// Nawigacja z ekranów (ui/index.js): openSeries(id), openAuthor(id) – dokłada ekran na stos
// bieżącej karty; entryHref({type, id}) – adres do <a href>; goBack() – powrót (np. po
// usunięciu oglądanej serii); navigate('/ksiazki').
//
// Pasek tytułu: ekran wywołuje useChrome({title, leading, trailing, largeTitle}) z ui/index.js.
// Domyślnie: tytuł = nazwa karty (korzeń) albo nazwa serii/autora (szczegóły); „…” i „+” jak
// wyżej na korzeniach kart; na ekranach szczegółów brak przycisków (ekran dodaje własne,
// np. trailing: [Edytuj serię, Dodaj tom]). `leading: null` / `trailing: null` usuwa domyślne
// (np. Książki podmieniają leading na menu „Sortuj”). Ekrany kart w tle zostają zamontowane
// (zachowują stan) – useScreenActive() mówi, czy ekran jest widoczny. Wejście w szczegóły
// odmontowuje korzeń karty, więc stan, który ma przetrwać powrót (zapytanie wyszukiwania,
// filtr serii), ekran trzyma w useRetainedState() z ui/index.js.
//
// Dwa panele (okno od SPLIT_MIN_WIDTH = 1008 px, klasa `is-split` na <html>): każda karta to
// SplitPanel – po lewej korzeń karty (lista, zawsze zamontowany, klucz paska = `/<karta>`),
// po prawej ekran z wierzchu stosu (klucz = route.path) albo zachęta do wyboru. Ekrany i wiersze
// czytają panel z PaneContext (usePane() z ui/index.js): `{pane: 'single'|'list'|'detail', split,
// selected}`. Wiersz na liście nie przechodzi do szczegółów, tylko je wybiera – selectEntry():
// pierwszy wybór dodaje wpis w historii, zmiana wyboru podmienia bieżący (z zachowaniem `bibFrom`).
// W prawym panelu nawigacja działa jak na telefonie (push), a „wstecz” pojawia się od głębokości 2.
// Ekran szczegółów nie może zależeć od trybu – ten sam ekran działa też w wąskim oknie.
// ═══════════════════════════════════════════════════════════════════════════════════════

import {
  h,
  html,
  render,
  useEffect,
  useErrorBoundary,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from '../vendor/preact-htm.js';
import { APP_VERSION } from './api.js';
import { ownedBooks, refresh, startSync, useLibrary, visibleAuthors, visibleSeries } from './store.js';
import { Icon } from './ui/icons.js';
import { Button, Spinner } from './ui/buttons.js';
import { OverlayHost, hasOpenLayer, hasOpenModal, noteLayoutSwitch, setFocusFallback } from './ui/overlay.js';
import { ToastHost, toast } from './ui/toast.js';
import { Menu } from './ui/menu.js';
import { EmptyState } from './ui/empty.js';
import { ScreenContext, useChromeFor } from './ui/chrome.js';
import {
  getPreviousPath,
  getRoute,
  goBack,
  hrefFor,
  selectEntry,
  selectTab,
  tabPath,
  takeSelectionIntent,
  useRoute,
} from './ui/router.js';
import {
  LIST_PANE_LABELS,
  focusFallbackTarget,
  isFocusLost,
  isTabEmpty,
  listKeyTarget,
  parentRoute,
  parseRoute,
  rootRoute,
  selectedEntry,
  selectionAnnouncement,
  splitPlaceholder,
  topEntry,
} from './ui/pure.js';
import { prefersReducedMotion } from './ui/a11y.js';
import { historyLeaveOrphanLayers } from './ui/history.js';
import {
  DETAIL_PANE,
  PaneContext,
  cancelReveal,
  onAnnouncementReset,
  paneHeading,
  revealSelectedRow,
  useSplitView,
} from './ui/split.js';

/** Tabela tras: korzenie kart i ekrany szczegółów (typ wpisu na stosie). */
export const ROUTES = Object.freeze({
  tabs: {
    serie: { module: './screens/series-list.js', export: 'SeriesListScreen' },
    autorzy: { module: './screens/author-list.js', export: 'AuthorListScreen' },
    ksiazki: { module: './screens/book-list.js', export: 'BookListScreen' },
    szukaj: { module: './screens/search.js', export: 'SearchScreen' },
  },
  entries: {
    series: { module: './screens/series-detail.js', export: 'SeriesDetailScreen' },
    author: { module: './screens/author-detail.js', export: 'AuthorDetailScreen' },
    book: { module: './screens/book-detail.js', export: 'BookDetailScreen' },
  },
  menus: { module: './screens/menus.js', exports: ['AddMenuItems', 'LibraryMenuItems'] },
});

/** Karty w kolejności paska (ikony jak w iOS RootView). */
const TAB_ITEMS = [
  { tab: 'serie', label: 'Serie', icon: 'books-fill' },
  { tab: 'autorzy', label: 'Autorzy', icon: 'persons-fill' },
  { tab: 'ksiazki', label: 'Książki', icon: 'book-fill' },
  { tab: 'szukaj', label: 'Szukaj', icon: 'search', search: true },
];
const TAB_LABELS = Object.fromEntries(TAB_ITEMS.map((t) => [t.tab, t.label]));

// ---------------------------------------------------------------------------
// Leniwe wczytywanie modułów ekranów
// ---------------------------------------------------------------------------

const moduleCache = new Map();
let retryCounter = 0;

function loadModule(path) {
  let entry = moduleCache.get(path);
  if (!entry) {
    entry = { promise: null, module: null, error: null, attempt: 0 };
    startImport(entry, path, path);
    moduleCache.set(path, entry);
  }
  return entry;
}

function startImport(entry, path, url) {
  entry.error = null;
  entry.promise = import(url).then(
    (module) => {
      entry.module = module;
      return module;
    },
    (error) => {
      entry.error = error;
      console.error(`Nie udało się wczytać modułu ${path}`, error);
      throw error;
    },
  );
  entry.promise.catch(() => undefined);
}

/** Ponowna próba po błędzie (nieudany import jest zapamiętany przez przeglądarkę – inny adres). */
function retryModule(path) {
  const entry = loadModule(path);
  if (!entry.error) return entry;
  retryCounter += 1;
  startImport(entry, path, `${path}?retry=${retryCounter}`);
  return entry;
}

function useModule(path) {
  const entry = loadModule(path);
  const [, setTick] = useState(0);
  const promise = entry.promise;
  const renderedWith = entry.module;
  useEffect(() => {
    let alive = true;
    const rerender = () => alive && setTick((n) => n + 1);
    // Moduł mógł się wczytać między renderem a efektem – wtedy od razu przerysuj.
    if (entry.module !== renderedWith) rerender();
    else if (!entry.module) promise.then(rerender, rerender);
    return () => {
      alive = false;
    };
  }, [path, promise]);
  return {
    module: entry.module,
    error: entry.module ? null : entry.error,
    retry: () => {
      retryModule(path);
      setTick((n) => n + 1);
    },
  };
}

function prefetchModules() {
  const paths = [
    ...Object.values(ROUTES.tabs).map((r) => r.module),
    ...Object.values(ROUTES.entries).map((r) => r.module),
    ROUTES.menus.module,
  ];
  for (const path of paths) loadModule(path).promise.catch(() => undefined);
}

function routeSpec(route) {
  const entry = topEntry(route);
  return entry ? ROUTES.entries[entry.type] : ROUTES.tabs[route.tab];
}

// ---------------------------------------------------------------------------
// Tytuły
// ---------------------------------------------------------------------------

function entryTitle(entry, lib) {
  if (!entry) return '';
  if (entry.type === 'book') return lib.booksById.get(entry.id)?.title || '';
  const item = entry.type === 'series' ? lib.seriesById.get(entry.id) : lib.authorsById.get(entry.id);
  return item ? item.name : '';
}

function defaultTitle(route, lib) {
  const entry = topEntry(route);
  return entry ? entryTitle(entry, lib) : TAB_LABELS[route.tab];
}

function backLabel(route, lib) {
  const parent = parentRoute(route);
  if (!parent) return '';
  const entry = topEntry(parent);
  return entry ? entryTitle(entry, lib) || 'Wstecz' : TAB_LABELS[parent.tab];
}

// ---------------------------------------------------------------------------
// Przyciski menu paska
// ---------------------------------------------------------------------------

function MenusButton({ kind }) {
  const { module, error } = useModule(ROUTES.menus.module);
  const items = () => {
    if (!module) return [];
    const fn = kind === 'add' ? module.AddMenuItems : module.LibraryMenuItems;
    return typeof fn === 'function' ? fn(kind === 'add' ? {} : undefined) : [];
  };
  return html`<${Menu}
    label=${kind === 'add' ? 'Dodaj' : 'Więcej'}
    trigger=${Icon(kind === 'add' ? 'plus' : 'ellipsis')}
    items=${items}
    align=${kind === 'add' ? 'end' : 'start'}
    disabled=${!module || Boolean(error)}
  />`;
}

function defaultChrome(route) {
  if (route.stack.length) return {};
  switch (route.tab) {
    case 'serie':
      return { leading: h(MenusButton, { kind: 'library' }), trailing: h(MenusButton, { kind: 'add' }) };
    case 'autorzy':
    case 'ksiazki':
      return { trailing: h(MenusButton, { kind: 'add' }) };
    default:
      return {};
  }
}

function pick(custom, fallback, name) {
  return custom && custom[name] !== undefined ? custom[name] : fallback[name];
}

// ---------------------------------------------------------------------------
// Pasek tytułu
// ---------------------------------------------------------------------------

function activeLargeTitle() {
  return document.querySelector('.screen-panel:not([hidden]) .large-title');
}

/**
 * Zwijanie dużego tytułu do paska: `[compact, scrolled]`. Bez `getScroller` – przewijane okno
 * (wąski układ), z nim – przewijany panel (dwa panele). Mierzy przy każdym przewinięciu
 * (raz na klatkę) i przy zmianie rozmiaru okna.
 */
function useCompactBar({ barRef, getScroller, getHeading, largeTitle, deps }) {
  const [compact, setCompact] = useState(!largeTitle);
  const [scrolled, setScrolled] = useState(false);

  useLayoutEffect(() => {
    const scroller = getScroller ? getScroller() : null;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Pasek ukrytej karty (dwa panele) nie ma wymiarów: pomiar zwinąłby go, a po pokazaniu karty
      // zwinięty tytuł i tło paska gasłyby animacją. Stan zostaje do pomiaru po pokazaniu karty.
      if (barRef.current && !barRef.current.getClientRects().length) return;
      setScrolled((scroller ? scroller.scrollTop : scrollY) > 2);
      if (!largeTitle) {
        setCompact(true);
        return;
      }
      const heading = getHeading();
      const bar = barRef.current;
      if (!heading || !bar) {
        setCompact(false);
        return;
      }
      const bottom = heading.getBoundingClientRect().bottom;
      setCompact(bottom <= bar.getBoundingClientRect().bottom + 2);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // W panelu pierwszy pomiar wypada przed efektami App (efekty dzieci działają pierwsze): bez klasy
    // `is-split` i z oknem jeszcze przewiniętym z wąskiego układu. Panel się wtedy nie przewija,
    // więc nic by pomiaru nie poprawiło – drugi pomiar w następnej klatce.
    if (scroller) onScroll();
    if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
    else addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    return () => {
      if (scroller) scroller.removeEventListener('scroll', onScroll);
      else removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, deps);

  return [compact, scrolled];
}

/**
 * Pasek tytułu. `pane`: 'single' – wąski układ (jeden pasek nad aktywnym ekranem, przewijane okno);
 * 'list' – lewy panel (`route` = korzeń karty, bez „wstecz”); 'detail' – prawy panel (`route` =
 * pełna trasa, „wstecz” od głębokości 2). W panelach mierzy przewinięcie własnego panelu.
 */
function PaneBar({ route, lib, pane = 'single', active = true }) {
  const custom = useChromeFor(route.path);
  const defaults = pane === 'detail' ? {} : defaultChrome(route);
  const title = (custom && custom.title) || defaultTitle(route, lib);
  const largeTitle = custom && custom.largeTitle === false ? false : true;
  const leading = pick(custom, defaults, 'leading');
  const trailing = pick(custom, defaults, 'trailing');
  const minDepth = pane === 'detail' ? 2 : pane === 'list' ? Infinity : 1;
  const back = route.stack.length >= minDepth ? (custom && custom.backLabel) || backLabel(route, lib) : null;
  const barRef = useRef(null);
  const inPane = pane !== 'single';
  const [compact, scrolled] = useCompactBar({
    barRef,
    getScroller: inPane ? () => barRef.current && barRef.current.closest('.pane') : null,
    getHeading: inPane
      ? () => barRef.current && barRef.current.closest('.pane')?.querySelector('.large-title')
      : activeLargeTitle,
    largeTitle,
    deps: inPane ? [route.path, largeTitle, title, active] : [route.path, largeTitle, title],
  });

  return html`<header class=${`navbar ${compact ? 'is-compact' : ''} ${scrolled || compact ? 'is-scrolled' : ''}`} ref=${barRef}>
    <div class="navbar-side navbar-leading">
      ${back !== null &&
      html`<button type="button" class="back-btn" onClick=${goBack} aria-label=${`Wstecz: ${back}`}>
        ${Icon('chevron-left')}<span class="back-label">${back}</span>
      </button>`}
      ${leading}
    </div>
    <div class="navbar-title" aria-hidden=${largeTitle && !compact ? 'true' : undefined}>${title}</div>
    <div class="navbar-side navbar-trailing">${trailing}</div>
  </header>`;
}

// ---------------------------------------------------------------------------
// Ekrany
// ---------------------------------------------------------------------------

function ScreenBoundary({ children, resetKey }) {
  const [error, reset] = useErrorBoundary((err) => console.error(err));
  useEffect(() => {
    if (error) reset();
  }, [resetKey]);
  if (error) {
    return html`<${EmptyState}
      icon="warning"
      title="Coś poszło nie tak"
      message="Ten ekran napotkał błąd. Spróbuj ponownie – dane biblioteczki są bezpieczne."
      action=${{ label: 'Spróbuj ponownie', onClick: reset }}
    />`;
  }
  return children;
}

function LargeTitle({ route, lib }) {
  const custom = useChromeFor(route.path);
  if (custom && custom.largeTitle === false) return null;
  const title = (custom && custom.title) || defaultTitle(route, lib);
  return html`<h1 class="large-title" tabindex="-1">${title || ' '}</h1>`;
}

function ScreenView({ route }) {
  const spec = routeSpec(route);
  const { module, error, retry } = useModule(spec.module);
  if (error) {
    return html`<${EmptyState}
      icon="warning"
      title="Nie udało się wczytać ekranu"
      message="Sprawdź połączenie z Home Assistant i spróbuj ponownie."
      action=${{ label: 'Spróbuj ponownie', icon: 'refresh', onClick: retry }}
    />`;
  }
  if (!module) return html`<div class="screen-loading"><${Spinner} size=${28} label="Wczytuję…" /></div>`;
  const Screen = module[spec.export];
  if (typeof Screen !== 'function') {
    console.error(`Moduł ${spec.module} nie eksportuje ${spec.export}`);
    return html`<${EmptyState} icon="warning" title="Nie udało się wczytać ekranu" />`;
  }
  const entry = topEntry(route);
  return h(Screen, entry ? { id: entry.id, route } : { route });
}

function ScreenPanel({ route, active, lib }) {
  return html`<section
    class="screen-panel"
    hidden=${!active}
    data-tab=${route.tab}
    data-depth=${route.stack.length}
    aria-hidden=${active ? undefined : 'true'}
  >
    <${ScreenContext.Provider} value=${{ key: route.path, active }}>
      <${LargeTitle} route=${route} lib=${lib} />
      <${ScreenBoundary} resetKey=${route.path}>
        <${ScreenView} key=${route.path} route=${route} />
      <//>
    <//>
  </section>`;
}

/**
 * Zapamiętuje przewinięcie panelu pod jego kluczem (ścieżką ekranu) – od razu, bez czekania na klatkę.
 * Po przejściu do wąskiego układu panel przestaje być przewijany (scrollTop spada do 0) – takie
 * spóźnione zdarzenie nie może nadpisać zapamiętanej pozycji.
 */
function recordPaneScroll(event) {
  const el = event.currentTarget;
  if (event.target !== el || !el.dataset.scrollKey || !el.isConnected) return;
  if (!document.documentElement.classList.contains('is-split')) return;
  scrollPositions.set(el.dataset.scrollKey, el.scrollTop);
}

/** Czy lista karty jest pusta (wtedy prawy panel nie zachęca do wyboru). */
function tabEmpty(tab, lib) {
  return isTabEmpty(tab, {
    series: visibleSeries(lib).length,
    authors: visibleAuthors(lib).length,
    books: ownedBooks(lib).length,
  });
}

function SplitPlaceholder({ tab, lib }) {
  const placeholder = splitPlaceholder(tab, tabEmpty(tab, lib));
  return html`<div class="pane-placeholder">
    ${placeholder && html`<${EmptyState} icon=${placeholder.icon} title=${placeholder.title} message=${placeholder.message} />`}
  </div>`;
}

/**
 * Karta w trybie dwóch paneli: lista (korzeń karty, zawsze zamontowany) i szczegóły pozycji
 * z wierzchu stosu. `announcement` – komunikat dla czytników ekranu po zmianie wyboru.
 */
function SplitPanel({ route, active, lib, announcement, onListKeyDown, onDetailKeyDown }) {
  const root = useMemo(() => rootRoute(route), [route.tab]);
  const selected = selectedEntry(route);
  const listPane = useMemo(
    () => ({ pane: 'list', split: true, selected }),
    [selected ? selected.type : null, selected ? selected.id : null],
  );
  const hasDetail = route.stack.length > 0;

  // Pierwsze zamontowanie z wybraną pozycją (adres otwarty z zewnątrz, przeładowanie, wczytanie
  // biblioteczki, zmiana układu): lista bez zapamiętanego przewinięcia pokazuje wybrany wiersz.
  useLayoutEffect(() => {
    if (selected && scrollPositions.get(root.path) === undefined) revealSelectedRow(route.tab);
  }, []);

  return html`<section
    class="screen-panel split-panel"
    hidden=${!active}
    data-tab=${route.tab}
    data-depth=${route.stack.length}
    aria-hidden=${active ? undefined : 'true'}
  >
    <${PaneContext.Provider} value=${listPane}>
      <section
        class="pane pane-list"
        aria-label=${LIST_PANE_LABELS[route.tab]}
        data-scroll-key=${root.path}
        onScroll=${recordPaneScroll}
        onKeyDown=${onListKeyDown}
      >
        <${ScreenContext.Provider} value=${{ key: root.path, active }}>
          <${PaneBar} pane="list" route=${root} lib=${lib} active=${active} />
          <${LargeTitle} route=${root} lib=${lib} />
          <${ScreenBoundary} resetKey=${root.path}>
            <${ScreenView} key=${root.path} route=${root} />
          <//>
        <//>
      </section>
    <//>
    <${PaneContext.Provider} value=${DETAIL_PANE}>
      <section
        class="pane pane-detail"
        aria-label="Szczegóły"
        data-scroll-key=${hasDetail ? route.path : undefined}
        onScroll=${recordPaneScroll}
        onKeyDown=${onDetailKeyDown}
      >
        ${hasDetail
          ? html`<${ScreenContext.Provider} value=${{ key: route.path, active }}>
              <${PaneBar} pane="detail" route=${route} lib=${lib} active=${active} />
              <div class="pane-body">
                <${LargeTitle} route=${route} lib=${lib} />
                <${ScreenBoundary} resetKey=${route.path}>
                  <${ScreenView} key=${route.path} route=${route} />
                <//>
              </div>
            <//>`
          : html`<${SplitPlaceholder} tab=${route.tab} lib=${lib} />`}
        <p class="visually-hidden" role="status">${active ? announcement : ''}</p>
      </section>
    <//>
  </section>`;
}

function LoadState({ lib }) {
  if (lib.error) {
    return html`<${EmptyState}
      icon="wifi-slash"
      title="Nie udało się wczytać biblioteczki"
      message=${lib.error.message || 'Brak połączenia z Home Assistant.'}
      action=${{ label: 'Spróbuj ponownie', icon: 'refresh', onClick: () => refresh({ force: true }).catch(() => undefined) }}
    />`;
  }
  return html`<div class="screen-loading is-boot">
    <${Spinner} size=${30} />
    <p>Wczytuję biblioteczkę…</p>
  </div>`;
}

function SyncBanner({ lib }) {
  const [busy, setBusy] = useState(false);
  if (!lib.loaded || !lib.error) return null;
  const retry = async () => {
    setBusy(true);
    try {
      await refresh();
    } catch {
      // Komunikat zostaje.
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="sync-banner" role="status">
    ${Icon('wifi-slash')}
    <span class="sync-text">${lib.error.message} Pokazuję ostatnio wczytane dane.</span>
    <${Button} variant="plain" size="s" busy=${busy} onClick=${retry}>Ponów<//>
  </div>`;
}

// ---------------------------------------------------------------------------
// Pasek kart / szyna nawigacji
// ---------------------------------------------------------------------------

function scrollToTop() {
  scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** Dwa panele: ponowne wybranie bieżącej karty przewija listę na górę (wybór zostaje). */
function scrollListToTop(tab) {
  cancelReveal(tab);
  const pane = document.querySelector('.is-split .split-panel:not([hidden]) .pane-list');
  pane?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function TabBar({ route, split }) {
  const onSelect = (event, tab) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault();
    if (split && route.tab === tab) scrollListToTop(tab);
    else if (route.tab === tab && !route.stack.length) scrollToTop();
    else selectTab(tab);
  };
  const link = (item) => html`<a
    key=${item.tab}
    class=${`tab ${item.search ? 'tab-search' : ''} ${route.tab === item.tab ? 'is-active' : ''}`}
    href=${hrefFor(tabPath(item.tab))}
    aria-current=${route.tab === item.tab ? 'page' : undefined}
    onClick=${(event) => onSelect(event, item.tab)}
  >
    <span class="tab-icon">${Icon(item.icon)}</span>
    <span class="tab-label">${item.label}</span>
  </a>`;
  return html`<nav class="tabbar" aria-label="Karty">
    <div class="rail-brand" aria-hidden="true">
      <span class="rail-logo">${Icon('books-fill')}</span>
      <span>Biblioteczka</span>
    </div>
    <div class="tabbar-group">${TAB_ITEMS.filter((t) => !t.search).map(link)}</div>
    <div class="tabbar-group tabbar-search">${TAB_ITEMS.filter((t) => t.search).map(link)}</div>
  </nav>`;
}

// ---------------------------------------------------------------------------
// Dwa panele: klawiatura i fokus
// ---------------------------------------------------------------------------

/**
 * Strzałki ↑/↓ (oraz Home/End) na liście lewego panelu: fokus i wybór przechodzą na sąsiedni
 * wiersz, a szczegóły zmieniają się od razu – fokus zostaje na liście. Adres w historii dochodzi
 * dopiero po chwili bez klawisza (przytrzymana strzałka nie zasypuje historii). ↓ z pola
 * wyszukiwania przechodzi do pierwszego wyniku. Przełącznik segmentowy obsługuje swoje strzałki sam.
 */
function onListKeyDown(event) {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const inField = target.matches('input, textarea, select, [contenteditable="true"]');
  if (inField && !(event.key === 'ArrowDown' && target.matches('input[type="search"]'))) return;
  const rows = [...event.currentTarget.querySelectorAll('.row-main[href]')].filter((el) => el.getClientRects().length > 0);
  let index = -1;
  if (!inField) {
    const row = target.closest('.row');
    index = row ? rows.findIndex((el) => row.contains(el)) : -1;
    if (index < 0) return;
  }
  const next = listKeyTarget(event.key, index, rows.length);
  if (next === null) return;
  event.preventDefault();
  if (next === index) return;
  const el = rows[next];
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
  const entry = parseRoute(new URL(el.href).hash)?.stack[0];
  if (entry) selectEntry(entry, { browsing: true });
}

/** Esc w prawym panelu (bez otwartej warstwy) wraca fokusem do wybranego wiersza listy. */
function onDetailKeyDown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || hasOpenLayer()) return;
  event.preventDefault();
  const row = document.querySelector('.is-split .split-panel:not([hidden]) .pane-list .row.is-selected .row-main');
  if (row) {
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  } else {
    paneHeading('list')?.focus({ preventScroll: true });
  }
}

/** Duży tytuł ekranu na wierzchu: w dwóch panelach – szczegółów, a bez wyboru – listy. */
function topHeading(split) {
  if (!split) return activeLargeTitle();
  return paneHeading(getRoute().stack.length ? 'detail' : 'list');
}

function focusSearchField() {
  const input = document.querySelector('.screen-panel:not([hidden]) input[type="search"]');
  if (!input) return false;
  input.focus({ preventScroll: true });
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    // Pole bez zaznaczania tekstu – kursor zostaje tam, gdzie postawiła go przeglądarka.
  }
  return true;
}

/**
 * Po zmianie układu ekrany są zamontowane od nowa, więc fokus mógł spaść na <body>. Pole
 * wyszukiwania odzyskuje fokus (z kursorem na końcu); w innym razie – tytuł ekranu na wierzchu.
 */
function restoreFocusAfterSwitch(split, hadSearchFocus) {
  if (hadSearchFocus && focusSearchField()) return;
  const active = document.activeElement;
  if ((active && active !== document.body) || hasOpenModal()) return;
  topHeading(split)?.focus({ preventScroll: true });
}

function focusLater(getTarget) {
  requestAnimationFrame(() => getTarget()?.focus({ preventScroll: true }));
}

// ---------------------------------------------------------------------------
// Aplikacja
// ---------------------------------------------------------------------------

/** Przewinięcie każdej trasy: w wąskim układzie – okna, w dwóch panelach – panelu (ten sam klucz). */
const scrollPositions = new Map();
const ANNOUNCE_DELAY_MS = 400;

function App() {
  const route = useRoute();
  const lib = useLibrary();
  const split = useSplitView();
  const mountedRef = useRef({});
  const lastPath = useRef(null);
  const lastSplit = useRef(split);
  const renderedSplit = useRef(split);
  const searchHadFocus = useRef(false);
  const focusPane = useRef('list');
  const libRef = useRef(lib);
  const announceTimer = useRef(0);
  const [announcement, setAnnouncement] = useState('');
  const versionWarned = useRef(false);
  libRef.current = lib;

  // Karty w tle zostają zamontowane z ostatnio oglądanym ekranem.
  mountedRef.current[route.tab] = route;
  const mounted = mountedRef.current;

  // Zmiana układu: w renderze stary DOM jeszcze istnieje – czy kursor był w polu wyszukiwania?
  // Warstwy otwarte przed zmianą wiedzą, że ich element otwierający zaraz zniknie (ui/overlay.js).
  if (renderedSplit.current !== split) {
    renderedSplit.current = split;
    const active = document.activeElement;
    searchHadFocus.current = Boolean(active && active.matches && active.matches('input[type="search"]'));
    noteLayoutSwitch();
  }

  // Klasa układu na <html> – przed efektem trasy niżej (efekty działają w kolejności deklaracji),
  // bo panele przewijają się dopiero z tą klasą.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('is-split', split);
  }, [split]);

  // Zapamiętywanie przewinięcia każdej trasy (okno; panele zapisują się same, recordPaneScroll).
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (document.documentElement.classList.contains('is-split')) return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scrollPositions.set(getRoute().path, scrollY);
      });
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);

  // Po zmianie trasy albo układu: przewinięcie (zapamiętane albo na górę) i fokus.
  useLayoutEffect(() => {
    if (lastPath.current === null) {
      lastPath.current = route.path;
      lastSplit.current = split;
      return;
    }
    const layoutChanged = lastSplit.current !== split;
    const pathChanged = lastPath.current !== route.path;
    const prev = parseRoute(lastPath.current);
    lastPath.current = route.path;
    lastSplit.current = split;
    const tabChanged = !prev || prev.tab !== route.tab;
    const intent = takeSelectionIntent(route.path);
    const hadSearchFocus = searchHadFocus.current;
    searchHadFocus.current = false;

    // Komunikat „Szczegóły: …” chwilę po ostatnim wyborze z listy; każda inna nawigacja go czyści.
    clearTimeout(announceTimer.current);
    setAnnouncement('');
    if (split && intent && !intent.focusDetail) {
      const entry = topEntry(route);
      announceTimer.current = setTimeout(() => {
        setAnnouncement(selectionAnnouncement(entryTitle(entry, libRef.current)));
      }, ANNOUNCE_DELAY_MS);
    }

    if (!split) {
      if (pathChanged) {
        const saved = scrollPositions.get(route.path);
        const goingDeeper = getPreviousPath() && route.path.startsWith(getPreviousPath() + '/');
        scrollTo(0, saved !== undefined && !goingDeeper ? saved : 0);
        requestAnimationFrame(() => activeLargeTitle()?.focus({ preventScroll: true }));
      } else {
        scrollTo(0, scrollPositions.get(route.path) ?? 0);
        restoreFocusAfterSwitch(false, hadSearchFocus);
      }
      return;
    }

    // W dwóch panelach okno się nie przewija – zostawione przewinięcie z wąskiego układu
    // przesunęłoby całą powłokę w górę (zapamiętana pozycja wąskiej trasy zostaje bez zmian).
    if (layoutChanged) scrollTo(0, 0);

    const panel = document.querySelector(`.split-panel[data-tab="${route.tab}"]`);
    const listPane = panel && panel.querySelector('.pane-list');
    const detailPane = panel && panel.querySelector('.pane-detail');
    if (pathChanged) cancelReveal(route.tab);
    if (listPane && (tabChanged || layoutChanged)) {
      const saved = scrollPositions.get(rootRoute(route).path);
      listPane.scrollTop = saved ?? 0;
      if (saved === undefined && route.stack.length) revealSelectedRow(route.tab);
    } else if (listPane && pathChanged && !intent && route.stack.length) {
      // Wybór zmieniony bez listy (wstecz/dalej, wpisany adres): wybrany wiersz ma być widoczny.
      const before = prev && selectedEntry(prev);
      const now = selectedEntry(route);
      if (!before || before.type !== now.type || before.id !== now.id) revealSelectedRow(route.tab);
    }
    if (detailPane && route.stack.length) {
      let top;
      if (layoutChanged || tabChanged) top = scrollPositions.get(route.path) ?? 0;
      else if (intent || (prev && route.path.startsWith(prev.path + '/'))) top = 0;
      else top = scrollPositions.get(route.path) ?? 0;
      detailPane.scrollTop = top;
    }

    if (layoutChanged && !pathChanged) restoreFocusAfterSwitch(true, hadSearchFocus);
    else if (intent && intent.focusDetail) focusLater(() => paneHeading('detail'));
    else if (intent) {
      // Przeglądanie listy (klik, strzałki): fokus zostaje na liście, czytnik dostanie komunikat.
    } else if (tabChanged) focusLater(() => paneHeading('list'));
    else focusLater(() => paneHeading(route.stack.length ? 'detail' : 'list'));
  }, [route.path, split]);

  useEffect(
    () =>
      onAnnouncementReset(() => {
        clearTimeout(announceTimer.current);
        setAnnouncement('');
      }),
    [],
  );

  // Gdy element, który otworzył arkusz, dialog lub menu, zniknął (usunięty wiersz, ekrany zamontowane
  // od nowa): w dwóch panelach fokus wraca na tytuł panelu, w którym był ostatnio; w wąskim układzie –
  // na tytuł ekranu, ale tylko po zmianie układu przy otwartej warstwie (telefon bez zmian: nic).
  useEffect(() => {
    const onFocusIn = (event) => {
      const pane = event.target && event.target.closest ? event.target.closest('.pane') : null;
      if (pane) focusPane.current = pane.classList.contains('pane-detail') ? 'detail' : 'list';
    };
    document.addEventListener('focusin', onFocusIn);
    setFocusFallback(({ layoutSwitched = false } = {}) => {
      // Fokus wciąż w zamykanej warstwie też jest zgubiony – zniknie razem z nią.
      if (!isFocusLost(document.activeElement, document.body) || hasOpenModal()) return;
      const target = focusFallbackTarget({
        split: document.documentElement.classList.contains('is-split'),
        layoutSwitched,
        lastPane: focusPane.current,
        hasDetail: getRoute().stack.length > 0,
      });
      const heading = target === 'screen' ? activeLargeTitle() : target ? paneHeading(target) : null;
      heading?.focus({ preventScroll: true });
    });
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      setFocusFallback(null);
    };
  }, []);

  useEffect(() => {
    const title = defaultTitle(route, lib);
    document.title = title && title !== 'Biblioteczka' ? `${title} – Biblioteczka` : 'Biblioteczka';
  }, [route.path, lib]);

  // Nowa wersja na serwerze – zaproponuj odświeżenie strony.
  useEffect(() => {
    if (versionWarned.current || !APP_VERSION || !lib.appVersion || lib.appVersion === APP_VERSION) return;
    versionWarned.current = true;
    toast('Dostępna jest nowa wersja Biblioteczki.', {
      duration: 0,
      action: { label: 'Odśwież', onClick: () => location.reload() },
    });
  }, [lib.appVersion]);

  const panels = TAB_ITEMS.map((t) => mounted[t.tab]).filter(Boolean).map((r) =>
    split
      ? h(SplitPanel, {
          key: r.tab,
          route: r,
          active: r.tab === route.tab,
          lib,
          announcement,
          onListKeyDown,
          onDetailKeyDown,
        })
      : h(ScreenPanel, { key: r.tab, route: r, active: r.tab === route.tab, lib }),
  );

  const skipTo = (getTarget) => (event) => {
    event.preventDefault();
    getTarget()?.focus();
  };
  const skipLinks = split
    ? [
        html`<a key="list" class="skip-link" href=${hrefFor(route.path)} onClick=${skipTo(() => paneHeading('list'))}>
          Przejdź do listy
        </a>`,
        route.stack.length > 0 &&
          html`<a key="detail" class="skip-link" href=${hrefFor(route.path)} onClick=${skipTo(() => paneHeading('detail'))}>
            Przejdź do szczegółów
          </a>`,
      ]
    : html`<a class="skip-link" href=${hrefFor(route.path)} onClick=${(event) => {
        event.preventDefault();
        activeLargeTitle()?.focus();
      }}>Przejdź do treści</a>`;

  return [
    html`<div class="shell" data-app-shell key="shell">
      ${skipLinks}
      <${TabBar} route=${route} split=${split} />
      <div class="main-column">
        ${!split && html`<${PaneBar} route=${route} lib=${lib} />`}
        <main class="page" id="main">
          <${SyncBanner} lib=${lib} />
          ${lib.loaded ? panels : html`<${LoadState} lib=${lib} />`}
        </main>
      </div>
    </div>`,
    html`<${OverlayHost} key="overlays" />`,
    html`<${ToastHost} key="toasts" />`,
  ];
}

async function boot() {
  const root = document.getElementById('app');
  if (!root) return;
  // Wpisy warstw sprzed przeładowania strony nie mają już swoich arkuszy.
  await historyLeaveOrphanLayers();
  root.textContent = '';
  root.classList.remove('is-booting');
  render(h(App, null), root);
  startSync().catch(() => undefined);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  idle(prefetchModules);
}

boot().catch((error) => console.error(error));
