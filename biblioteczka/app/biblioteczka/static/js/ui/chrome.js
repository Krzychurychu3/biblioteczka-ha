// Pasek nawigacji ekranu (tytuł, przyciski po bokach) ustawiany przez sam ekran.
//
// Ekran wywołuje w renderze `useChrome({title, leading, trailing, largeTitle})`;
// app.js rysuje pasek i duży tytuł aktywnego ekranu. Klucz pominięty (`undefined`)
// zostawia domyślną wartość z app.js, `null` usuwa element.

import { createContext, useContext, useEffect, useLayoutEffect, useReducer } from '../../vendor/preact-htm.js';

/** Kontekst ekranu: `{key: ścieżka trasy, active: czy ekran jest widoczny}`. */
export const ScreenContext = createContext({ key: '', active: true });

const chrome = new Map();
const versions = new Map();
const listeners = new Set();

function emit(key) {
  versions.set(key, (versions.get(key) || 0) + 1);
  for (const listener of listeners) listener(key);
}

/** Ustawia elementy paska dla ekranu o kluczu `key` (używane przez useChrome). */
export function setChrome(key, options) {
  chrome.set(key, options || {});
  emit(key);
}

export function clearChrome(key) {
  if (chrome.delete(key)) emit(key);
}

export function getChrome(key) {
  return chrome.get(key) || null;
}

/**
 * Hook ekranu: tytuł i przyciski paska nawigacji.
 * useChrome({title, largeTitle = true, leading, trailing, backLabel})
 * - `title` – tytuł ekranu (duży na górze treści, mały w pasku po przewinięciu);
 * - `leading` / `trailing` – elementy po lewej (za przyciskiem wstecz) i po prawej;
 * - `largeTitle: false` – tylko mały tytuł w pasku.
 */
export function useChrome(options) {
  const { key } = useContext(ScreenContext);
  useLayoutEffect(() => {
    setChrome(key, options);
  });
  useEffect(() => () => clearChrome(key), [key]);
}

/** Hook app.js: przerysowuje się, gdy ekran `key` zmieni swój pasek. */
export function useChromeFor(key) {
  const [, force] = useReducer((n) => n + 1, 0);
  const seen = versions.get(key) || 0;
  useEffect(() => {
    const listener = (changed) => {
      if (changed === key) force();
    };
    listeners.add(listener);
    // Ekran mógł ustawić pasek po naszym renderze, a przed subskrypcją.
    if ((versions.get(key) || 0) !== seen) force();
    return () => listeners.delete(listener);
  }, [key]);
  return getChrome(key);
}

/** Czy ekran wywołujący jest teraz widoczny (karty w tle pozostają zamontowane). */
export function useScreenActive() {
  return useContext(ScreenContext).active;
}
