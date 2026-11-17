// Skaner kodów kreskowych (iOS ISBNScannerView + ManualISBNSection), warstwami:
// 1) podgląd z aparatu na żywo (tylko w bezpiecznym kontekście – HTTPS): natywny BarcodeDetector
//    z EAN-13 albo leniwie wczytany ponyfill (zxing-wasm z naszego serwera);
// 2) zdjęcie kodu (zawsze): dekodowanie w przeglądarce, a gdy się nie uda – na serwerze;
// 3) ręczne wpisanie numeru ISBN.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { api } from '../api.js';
import { getLibrary } from '../store.js';
import {
  Button,
  Icon,
  ListButton,
  ListSection,
  Note,
  Sheet,
  Spinner,
  TextField,
  Viewfinder,
  haptic,
  openSheet,
} from '../ui/index.js';
import {
  SCANNER_UNAVAILABLE,
  classifyCameraError,
  detectorFailedNote,
  manualIsbnState,
  pickBarcode,
  scanHint,
  serverBarcodeResult,
  createScanFilter,
} from './logic.js';
import { ImageError, MIN_IMAGE_SIDE, canvasToJpeg, decodeImage, drawToCanvas, pickImage } from './media.js';
import { openBookEditor } from './book-editor.js';
import { ensureEditorStyles } from './shared.js';

const SCAN_INTERVAL = 200;
const HINT_DURATION = 4000;
const PHOTO_MAX_SIDE = 2000;
const WASM_PATH = 'static/vendor/zxing-wasm/zxing_reader.wasm';

const DEFAULT_HINT = 'Skieruj aparat na kod kreskowy z tyłu książki';
const NOTHING_FOUND =
  'Nie widzę kodu kreskowego na tym zdjęciu. Zrób zdjęcie z bliska, przy dobrym świetle – albo wpisz numer ISBN.';

// ---------------------------------------------------------------------------
// Dekoder kodów
// ---------------------------------------------------------------------------

let detectorPromise = null;

async function createDetector() {
  const Native = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
  if (typeof Native === 'function') {
    try {
      const formats = await Native.getSupportedFormats();
      if (Array.isArray(formats) && formats.includes('ean_13')) return new Native({ formats: ['ean_13'] });
    } catch {
      // Interfejs jest, ale platforma go nie obsługuje – zostaje ponyfill.
    }
  }
  const module = await import('../../vendor/barcode-detector/ponyfill.js');
  const wasmUrl = new URL(WASM_PATH, document.baseURI).href;
  // Plik wasm z naszego serwera (domyślnie biblioteka pobrałaby go z CDN).
  await module.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  return new module.BarcodeDetector({ formats: ['ean_13'] });
}

/** Dekoder EAN-13 (tworzony raz; po błędzie następne wywołanie próbuje od nowa). */
export function getDetector() {
  if (!detectorPromise) {
    detectorPromise = createDetector();
    detectorPromise.catch((error) => {
      console.warn('Nie udało się uruchomić rozpoznawania kodów', error);
      detectorPromise = null;
    });
  }
  return detectorPromise;
}

