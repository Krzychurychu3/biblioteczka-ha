// Klient REST API Biblioteczki. Wszystkie adresy są względne (rozwiązywane względem
// `<base href>` = ścieżka Ingress), więc działa zarówno w Home Assistant, jak i lokalnie.
//
//   await api.get('api/state')
//   await api.post('api/books', {draft})            → {id, revision}
//   await api.put('api/books/5', {draft})
//   await api.del('api/series/3?withBooks=1')
//   await api.upload('api/covers', blob, 'image/jpeg') → {coverId}
//   await api.state()                                → snapshot albo null (bez zmian, 304)
//
// Błędy: wyjątek ApiError z polskim `message` (z serwera albo ogólnym), `status` i `code`.

const NETWORK_MESSAGE = 'Brak połączenia z Home Assistant.';
const DEFAULT_TIMEOUT = 30000;

const STATUS_MESSAGES = {
  401: 'Sesja Home Assistant wygasła. Odśwież stronę.',
  403: 'Brak dostępu do Biblioteczki.',
  404: 'Nie znaleziono – możliwe, że ktoś właśnie to usunął.',
  409: 'Nie można zapisać – dane się ze sobą kłócą.',
  413: 'Plik jest za duży.',
  415: 'Nieobsługiwany format pliku.',
  502: 'Biblioteczka nie odpowiada. Spróbuj ponownie za chwilę.',
  503: 'Biblioteczka nie odpowiada. Spróbuj ponownie za chwilę.',
  504: 'Biblioteczka nie odpowiada. Spróbuj ponownie za chwilę.',
};

/** Błąd wywołania API z komunikatem po polsku. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }

  /** Brak połączenia albo przekroczony czas (a nie odmowa serwera). */
  get isNetwork() {
    return this.code === 'network' || this.code === 'timeout';
  }
}

function readDataset(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const value = document.documentElement.dataset[name];
  return value === undefined || value.startsWith('{{') ? fallback : value;
}

/** Tryb deweloperski (atrybut `data-dev` na <html>). */
export const DEV_MODE = readDataset('dev', 'false') === 'true';
/** Wersja aplikacji, z którą wczytano stronę (`data-version`). */
export const APP_VERSION = readDataset('version', '');

/** Pełny adres zasobu względem `<base href>` (np. do linku pobierania CSV). */
export function apiUrl(path) {
  return new URL(path, document.baseURI).href;
}

function linkSignals(signal, timeout) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout) : 0;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function parseBody(response) {
  if (response.status === 204 || response.status === 304) return null;
  const type = response.headers.get('Content-Type') || '';
  if (type.includes('json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return response.text();
}

/**
 * Wywołanie API. `options`: `body` (obiekt → JSON; Blob/ArrayBuffer/string → surowo),
 * `contentType`, `headers`, `signal`, `timeout` (ms, domyślnie 30 s, 0 = bez limitu).
 * Zwraca `{status, data, headers}`; rzuca ApiError (z wyjątkiem 304).
 */
export async function request(method, path, options = {}) {
  const { body, contentType, headers = {}, signal, timeout = DEFAULT_TIMEOUT } = options;
  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
    credentials: 'same-origin',
    cache: 'no-store',
  };
  if (body !== undefined && body !== null) {
    const raw = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || typeof body === 'string';
    init.body = raw ? body : JSON.stringify(body);
    init.headers['Content-Type'] = contentType || (raw ? (body.type || 'application/octet-stream') : 'application/json');
  }
  const link = linkSignals(signal, timeout);
  init.signal = link.signal;

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    link.done();
    if (signal?.aborted) throw error;
    if (link.timedOut()) {
      throw new ApiError('Serwer Biblioteczki nie odpowiada. Spróbuj ponownie.', { code: 'timeout' });
    }
    throw new ApiError(NETWORK_MESSAGE, { code: 'network' });
  }

  let data;
  try {
    data = await parseBody(response);
  } catch (error) {
    link.done();
    if (signal?.aborted) throw error;
    throw new ApiError(NETWORK_MESSAGE, { code: 'network', status: response.status });
  }
  link.done();

  if (!response.ok && response.status !== 304) {
    const serverMessage = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : null;
    const message =
      serverMessage ||
      STATUS_MESSAGES[response.status] ||
      (response.status >= 500 ? 'Wystąpił nieoczekiwany błąd.' : 'Nie udało się wykonać operacji.');
    throw new ApiError(message, {
      status: response.status,
      code: (data && data.code) || `http_${response.status}`,
      data,
    });
  }
  return { status: response.status, data, headers: response.headers };
}

let stateEtag = null;

export const api = {
  async get(path, options) {
    return (await request('GET', path, options)).data;
  },
  async post(path, body, options = {}) {
    return (await request('POST', path, { ...options, body })).data;
  },
  async put(path, body, options = {}) {
    return (await request('PUT', path, { ...options, body })).data;
  },
  async del(path, body, options = {}) {
    return (await request('DELETE', path, { ...options, body })).data;
  },
  /** Surowe wysłanie pliku/obrazu (np. okładka, zdjęcie kodu, CSV). */
  async upload(path, blob, contentType, options = {}) {
    return (await request('POST', path, { ...options, body: blob, contentType: contentType || blob.type })).data;
  },
  /**
   * Stan biblioteczki z obsługą ETag: zwraca snapshot albo `null`, gdy od ostatniego
   * pobrania nic się nie zmieniło (304). `force` pomija ETag.
   */
  async state({ force = false, signal } = {}) {
    const headers = {};
    if (stateEtag && !force) headers['If-None-Match'] = stateEtag;
    const result = await request('GET', 'api/state', { headers, signal, timeout: 20000 });
    if (result.status === 304) return null;
    stateEtag = result.headers.get('ETag');
    return result.data;
  },
  url: apiUrl,
};

export default api;
