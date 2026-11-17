// Globalny host warstw: arkusze (Sheet), dialogi i menu rysowane nad aplikacją.
//
// openSheet(render, opts) → {id, close}; `render({close})` zwraca zawartość
// (zwykle `<${Sheet} …>`). Warstwy modalne dostają własny wpis w historii
// przeglądarki, blokują tło (`inert`), pułapkują fokus i zamykają się klawiszem Esc.

import {
  createContext,
  h,
  html,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from '../../vendor/preact-htm.js';
import { historyPopLayer, historyPushLayer, onHistoryPop } from './history.js';

const CLOSE_MS = 260;

let layers = [];
let nextId = 1;
const listeners = new Set();
// Licznik zmian układu (app.js: noteLayoutSwitch) – warstwa zapamiętuje go przy otwarciu.
let layoutEpoch = 0;

function emit() {
  for (const listener of listeners) listener();
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Element, do którego wróci fokus. Gdy fokus jest jeszcze w zamykanej warstwie
// (np. pozycja menu, które otworzyło arkusz), dziedziczymy jej element otwierający.
function currentOpener() {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  const host = active && active.closest ? active.closest('[data-layer]') : null;
  if (host) {
    const owner = layers.find((l) => String(l.id) === host.dataset.layer);
    if (owner && owner.closing) return owner.opener;
  }
  return active;
}

/**
 * Otwiera warstwę. `kind`: 'sheet' | 'dialog' | 'menu' | inny (klasa CSS `layer-<kind>`).
 * `modal` (domyślnie true poza menu) blokuje tło i dodaje wpis w historii.
 * `size` (np. 'medium') trafia do klasy `size-<size>`. `onClose(result)` po zamknięciu.
 * `dismissOnBackdrop` – kliknięcie w przyciemnione tło zamyka warstwę.
 */
export function openLayer({
  kind = 'sheet',
  render,
  modal = kind !== 'menu',
  size = 'full',
  onClose,
  dismissOnBackdrop = kind !== 'sheet',
  className = '',
} = {}) {
  const id = nextId++;
  const layer = {
    id,
    kind,
    render,
    modal,
    size,
    onClose,
    dismissOnBackdrop,
    className,
    closing: false,
    opener: currentOpener(),
    layoutEpoch,
    escape: null,
    historyToken: null,
  };
  if (modal && typeof history !== 'undefined') layer.historyToken = historyPushLayer(id);
  layers = [...layers, layer];
  emit();
  return { id, close: (result) => closeLayer(id, result) };
}

/** Zamyka warstwę o danym id (z animacją). */
export function closeLayer(id, result, { fromHistory = false } = {}) {
  const layer = layers.find((l) => l.id === id);
  if (!layer || layer.closing) return;
  layer.closing = true;
  if (!fromHistory) historyPopLayer(layer.historyToken);
  layers = [...layers];
  emit();
  restoreFocus(layer);
  const finish = () => {
    layers = layers.filter((l) => l !== layer);
    emit();
    try {
      layer.onClose?.(result);
    } catch (error) {
      console.error(error);
    }
  };
  if (prefersReducedMotion()) finish();
  else setTimeout(finish, CLOSE_MS);
}

// app.js: dokąd przenieść fokus, gdy element otwierający warstwę zniknął (np. usunięty wiersz albo
// ekrany zamontowane od nowa po zmianie układu). Dostaje `{layoutSwitched}` – czy układ zmienił się,
// kiedy warstwa była otwarta. Bez niej – nic.
let focusFallback = null;

/** Ustawia (albo usuwa – `null`) zastępczy cel fokusu po zamknięciu warstwy. */
export function setFocusFallback(fn) {
  focusFallback = typeof fn === 'function' ? fn : null;
}

/** app.js: układ (dwa panele ↔ wąski) właśnie się zmienił – ekrany zostaną zamontowane od nowa. */
export function noteLayoutSwitch() {
  layoutEpoch += 1;
}

/**
 * Po zmianie danych (np. usunięty wiersz) – jeśli fokus spadł na <body>, przenieś go na tytuł
 * panelu. Warunki sprawdza sam cel zastępczy; w wąskim układzie nic nie robi.
 */
export function refocusIfLost() {
  if (!focusFallback || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => focusFallback && focusFallback({ layoutSwitched: false }));
}

function canFocus(opener) {
  return Boolean(opener) && typeof opener.focus === 'function' && opener.isConnected;
}

function restoreFocus(layer) {
  const opener = layer.opener;
  if (!canFocus(opener) && !focusFallback) return;
  // Fokus wraca dopiero, gdy tło przestanie być `inert` (po przerysowaniu).
  requestAnimationFrame(() => {
    const coveredByNewer = layers.some((l) => !l.closing && l.id > layer.id && l.modal);
    if (coveredByNewer) return;
    if (!canFocus(opener)) {
      // Zmiana układu sprawdzana dopiero tutaj: menu zamyka się przy zmianie rozmiaru okna, zanim
      // app.js przełączy układ.
      if (focusFallback) focusFallback({ layoutSwitched: layer.layoutEpoch !== layoutEpoch });
      return;
    }
    if (opener.closest('[inert]')) return;
    opener.focus({ preventScroll: true });
  });
}

/** Otwiera arkusz. `render({close})` zwraca zawartość arkusza. */
export function openSheet(render, { size = 'full', onClose, className } = {}) {
  return openLayer({ kind: 'sheet', render, size, onClose, className });
}

/** Zamyka wskazany arkusz (handle albo id) albo najwyższy otwarty. */
export function closeSheet(handle) {
  if (handle != null) {
    closeLayer(typeof handle === 'object' ? handle.id : handle);
    return;
  }
  const top = [...layers].reverse().find((l) => l.kind === 'sheet' && !l.closing);
  if (top) closeLayer(top.id);
}

/** Zamyka wszystkie warstwy (np. po usunięciu danych). */
export function closeAllLayers() {
  for (const layer of [...layers].reverse()) closeLayer(layer.id);
}

/** Czy jest otwarta jakakolwiek warstwa modalna. */
export function hasOpenModal() {
  return layers.some((l) => l.modal && !l.closing);
}

/** Czy jest otwarta jakakolwiek warstwa, także niemodalne menu. */
export function hasOpenLayer() {
  return layers.some((l) => !l.closing);
}

// Systemowe „wstecz” zamyka warstwy otwarte później niż wpis, na który wróciliśmy.
if (typeof window !== 'undefined') {
  onHistoryPop(({ state, selection }) => {
    const keepUpTo = state && state.bibLayer ? state.bibLayer : 0;
    for (const layer of [...layers].reverse()) {
      if (layer.closing || !layer.historyToken || !layer.historyToken.pushed) continue;
      if (layer.id > keepUpTo) closeLayer(layer.id, undefined, { fromHistory: true });
    }
    // Menu nad zamkniętymi warstwami też znika – ale nie wtedy, gdy to tylko adres wyboru z listy
    // dogania widoczne już szczegóły (menu otwarte chwilę po strzałce zostaje).
    if (!selection && !hasOpenModal()) {
      for (const layer of layers) if (layer.kind === 'menu') closeLayer(layer.id);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const top = [...layers].reverse().find((l) => !l.closing);
    if (!top) return;
    event.preventDefault();
    if (top.escape) top.escape();
    else closeLayer(top.id);
  });
}

// ---------------------------------------------------------------------------
// Kontekst warstwy (dla Sheet, dialogów i menu)
// ---------------------------------------------------------------------------

export const LayerContext = createContext(null);

/** `{id, close, setEscape, closing}` bieżącej warstwy albo `null` poza warstwą. */
export function useLayer() {
  return useContext(LayerContext);
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Widoczne elementy, na które można przenieść fokus. */
export function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  );
}

function LayerContent({ render, api }) {
  return render(api);
}

function Layer({ layer, isTop, inert }) {
  const ref = useRef(null);
  const apiRef = useRef(null);
  if (!apiRef.current) {
    apiRef.current = {
      id: layer.id,
      kind: layer.kind,
      close: (result) => closeLayer(layer.id, result),
      setEscape: (fn) => {
        layer.escape = fn;
      },
    };
  }
  const api = apiRef.current;
  api.closing = layer.closing;

  // Fokus startowy: [data-autofocus], a gdy nic go nie przejęło – sama warstwa.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const frame = requestAnimationFrame(() => {
      if (root.contains(document.activeElement)) return;
      const preferred = root.querySelector('[data-autofocus]');
      const target = preferred || root.querySelector('[data-layer-focus]') || root;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const onKeyDown = (event) => {
    if (event.key !== 'Tab' || !isTop || layer.kind === 'menu') return;
    const items = focusableIn(ref.current);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !ref.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !ref.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const onBackdrop = () => {
    if (layer.dismissOnBackdrop) {
      if (layer.escape) layer.escape();
      else closeLayer(layer.id);
    }
  };

  const classes = [
    'layer',
    `layer-${layer.kind}`,
    `size-${layer.size}`,
    layer.closing ? 'is-closing' : '',
    layer.className,
  ].join(' ');

  return html`
    <div class=${classes} ref=${ref} tabindex="-1" inert=${inert} onKeyDown=${onKeyDown} data-layer=${layer.id}>
      <div class="layer-backdrop" onClick=${onBackdrop} aria-hidden="true"></div>
      <${LayerContext.Provider} value=${api}>
        ${h(LayerContent, { render: layer.render, api })}
      <//>
    </div>
  `;
}

/** Host wszystkich warstw – app.js renderuje go raz, obok powłoki aplikacji. */
export function OverlayHost({ shellSelector = '[data-app-shell]' }) {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);

  const open = layers.filter((l) => !l.closing);
  const topModal = [...open].reverse().find((l) => l.modal);
  const top = open[open.length - 1];
  const anyModal = Boolean(topModal);

  useLayoutEffect(() => {
    const shell = document.querySelector(shellSelector);
    if (shell) shell.inert = anyModal;
    document.documentElement.classList.toggle('has-modal', anyModal);
  }, [anyModal, shellSelector]);

  return html`
    <div class="overlay-host">
      ${layers.map((layer) =>
        h(Layer, {
          key: layer.id,
          layer,
          isTop: layer === top,
          inert: layer.closing || (layer.modal && topModal && layer !== topModal && layer.id < topModal.id),
        }),
      )}
    </div>
  `;
}