async function detectValues(detector, source) {
  try {
    const codes = await detector.detect(source);
    return (codes || []).map((c) => c.rawValue).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Rozpoznaje kod na zdjęciu: najpierw w przeglądarce, potem (gdy `serverFallback`) na serwerze.
 * Zwraca `{kind: 'book', isbn}` | `{kind: 'magazine'|'other'}` | `{kind: 'none'}`.
 */
export async function decodeBarcodePhoto(file, { serverFallback = false } = {}) {
  let image = null;
  try {
    image = await decodeImage(file);
  } catch {
    image = null;
  }
  let upload = null;
  if (image) {
    try {
      if (image.width < MIN_IMAGE_SIDE || image.height < MIN_IMAGE_SIDE) return { kind: 'none' };
      const canvas = drawToCanvas(image, PHOTO_MAX_SIDE);
      const detector = await getDetector().catch(() => null);
      if (detector) {
        const pick = pickBarcode(await detectValues(detector, canvas));
        if (pick) return pick;
      }
      if (serverFallback) upload = await canvasToJpeg(canvas, 0.9);
    } finally {
      image.close();
    }
  } else if (serverFallback && /^image\/(jpeg|png|webp)$/.test(file.type || '')) {
    upload = file;
  }
  if (upload) {
    const response = await api.upload('api/barcode', upload, upload.type || 'image/jpeg', { timeout: 60000 });
    return serverBarcodeResult(response);
  }
  if (!image) throw new ImageError('Nie udało się odczytać tego zdjęcia.', 'decode');
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Aparat
// ---------------------------------------------------------------------------

async function openCamera() {
  const media = navigator.mediaDevices;
  const preferred = {
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  };
  let stream;
  try {
    stream = await media.getUserMedia(preferred);
  } catch (error) {
    if (error?.name !== 'OverconstrainedError') throw error;
    stream = await media.getUserMedia({ audio: false, video: true });
  }
  // Ciągłe ustawianie ostrości, jeśli aparat to umie (kody z bliska).
  const [track] = stream.getVideoTracks();
  try {
    const caps = track?.getCapabilities?.();
    if (caps && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch {
    // Bez ustawień ostrości też działa.
  }
  return stream;
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ścieżka już zatrzymana.
    }
  }
}

function initialMode() {
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure';
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media || typeof media.getUserMedia !== 'function') return 'unsupported';
  return 'checking';
}

// ---------------------------------------------------------------------------
// Ręczne wpisanie numeru
// ---------------------------------------------------------------------------

/** Sekcja „Numer ISBN” (iOS ManualISBNSection). `onSubmit(isbn)` – poprawny numer. */
export function ManualIsbnSection({ autofocus = false, onSubmit }) {
  const [text, setText] = useState('');
  const state = manualIsbnState(text);
  const submit = () => {
    if (state.isbn) onSubmit?.(state.isbn);
  };
  const footer = state.mistyped
    ? html`<${Note} icon="warning" tone="warning" className="is-strong">${state.footer}<//>`
    : state.footer;
  return html`<${ListSection} header="Numer ISBN" footer=${footer}>
    <${TextField}
      value=${text}
      onInput=${setText}
      placeholder="Np. 978-83-7578-063-5"
      ariaLabel="Numer ISBN"
      size="title"
      mono
      autocapitalize="characters"
      enterKeyHint="search"
      autofocus=${autofocus}
      onEnter=${submit}
      className="scanner-manual"
    />
    <${ListButton} icon="search" label="Szukaj książki" disabled=${!state.isbn} onClick=${submit} />
  <//>`;
}

function openManualSheet(onSubmit, onClose) {
  return openSheet(
    ({ close }) => html`<${Sheet} title="Wpisz ISBN">
      <${ManualIsbnSection}
        autofocus
        onSubmit=${(isbn) => {
          close();
          onSubmit(isbn);
        }}
      />
    <//>`,
    { size: 'medium', onClose },
  );
}

// ---------------------------------------------------------------------------
// Skaner
// ---------------------------------------------------------------------------

/**
 * Otwiera skaner. Po rozpoznaniu lub wpisaniu numeru zamyka się i wywołuje `onIsbn(isbn)`;
 * bez `onIsbn` otwiera edytor nowej książki z tym numerem (od razu szuka danych).
 */
export function openScanner({ onIsbn } = {}) {
  ensureEditorStyles();
  return openSheet(({ close }) => {
    const deliver = (isbn) => {
      close();
      if (typeof onIsbn === 'function') onIsbn(isbn);
      else openBookEditor({ scannedIsbn: isbn.digits });
    };
    return html`<${Scanner} close=${close} onResult=${deliver} />`;
  });
}

function Scanner({ close, onResult }) {
  const [mode, setMode] = useState(initialMode);
  const [deniedReason, setDeniedReason] = useState('permission');
  const [hint, setHintState] = useState(null);
  const [photo, setPhoto] = useState({ busy: false, message: null });
  const [detectorFailed, setDetectorFailed] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);

  const alive = useRef(true);
  const finished = useRef(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const pausedRef = useRef(false);
  const startToken = useRef(0);
  const filterRef = useRef(createScanFilter());
  const hintRef = useRef(null);
  const manualRef = useRef(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const showHint = (text) => {
    if (!text || hintRef.current === text) return;
    hintRef.current = text;
    haptic('warning');
    setHintState(text);
  };

  const stopCamera = () => {
    startToken.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    stopStream(stream);
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // Element już odłączony.
      }
      video.srcObject = null;
    }
  };

  const startCamera = async () => {
    if (!alive.current || finished.current) return;
    if (initialMode() !== 'checking') return;
    stopCamera();
    const token = startToken.current;
    setMode('checking');
    getDetector().catch(() => undefined);
    let stream;
    try {
      stream = await openCamera();
    } catch (error) {
      if (!alive.current || token !== startToken.current) return;
      const kind = classifyCameraError(error);
      if (kind === 'unsupported') setMode('unsupported');
      else {
        setDeniedReason(kind);
        setMode('denied');
      }
      return;
    }
    if (!alive.current || finished.current || token !== startToken.current) {
      stopStream(stream);
      return;
    }
    if (document.visibilityState === 'hidden') {
      stopStream(stream);
      pausedRef.current = true;
      return;
    }
    streamRef.current = stream;
    setMode('live');
    setStreamVersion((n) => n + 1);
  };

  const finish = (isbn) => {
    if (finished.current || !alive.current) return;
    finished.current = true;
    haptic('success');
    stopCamera();
    manualRef.current?.close();
    manualRef.current = null;
    onResult(isbn);
  };

  const cancel = () => {
    stopCamera();
    manualRef.current?.close();
    close();
  };

  // Start, sprzątanie, pauza w tle (iOS i tak odbiera aparat stronie w tle).
  useEffect(() => {
    alive.current = true;
    if (modeRef.current === 'checking') startCamera();
    else getDetector().catch(() => undefined);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (streamRef.current || modeRef.current === 'checking' || modeRef.current === 'live') {
          stopCamera();
          pausedRef.current = true;
          if (modeRef.current === 'live') setMode('checking');
        }
      } else if (pausedRef.current) {
        pausedRef.current = false;
        startCamera();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      stopCamera();
      manualRef.current?.close();
    };
  }, []);

  // Podgląd i pętla rozpoznawania (co ~200 ms, wynik po dwóch zgodnych odczytach).
  useEffect(() => {
    if (mode !== 'live') return undefined;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return undefined;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.srcObject = stream;
    video.play().catch(() => undefined);
    filterRef.current.reset();
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      if (cancelled) return;
      let detector = null;
      try {
        detector = await getDetector();
      } catch {
        detector = null;
      }
      if (cancelled) return;
      if (!detector) {
        setDetectorFailed(true);
        return;
      }
      setDetectorFailed(false);
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const values = await detectValues(detector, video);
        if (cancelled) return;
        const pick = filterRef.current.push(values);
        if (pick) {
          if (pick.kind === 'book') {
            finish(pick.isbn);
            return;
          }
          showHint(scanHint(pick.kind));
        }
      }
      timer = setTimeout(tick, SCAN_INTERVAL);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, streamVersion]);

  // Podpowiedź o złym kodzie znika po 4 s (od ostatniej zmiany treści).
  useEffect(() => {
    if (!hint) return undefined;
    const timer = setTimeout(() => {
      hintRef.current = null;
      setHintState(null);
    }, HINT_DURATION);
    return () => clearTimeout(timer);
  }, [hint]);

  const decodePhoto = async (camera) => {
    if (photo.busy) return;
    const file = await pickImage({ camera });
    if (!file || !alive.current || finished.current) return;
    setPhoto({ busy: true, message: null });
    let result;
    try {
      result = await decodeBarcodePhoto(file, { serverFallback: Boolean(getLibrary().meta?.barcodeServerDecode) });
    } catch (error) {
      if (alive.current) setPhoto({ busy: false, message: error?.message || 'Nie udało się odczytać tego zdjęcia.' });
      return;
    }
    if (!alive.current || finished.current) return;
    if (result.kind === 'book') {
      setPhoto({ busy: false, message: null });
      finish(result.isbn);
      return;
    }
    const message = result.kind === 'none' ? NOTHING_FOUND : scanHint(result.kind);
    setPhoto({ busy: false, message });
    if (result.kind !== 'none') haptic('warning');
  };

  const openManual = () => {
    if (manualRef.current || finished.current) return;
    // Zamknięcie arkusza (Anuluj, Esc, wstecz) zwalnia uchwyt.
    const handle = openManualSheet(finish, () => {
      if (manualRef.current === handle) manualRef.current = null;
    });
    manualRef.current = handle;
  };

  const live = mode === 'checking' || mode === 'live';

  if (live) {
    return html`<${Sheet} title="Skanuj kod kreskowy" variant="camera" onCancel=${cancel}>
      <div class="scanner">
        <video class="scanner-video" ref=${videoRef} muted autoplay playsinline aria-hidden="true"></video>
        <${Viewfinder} />
        ${mode === 'checking' && html`<div class="scanner-center"><${Spinner} size=${30} label="Uruchamiam aparat…" /></div>`}
        <div class="scanner-card">
          <div class=${`scanner-hint ${hint ? 'is-warning' : ''}`} role="status" aria-live="polite">
            ${Icon(hint ? 'warning' : 'barcode')}
            <div>
              <div>${hint || DEFAULT_HINT}</div>
              <div class="scanner-sub">Numer ISBN zaczyna się od 978 albo 979.</div>
            </div>
          </div>
          ${detectorFailed &&
          html`<${Note} icon="warning" tone="warning" className="scanner-photo-note">
            ${detectorFailedNote(Boolean(getLibrary().meta?.barcodeServerDecode))}
          <//>`}
          ${photo.message && html`<${Note} icon="warning" tone="warning" className="scanner-photo-note">${photo.message}<//>`}
          <div class="scanner-actions">
            <${Button} variant="bordered" size="l" icon="keyboard" full onClick=${openManual}>Wpisz ISBN ręcznie<//>
            <${Button} variant="plain" size="s" icon="photo" busy=${photo.busy} onClick=${() => decodePhoto(false)}>
              Rozpoznaj kod ze zdjęcia
            <//>
          </div>
        </div>
      </div>
    <//>`;
  }

  const info = SCANNER_UNAVAILABLE[mode === 'denied' ? deniedReason : mode] || SCANNER_UNAVAILABLE.unsupported;
  const photoFooter = photo.message
    ? html`<${Note} icon="warning" tone="warning" className="is-strong">${photo.message}<//>`
    : 'Zrób wyraźne zdjęcie kodu kreskowego z tyłu książki – rozpoznam z niego numer ISBN.';

  return html`<${Sheet} title="Skanuj kod kreskowy" onCancel=${cancel}>
    <${ListSection} label=${info.title}>
      <div class="cell scanner-unavailable">
        <h3 class="scanner-unavailable-title">${Icon(info.icon)}<span>${info.title}</span></h3>
        <p class="scanner-unavailable-text">${info.text}</p>
        ${mode === 'denied' &&
        html`<div><${Button} variant="plain" size="s" icon="refresh" onClick=${startCamera}>Spróbuj ponownie<//></div>`}
      </div>
    <//>
    <${ListSection} header="Zdjęcie kodu" footer=${photoFooter}>
      <div class="cell scanner-photo-buttons">
        <${Button} variant="bordered" icon="camera" busy=${photo.busy} onClick=${() => decodePhoto(true)}>Zrób zdjęcie kodu<//>
        <${Button} variant="bordered" icon="photo" disabled=${photo.busy} onClick=${() => decodePhoto(false)}>Wybierz zdjęcie<//>
      </div>
    <//>
    <${ManualIsbnSection} autofocus=${mode === 'unsupported'} onSubmit=${finish} />
  <//>`;
}
