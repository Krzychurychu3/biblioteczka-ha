// Stan ekranu, który przeżywa odmontowanie ekranu – jak `@State` w korzeniu NavigationStack w iOS.
//
// Każda karta pokazuje tylko swój najwyższy ekran, więc wejście w szczegóły (np. `#/szukaj/seria/5`)
// odmontowuje korzeń karty. Zapytanie wyszukiwania i filtr serii trzymamy więc w pamięci modułu,
// a nie w adresie: zmiana adresu przy każdej literze tworzyłaby ekran od nowa (pole traciłoby
// fokus). Pamięć trwa do przeładowania strony – po nim ekrany startują od wartości domyślnych.
//
//   const [query, setQuery] = useRetainedState('szukaj.query', '');

import { useCallback, useState } from '../../vendor/preact-htm.js';

const retained = new Map();

/** Zapamiętana wartość dla klucza albo `fallback` (funkcja – wywoływana tylko w razie braku). */
export function retainedValue(key, fallback) {
  if (retained.has(key)) return retained.get(key);
  return typeof fallback === 'function' ? fallback() : fallback;
}

/** Zapamiętuje wartość dla klucza. */
export function retainValue(key, value) {
  retained.set(key, value);
}

/** Zapomina jedną wartość (z kluczem) albo wszystkie (bez klucza). */
export function forgetRetained(key) {
  if (key === undefined) retained.clear();
  else retained.delete(key);
}

/**
 * Jak `useState`, ale wartość zostaje zapamiętana pod kluczem `key` i wraca po ponownym
 * zamontowaniu ekranu. Setter przyjmuje wartość albo funkcję `(poprzednia) => nowa`.
 */
export function useRetainedState(key, initial) {
  const [value, setValue] = useState(() => retainedValue(key, initial));
  const set = useCallback(
    (next) => {
      const resolved = typeof next === 'function' ? next(retainedValue(key, initial)) : next;
      retainValue(key, resolved);
      setValue(resolved);
    },
    [key],
  );
  return [value, set];
}
