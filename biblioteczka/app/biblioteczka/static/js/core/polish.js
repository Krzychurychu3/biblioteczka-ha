// Polska odmiana rzeczowników po liczebnikach: 1 książka, 2 książki, 5 książek (port `Polish` z Swift).
// Bliźniak modułu Python `biblioteczka/polish.py` – te same identyfikatory rzeczowników.
// Biernik (`countAccusative`) jest tylko tutaj: potrzebują go wyłącznie teksty interfejsu.

/** Formy (jedna / kilka / wiele) – identyfikatory jak przypadki `Polish.Noun` w Swift. */
export const NOUNS = Object.freeze({
  book: Object.freeze(['książka', 'książki', 'książek']),
  series: Object.freeze(['seria', 'serie', 'serii']),
  volume: Object.freeze(['tom', 'tomy', 'tomów']),
  author: Object.freeze(['autor', 'autorzy', 'autorów']),
});

/**
 * Formy w bierniku po czasowniku („Dodano…”, „Usuń serię i…”): „1 książkę”, „1 serię”, „2 autorów”.
 * Te same identyfikatory co `NOUNS`. W iOS zostaje tu mianownik („Dodano 1 książka”).
 */
export const NOUNS_ACCUSATIVE = Object.freeze({
  book: Object.freeze(['książkę', 'książki', 'książek']),
  series: Object.freeze(['serię', 'serie', 'serii']),
  volume: Object.freeze(['tom', 'tomy', 'tomów']),
  author: Object.freeze(['autora', 'autorów', 'autorów']),
});

function pick(table, n, noun) {
  const forms = Object.prototype.hasOwnProperty.call(table, noun) ? table[noun] : null;
  if (!forms) throw new Error(`Nieznany rzeczownik: ${noun}`);
  const [one, few, many] = forms;
  if (n === 1) return one;
  const lastDigit = n % 10;
  const lastTwoDigits = n % 100;
  if (n > 0 && lastDigit >= 2 && lastDigit <= 4 && !(lastTwoDigits >= 12 && lastTwoDigits <= 14)) return few;
  return many;
}

/**
 * Forma rzeczownika po liczbie `n` (bez liczby), np. `form(3, 'book')` → „książki”.
 * Liczby ujemne zawsze dają formę „wiele” – jak w Swift, gdzie reszta z dzielenia zachowuje znak.
 */
export function form(n, noun) {
  return pick(NOUNS, n, noun);
}

/** Liczba z odmienionym rzeczownikiem, np. `count(5, 'book')` → „5 książek”. */
export function count(n, noun) {
  return `${n} ${form(n, noun)}`;
}

/** Forma w bierniku po liczbie `n` (bez liczby), np. `formAccusative(1, 'book')` → „książkę”. */
export function formAccusative(n, noun) {
  return pick(NOUNS_ACCUSATIVE, n, noun);
}

/** Liczba z rzeczownikiem w bierniku, np. `countAccusative(1, 'book')` → „1 książkę”. */
export function countAccusative(n, noun) {
  return `${n} ${formAccusative(n, noun)}`;
}
