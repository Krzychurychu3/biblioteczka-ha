// Obrazy po stronie przeglądarki: wczytanie zdjęcia (także HEIC tam, gdzie przeglądarka umie),
// zmniejszenie na płótnie i zapis jako JPEG, wysłanie okładki na serwer, wybór pliku z aparatu/galerii.

import { api } from '../api.js';
import { fitWithin } from './logic.js';

/** Najdłuższy bok zdjęcia okładki wysyłanego na serwer (serwer i tak zmniejsza do 900 px). */
export const COVER_UPLOAD_MAX = 1800;
/** Najmniejszy sensowny obraz (mniejszy jest pomijany bez komunikatu – jak w iOS). */
export const MIN_IMAGE_SIDE = 40;

/** Błąd wczytania obrazu z polskim komunikatem. */
export class ImageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

function decodeWithImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageError('Nie udało się odczytać tego zdjęcia.', 'decode'));
    };
    img.src = url;
  });
}

/**
 * Dekoduje plik obrazu: `createImageBitmap` (z orientacją EXIF), a gdy go brak lub zawiedzie –
 * element `<img>`. Zwraca `{source, width, height, close()}`.
 */
export async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {
      // Starsze przeglądarki nie znają opcji albo formatu – spróbujemy przez <img>.
    }
  }
  const img = await decodeWithImageElement(blob);
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
}

/** Rysuje zdekodowany obraz na płótnie o dłuższym boku ≤ `maxSide`. */
export function drawToCanvas(image, maxSide) {
  const size = fitWithin(image.width, image.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new ImageError('Ta przeglądarka nie umie przetworzyć zdjęcia.', 'canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.source, 0, 0, size.width, size.height);
  return canvas;
}

/** Płótno → JPEG (Blob). */
export function canvasToJpeg(canvas, quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageError('Nie udało się przygotować zdjęcia.', 'encode'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Plik ze zdjęciem → JPEG gotowy do wysłania (dłuższy bok ≤ `maxSide`, jakość 0,9).
 * Zwraca `null` dla obrazów mniejszych niż 40×40 px.
 */
export async function imageFileToJpeg(file, { maxSide = COVER_UPLOAD_MAX, quality = 0.9 } = {}) {
  const image = await decodeImage(file);
  try {
    if (image.width < MIN_IMAGE_SIDE || image.height < MIN_IMAGE_SIDE) return null;
    const canvas = drawToCanvas(image, maxSide);
    return await canvasToJpeg(canvas, quality);
  } finally {
    image.close();
  }
}

/**
 * Zapisuje zdjęcie okładki na serwerze → `coverId` albo `null` (obraz za mały).
 * Rzuca ImageError / ApiError z polskim komunikatem.
 */
export async function uploadCover(file) {
  const jpeg = await imageFileToJpeg(file);
  if (!jpeg) return null;
  const result = await api.upload('api/covers', jpeg, 'image/jpeg', { timeout: 60000 });
  return result && typeof result.coverId === 'string' ? result.coverId : null;
}

/**
 * Otwiera systemowy wybór zdjęcia. `camera: true` – od razu aparat (`capture="environment"`,
 * na komputerze zwykły wybór pliku). Promise z plikiem albo `null` (anulowano).
 * Wywoływać bezpośrednio w obsłudze kliknięcia (wymóg przeglądarek).
 */
let pendingPicker = null;

export function pickImage({ camera = false } = {}) {
  // Poprzedni, nierozstrzygnięty wybór (przeglądarka bez zdarzenia „cancel”) już się nie odezwie.
  pendingPicker?.(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttribute('capture', 'environment');
    input.className = 'visually-hidden';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      if (pendingPicker === finish) pendingPicker = null;
      input.remove();
      resolve(file || null);
    };
    pendingPicker = finish;
    // iOS potrafi długo konwertować HEIC przed „change”, więc nie zgadujemy anulowania po fokusie.
    input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    // Element musi być w dokumencie (Safari) i poza `inert`, więc trafia na koniec <body>.
    document.body.appendChild(input);
    input.click();
  });
}

/** Czy urządzenie wygląda na telefon/tablet z aparatem (wtedy pokazujemy „Zrób zdjęcie…”). */
export function likelyHasCamera() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches;
}
