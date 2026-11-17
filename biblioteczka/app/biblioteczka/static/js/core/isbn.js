// Numer ISBN (13 cyfr, jak w kodzie EAN-13) i rozpoznawanie kodów kreskowych – port `ISBN.swift`.
// Bliźniak modułu Python `biblioteczka/isbn.py` (wspólne wektory `tests/vectors/isbn.json`).

import { clusters } from './text.js';

const isDigit = (cl) => cl.length === 1 && cl >= '0' && cl <= '9';
const isAsciiDigits = (s, length) => typeof s === 'string' && s.length === length && /^[0-9]+$/.test(s);

/** Cyfra kontrolna ISBN-13 / EAN-13 dla 12 pierwszych cyfr, np. „978837578063” → „5”. */
export function checkDigit13(first12) {
  if (!isAsciiDigits(first12, 12)) throw new Error('Cyfra kontrolna ISBN-13 wymaga dokładnie 12 cyfr.');
  let total = 0;
  for (let i = 0; i < 12; i++) total += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (total % 10)) % 10);
}

/** Cyfra kontrolna ISBN-10 dla 9 pierwszych cyfr („0”–„9” albo „X”), np. „080442957” → „X”. */
export function checkDigit10(first9) {
  if (!isAsciiDigits(first9, 9)) throw new Error('Cyfra kontrolna ISBN-10 wymaga dokładnie 9 cyfr.');
  let total = 0;
  for (let i = 0; i < 9; i++) total += Number(first9[i]) * (10 - i);
  const check = (11 - (total % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}

function isValid13(digits) {
  return (
    isAsciiDigits(digits, 13) &&
    (digits.startsWith('978') || digits.startsWith('979')) &&
    checkDigit13(digits.slice(0, 12)) === digits[12]
  );
}

function isbn10Of(digits) {
  if (!digits.startsWith('978')) return null;
  const body = digits.slice(3, 12);
  return body + checkDigit10(body);
}

function makeISBN(digits) {
  return Object.freeze({ digits, isbn10: isbn10Of(digits) });
}

/**
 * ISBN-13 albo ISBN-10 – z kreskami, spacjami czy napisem „ISBN” – jako `{digits, isbn10}`;
 * null przy złej długości lub cyfrze kontrolnej. Liczą się tylko cyfry ASCII i litera X
 * (na poziomie grafemów, jak w Swift).
 */
export function parseISBN(text) {
  if (text == null || text === '') return null;
  let raw = '';
  for (const cl of clusters(String(text))) {
    if (cl === 'X' || cl === 'x') raw += 'X';
    else if (isDigit(cl)) raw += cl;
  }
  if (raw.length === 13) {
    return !raw.includes('X') && isValid13(raw) ? makeISBN(raw) : null;
  }
  if (raw.length === 10) {
    if (raw.slice(0, 9).includes('X') || checkDigit10(raw.slice(0, 9)) !== raw[9]) return null;
    const body = '978' + raw.slice(0, 9);
    return makeISBN(body + checkDigit13(body));
  }
  return null;
}

/**
 * Co jest w zeskanowanym kodzie EAN-13: `{kind: 'book', isbn}`, `{kind: 'magazine'}` (ISSN, prefiks 977)
 * albo `{kind: 'other'}`. Z kodu kreskowego przyjmujemy tylko 13 cyfr – ISBN-10 nie jest kodem książki.
 */
export function classifyBarcode(payload) {
  let digits = '';
  for (const cl of clusters(String(payload ?? ''))) if (isDigit(cl)) digits += cl;
  if (digits.length === 13) {
    const isbn = parseISBN(digits);
    if (isbn) return { kind: 'book', isbn };
  }
  return digits.startsWith('977') ? { kind: 'magazine' } : { kind: 'other' };
}

/**
 * Numer do wyświetlenia. Bez tablic zakresów wydawców nie da się poprawnie wstawić kresek,
 * więc ISBN pokazujemy jako 13 cyfr (np. „9788375780635”); inny tekst – po przycięciu spacji.
 */
export function formatISBN(digits) {
  if (digits == null) return '';
  const value = typeof digits === 'object' ? digits.digits : digits;
  const parsed = parseISBN(String(value ?? ''));
  return parsed ? parsed.digits : String(value ?? '').trim();
}
