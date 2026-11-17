// Kolory i napisy okładek – port `Theme/Palette.swift` oraz reguł `CoverView` / `Book.coverSeed` / `coverLabel`.
// Gradient dobierany jest na stałe z nazwy (FNV-1a 64 z UTF-8 `nameKey`), więc dana seria
// i dany autor zawsze mają ten sam kolor – tak samo jak w aplikacji na iOS.

import { cleanedName, clusters, nameKey } from './text.js';

/** Dziesięć gradientów okładek (początek → koniec), w kolejności z `Palette.gradients`. */
export const PALETTE = Object.freeze(
  [
    ['indygo', '#7363FA', '#4C38CC'],
    ['koral', '#FC7D70', '#DB3D73'],
    ['morski', '#26BDA8', '#0A8087'],
    ['bursztyn', '#FFBD47', '#F27529'],
    ['niebo', '#54ADFF', '#2966E8'],
    ['śliwka', '#D161D6', '#8536B0'],
    ['las', '#66BA70', '#267859'],
    ['łupek', '#8C9CBA', '#4F5C7D'],
    ['róż', '#F294A3', '#BA547A'],
    ['ocean', '#218FB5', '#124C87'],
  ].map(([name, start, end]) => Object.freeze({ name, start, end })),
);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** Skrót FNV-1a 64-bitowy z bajtów UTF-8 tekstu (BigInt) – jak `String.stableHash` w Swift. */
export function fnv1a64(text) {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(String(text ?? ''))) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** Numer gradientu (0–9) dla nazwy, np. „Wiedźmin” → 1. */
export function paletteIndex(seed) {
  return Number(fnv1a64(nameKey(seed)) % BigInt(PALETTE.length));
}

/** Gradient `{name, start, end}` dla nazwy. */
export function gradientFor(seed) {
  return PALETTE[paletteIndex(seed)];
}

/** Gradient CSS okładki/awatara (od lewego górnego do prawego dolnego rogu, jak w SwiftUI). */
export function gradientCSS(seed) {
  const { start, end } = gradientFor(seed);
  return `linear-gradient(to bottom right, ${start}, ${end})`;
}

// Wielkie litery znak po znaku (jak Swift `uppercased()`), w NFC.
function upper(s) {
  let out = '';
  for (const ch of s) out += ch.toUpperCase();
  return out.normalize('NFC');
}

// Słowa jako listy grafemów – jak Swift `split(separator: " ")`, które dzieli tylko na grafemie „ ”
// (spacja z doklejonym znakiem łączącym nie jest separatorem), pomijając puste kawałki.
function words(s) {
  const result = [];
  let current = [];
  for (const cl of clusters(s)) {
    if (cl === ' ') {
      if (current.length) result.push(current);
      current = [];
    } else {
      current.push(cl);
    }
  }
  if (current.length) result.push(current);
  return result;
}

/**
 * Inicjały tytułu, np. „Harry Potter i Czara Ognia” → „HP”: pierwsze litery dwóch pierwszych słów
 * dłuższych niż jeden znak. Gdy takich nie ma – pierwszy znak tytułu (nieprzyciętego, jak w Swift).
 */
export function titleInitials(title) {
  const letters = words(cleanedName(title))
    .filter((word) => word.length > 1)
    .slice(0, 2)
    .map((word) => word[0]);
  const result = upper(letters.join(''));
  if (result) return result;
  const first = clusters(String(title ?? '').normalize('NFC'))[0] ?? '';
  return upper(first);
}

/** Inicjały osoby: pierwsza litera pierwszego i ostatniego słowa („Ursula K. Le Guin” → „UG”); pusto → „?”. */
export function personInitials(name) {
  const list = words(cleanedName(name));
  if (list.length === 0) return '?';
  const first = list[0][0];
  if (list.length < 2) return upper(first);
  return upper(first + list[list.length - 1][0]);
}

/** Nazwa, od której zależy kolor okładki książki: seria (jeśli jest), inaczej tytuł – `Book.coverSeed`. */
export function coverSeed(title, seriesName) {
  return seriesName != null ? seriesName : title;
}

/** Napis na okładce tomu: numer tomu tylko dla książki w serii z numerem – `Book.coverLabel`. */
export function coverLabel(inSeries, volumeNumber) {
  return inSeries && volumeNumber != null ? String(volumeNumber) : null;
}

/** Tekst rysowany na okładce bez zdjęcia: numer tomu albo inicjały tytułu. */
export function coverText(title, label) {
  return label != null ? String(label) : titleInitials(title);
}

/**
 * Okładka podglądu w edytorze książki (`BookEditorView`): tytuł „?” dla pustego, kolor z wpisanej serii
 * (gdy niepusta), numer tomu tylko przy niepustej serii i tomie > 0.
 * Zwraca `{title, seed, label, text, gradient}`.
 */
export function editorCover({ title = '', seriesName = '', volume = 0 } = {}) {
  const hasSeries = cleanedName(seriesName) !== '';
  const shownTitle = cleanedName(title) === '' ? '?' : String(title);
  const seed = hasSeries ? String(seriesName) : shownTitle;
  const number = Number(volume);
  const label = hasSeries && Number.isInteger(number) && number > 0 ? String(number) : null;
  return { title: shownTitle, seed, label, text: coverText(shownTitle, label), gradient: gradientFor(seed) };
}
