// Klucze tekstowe do porównywania i wyszukiwania nazw – port `TextMatching.swift`.
// Bliźniak modułu Python `biblioteczka/textmatch.py`: te same reguły i wspólne wektory testowe
// (`tests/vectors/textmatch.json`). Szczegóły zgodności ze Swift/Foundation opisuje docstring modułu Python.
// Moduł jest czysty (bez DOM), więc działa też w Node.

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const cp = (ch) => ch.codePointAt(0);
const chr = (...codes) => String.fromCodePoint(...codes);

// Białe znaki Unicode (White_Space) – jak Swift `Character.isWhitespace` (bez U+001C–U+001F).
const WHITESPACE = new Set([
  ...range(0x09, 0x0d), 0x20, 0x85, 0xa0, 0x1680, ...range(0x2000, 0x200a),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// Znaki Mc, które nie doklejają się do poprzedniego grafemu (wyjątki od SpacingMark w UAX #29).
const MC_NOT_SPACING = new Set([
  0x102b, 0x102c, 0x1038, 0x1062, 0x1063, 0x1064, ...range(0x1067, 0x106d), 0x1083,
  ...range(0x1087, 0x108c), 0x108f, 0x109a, 0x109b, 0x109c, 0x1a61, 0x1a63, 0x1a64,
  0xaa7b, 0xaa7d, 0x11720, 0x11721,
]);

// Znaki Mc z właściwością Grapheme_Extend (stan Unicode 17) – Foundation usuwa je jak znaki diakrytyczne.
const MC_EXTEND = new Set([
  0x09be, 0x09d7, 0x0b3e, 0x0b57, 0x0bbe, 0x0bd7, 0x0cc0, 0x0cc2, 0x0cc7, 0x0cc8,
  0x0cca, 0x0ccb, 0x0cd5, 0x0cd6, 0x0d3e, 0x0d57, 0x0dcf, 0x0ddf, 0x1715, 0x1734,
  0x1b35, 0x1b3b, 0x1b3d, 0x1b43, 0x1b44, 0x1baa, 0x1bf2, 0x1bf3, 0x302e, 0x302f,
  0xa953, 0xa9c0, 0x111c0, 0x11235, 0x1133e, 0x1134d, 0x11357, 0x113b8, 0x113c2,
  0x113c5, 0x113c7, 0x113c8, 0x113c9, 0x113cf, 0x114b0, 0x114bd, 0x115af, 0x116b6,
  0x11930, 0x1193d, 0x11f41, 0x16ff0, 0x16ff1, 0x1d165, 0x1d166, ...range(0x1d16d, 0x1d172),
]);

// Znaki, które starsze bazy Unicode mają jako Mn, a obecnie są zwykłymi Mc (bez Grapheme_Extend).
const NOW_SPACING_MC = new Set([0x1171e]);

// Znaki spoza kategorii M, które też „rozszerzają” grafem: ZWNJ, półszerokie znaki dźwięczności, tagi.
const OTHER_EXTEND = new Set([0x200c, 0xff9e, 0xff9f, ...range(0xe0020, 0xe007f)]);

// Znaki Cf, które nie są „Control” w UAX #29: ZWNJ, ZWJ i znaki Prepend.
const CF_NOT_CONTROL = new Set([
  0x200c, 0x200d, ...range(0x0600, 0x0605), 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd,
]);

// Pełne składanie wielkości liter tam, gdzie Foundation odchodzi od zwykłych małych liter
// (ß → ss, ligatury, greckie warianty liter). Cherokee i U+1C80–U+1C88 zostają jak przy małych literach.
const FOLD_EXCEPTIONS = new Map(
  [
    [0x00b5, [0x03bc]], [0x00df, [0x73, 0x73]], [0x0149, [0x02bc, 0x6e]], [0x017f, [0x73]],
    [0x0345, [0x03b9]], [0x03c2, [0x03c3]], [0x03d0, [0x03b2]], [0x03d1, [0x03b8]], [0x03d5, [0x03c6]],
    [0x03d6, [0x03c0]], [0x03f0, [0x03ba]], [0x03f1, [0x03c1]], [0x03f5, [0x03b5]],
    [0x0587, [0x0565, 0x0582]], [0x1e9a, [0x61, 0x02be]], [0x1e9e, [0x73, 0x73]],
    [0xfb00, [0x66, 0x66]], [0xfb01, [0x66, 0x69]], [0xfb02, [0x66, 0x6c]], [0xfb03, [0x66, 0x66, 0x69]],
    [0xfb04, [0x66, 0x66, 0x6c]], [0xfb05, [0x73, 0x74]], [0xfb06, [0x73, 0x74]],
    [0xfb13, [0x0574, 0x0576]], [0xfb14, [0x0574, 0x0565]], [0xfb15, [0x0574, 0x056b]],
    [0xfb16, [0x057e, 0x0576]], [0xfb17, [0x0574, 0x056d]],
  ].map(([from, to]) => [chr(from), chr(...to)]),
);

// Granica alfabetów łacińskiego, greckiego i cyrylicy w CoreFoundation („Roman, Greek, Cyrillic”).
const LGC_LIMIT = 0x0510;
// Tryby usuwania znaków niebazowych po znaku bazowym.
const STRIP_ALL = 0;
const STRIP_LOW = 1;
const STRIP_NONE = 2;

const RE_EXTEND_CAT = /^[\p{Mn}\p{Me}]$/u;
const RE_MC = /^\p{Mc}$/u;
const RE_CONTROL = /^[\p{Cc}\p{Zl}\p{Zp}]$/u;
const RE_CF = /^\p{Cf}$/u;
const RE_SO = /^\p{So}$/u;
const RE_LETTER_OR_NUMBER = /^[\p{Alphabetic}\p{N}]$/u;

const IOTA_SUBSCRIPT = chr(0x0345); // jedyny znak o klasie łączenia 240 (najwyższej)
const CR = '\r';
const LF = '\n';
const SMALL_L_STROKE = chr(0x0142);

/** Postać NFC tekstu (null/undefined przechodzą bez zmian). */
export function nfc(s) {
  return s == null ? s : String(s).normalize('NFC');
}

function isAscii(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function isExtend(o) {
  if (OTHER_EXTEND.has(o) || MC_EXTEND.has(o)) return true;
  return !NOW_SPACING_MC.has(o) && RE_EXTEND_CAT.test(chr(o));
}

function isControl(ch) {
  if (RE_CONTROL.test(ch)) return true;
  const o = cp(ch);
  return RE_CF.test(ch) && !CF_NOT_CONTROL.has(o) && !(o >= 0xe0020 && o <= 0xe007f);
}

function hangulType(o) {
  if ((o >= 0x1100 && o <= 0x115f) || (o >= 0xa960 && o <= 0xa97c)) return 'L';
  if ((o >= 0x1160 && o <= 0x11a7) || (o >= 0xd7b0 && o <= 0xd7c6)) return 'V';
  if ((o >= 0x11a8 && o <= 0x11ff) || (o >= 0xd7cb && o <= 0xd7fb)) return 'T';
  if (o >= 0xac00 && o <= 0xd7a3) return (o - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  return null;
}

const HANGUL_JOINS = {
  L: ['L', 'V', 'LV', 'LVT'],
  LV: ['V', 'T'],
  V: ['V', 'T'],
  LVT: ['T'],
  T: ['T'],
};

const isRegionalIndicator = (o) => o >= 0x1f1e6 && o <= 0x1f1ff;

// Czy między znakiem `prev` a `ch` nie ma granicy grafemu (uproszczone UAX #29).
function joins(prev, ch, cluster) {
  const o = cp(ch);
  if (o === 0x200d || (o >= 0x1f3fb && o <= 0x1f3ff) || isExtend(o)) return true;
  if (RE_MC.test(ch) || NOW_SPACING_MC.has(o)) return !MC_NOT_SPACING.has(o);
  const p = cp(prev);
  if (p === 0x200d) {
    // GB11: sekwencje emoji łączone ZWJ.
    return RE_SO.test(ch) && RE_SO.test(String.fromCodePoint(cp(cluster)));
  }
  if (isRegionalIndicator(o) && isRegionalIndicator(p)) {
    // GB12/13: flagi to pary wskaźników regionalnych.
    let count = 0;
    for (const c of cluster) if (isRegionalIndicator(cp(c))) count++;
    return count % 2 === 1;
  }
  const hp = hangulType(p);
  const hc = hangulType(o);
  return hp !== null && hc !== null && HANGUL_JOINS[hp].includes(hc);
}

/**
 * Podział tekstu na grafemy – odpowiednik kolejnych `Character` w Swift.
 * Uproszczenie względem UAX #29: brak reguł Prepend (GB9b) i zbitek indyjskich (GB9c).
 * Celowo nie używamy `Intl.Segmenter`, żeby wynik był identyczny z wersją Python.
 */
export function clusters(s) {
  const result = [];
  let prev = null;
  for (const ch of s) {
    if (result.length > 0) {
      const last = result[result.length - 1];
      if (prev === CR) {
        if (ch === LF && last === CR) {
          result[result.length - 1] = CR + LF;
          prev = ch;
          continue;
        }
      } else if (!isControl(prev) && joins(prev, ch, last)) {
        result[result.length - 1] = last + ch;
        prev = ch;
        continue;
      }
    }
    result.push(ch);
    prev = ch;
  }
  return result;
}

// Swift `isLetter || isNumber` – decyduje pierwszy skalar grafemu (Alphabetic lub wartość liczbowa).
function isLetterOrNumber(cluster) {
  return RE_LETTER_OR_NUMBER.test(String.fromCodePoint(cp(cluster)));
}

/**
 * Tekst bez nadmiarowych białych znaków (na początku, na końcu i podwójnych w środku), w NFC.
 * Grafem zaczynający się od białego znaku (np. spacja + akcent) znika w całości – jak w Swift.
 */
export function cleanedName(s) {
  const text = String(s ?? '').normalize('NFC');
  const words = [];
  let current = '';
  for (const cl of clusters(text)) {
    if (WHITESPACE.has(cp(cl))) {
      if (current) {
        words.push(current);
        current = '';
      }
    } else {
      current += cl;
    }
  }
  if (current) words.push(current);
  return words.join(' ');
}

/** null zamiast pustego tekstu (bez przycinania spacji). */
export function nilIfEmpty(s) {
  return s == null || s === '' ? null : s;
}

// Małe litery znak po znaku – jak Swift `lowercased()` (bez kontekstowej reguły końcowej sigmy).
function lowerEach(s) {
  let out = '';
  for (const ch of s) out += ch.toLowerCase();
  return out;
}

/** Klucz tożsamości nazw: bez nadmiarowych spacji i bez wielkości liter (znaki diakrytyczne zostają). */
export function nameKey(s) {
  const cleaned = cleanedName(s);
  if (isAscii(cleaned)) return cleaned.toLowerCase();
  return lowerEach(cleaned).normalize('NFC');
}

// Znak niebazowy w sensie CoreFoundation (też złożony, którego rozkład zaczyna się od takiego znaku).
function isNonBase(ch) {
  const o = cp(ch);
  if (isExtend(o) || (o >= 0x1f3fb && o <= 0x1f3ff)) return true;
  const decomposed = ch.normalize('NFD');
  return decomposed !== ch && isExtend(cp(decomposed));
}

// Klasa łączenia różna od 0? (Zamiast tablicy: kolejność kanoniczna względem U+0345 o klasie 240.)
function isNonStarter(ch) {
  if (ch === IOTA_SUBSCRIPT) return true;
  return !(IOTA_SUBSCRIPT + ch).normalize('NFD').startsWith(IOTA_SUBSCRIPT);
}

// Składa znak bazowy (szerokość, rozkład, wielkość liter); zwraca [wynik, tryb usuwania akcentów].
function foldBase(ch) {
  let c = ch;
  let changed = false;
  const o = cp(c);
  if (o >= 0xff00 && o <= 0xffef) {
    // Formy pełno- i półszerokie: zamiana na zwykłą postać, gdy jest jednym znakiem (U+FFE3 zostaje).
    const wide = c.normalize('NFKD');
    if (Array.from(wide).length === 1) c = wide;
    changed = true;
  }
  const decomposed = c.normalize('NFD');
  if (decomposed !== c && cp(decomposed) < LGC_LIMIT) {
    c = String.fromCodePoint(cp(decomposed));
    changed = true;
  }
  let folded = FOLD_EXCEPTIONS.get(c);
  if (folded === undefined) folded = c.toLowerCase();
  if (folded !== c) changed = true;
  if (cp(folded) < LGC_LIMIT) return [folded, STRIP_ALL];
  // Znak spoza LGC: niezmieniony traci tylko akcenty z bloków < U+0510, zmieniony – żadnych.
  return [folded, changed ? STRIP_NONE : STRIP_LOW];
}

// Odpowiednik `folding([.caseInsensitive, .diacriticInsensitive, .widthInsensitive])` z Foundation.
function fold(s) {
  const chars = Array.from(s);
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const [folded, mode] = foldBase(chars[i]);
    const run = Array.from(folded);
    i++;
    let first = true;
    while (i < chars.length && isNonBase(chars[i])) {
      const c = chars[i];
      i++;
      if (mode === STRIP_NONE || (mode === STRIP_LOW && (!first || cp(c) >= LGC_LIMIT))) {
        // Poza LGC Foundation sprawdza tylko pierwszy znak niebazowy po bazie.
        run.push(c);
      }
      first = false;
    }
    if (run.length > 1) {
      // CoreFoundation porządkuje odcinek wg klasy łączenia; klasy > 0 ułoży dalej NFC.
      out += run.filter((c) => !isNonStarter(c)).join('') + run.filter(isNonStarter).join('');
    } else {
      out += run[0];
    }
  }
  return out.normalize('NFC');
}

const SEARCH_CACHE_LIMIT = 5000;
const searchCache = new Map();

/** Klucz wyszukiwania: bez wielkości liter, polskich znaków i różnic szerokości („Łódź” → „lodz”). */
export function searchKey(s) {
  const text = String(s ?? '');
  const cached = searchCache.get(text);
  if (cached !== undefined) return cached;
  const cleaned = cleanedName(text);
  const key = isAscii(cleaned) ? cleaned.toLowerCase() : fold(cleaned).split(SMALL_L_STROKE).join('l');
  if (searchCache.size >= SEARCH_CACHE_LIMIT) searchCache.clear();
  searchCache.set(text, key);
  return key;
}

/** Same litery i cyfry z `searchKey` („J. K. Rowling” → „jkrowling”). */
export function looseKey(s) {
  return clusters(searchKey(s)).filter(isLetterOrNumber).join('').normalize('NFC');
}

/** Słowa bez interpunkcji z `searchKey` („Pucio. Mówi!” → „pucio mowi”). */
export function wordsKey(s) {
  return cleanedName(clusters(searchKey(s)).map((cl) => (isLetterOrNumber(cl) ? cl : ' ')).join(''));
}

function startsWith(hay, needle) {
  if (needle.length > hay.length) return false;
  for (let i = 0; i < needle.length; i++) if (hay[i] !== needle[i]) return false;
  return true;
}

function containsSeq(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Jak dobrze tekst pasuje do zapytania: 0 – zaczyna się od zapytania, 1 – któreś słowo zaczyna się
 * od zapytania, 2 – zawiera je w środku (także puste zapytanie), null – nie pasuje.
 * Porównanie po grafemach, jak `hasPrefix`/`contains` w Swift.
 */
export function matchRank(text, query) {
  const needleKey = searchKey(query);
  if (needleKey === '') return 2;
  const hayKey = searchKey(text);
  if (!hayKey.includes(needleKey)) return null;
  const needle = clusters(needleKey);
  const hay = clusters(hayKey);
  if (startsWith(hay, needle)) return 0;
  let word = [];
  for (const cl of [...hay, ' ']) {
    if (cl === ' ') {
      if (startsWith(word, needle)) return 1;
      word = [];
    } else {
      word.push(cl);
    }
  }
  return containsSeq(hay, needle) ? 2 : null;
}

/** Czy tekst pasuje do zapytania. */
export function matches(text, query) {
  return matchRank(text, query) !== null;
}

/** Porównanie „localized standard” (polski alfabet, liczby numerycznie, bez wielkości liter). */
export const collator = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });

// Rozstrzyganie remisów jak w `localizedStandardCompare`: małe litery przed wielkimi, potem akcenty.
const tieBreaker = new Intl.Collator('pl', { numeric: true, sensitivity: 'variant', caseFirst: 'lower' });

/** Porównanie do sortowania wszystkich list w UI. */
export function compareLocalized(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return collator.compare(x, y) || tieBreaker.compare(x, y);
}
