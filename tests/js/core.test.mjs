// Testy czystych modułów `static/js/core/` na wspólnych wektorach (te same co w pytest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as text from '../../biblioteczka/app/biblioteczka/static/js/core/text.js';
import * as polish from '../../biblioteczka/app/biblioteczka/static/js/core/polish.js';
import * as isbn from '../../biblioteczka/app/biblioteczka/static/js/core/isbn.js';
import * as palette from '../../biblioteczka/app/biblioteczka/static/js/core/palette.js';

const vectors = (name) => JSON.parse(readFileSync(new URL(`../vectors/${name}.json`, import.meta.url), 'utf8'));
const C = (...codes) => String.fromCodePoint(...codes);

const TEXT = vectors('textmatch');
const POLISH = vectors('polish');
const ISBN = vectors('isbn');
const PALETTE = vectors('palette');

test('text: wektory kluczy (wynik oryginału Swift)', () => {
  for (const c of TEXT.strings) {
    const label = JSON.stringify(c.input);
    assert.equal(text.cleanedName(c.input), c.cleanedName, `cleanedName ${label}`);
    assert.equal(text.nameKey(c.input), c.nameKey, `nameKey ${label}`);
    assert.equal(text.searchKey(c.input), c.searchKey, `searchKey ${label}`);
    assert.equal(text.looseKey(c.input), c.looseKey, `looseKey ${label}`);
    assert.equal(text.wordsKey(c.input), c.wordsKey, `wordsKey ${label}`);
    assert.equal(text.nilIfEmpty(c.input), c.nilIfEmpty, `nilIfEmpty ${label}`);
  }
});

test('text: wektory matchRank / matches', () => {
  for (const c of TEXT.matchRank) {
    const label = JSON.stringify([c.text, c.query]);
    assert.equal(text.matchRank(c.text, c.query), c.rank, label);
    assert.equal(text.matches(c.text, c.query), c.rank !== null, label);
  }
});

test('text: wektory obejmują wszystkie przykłady „(verified)”', () => {
  const inputs = new Set(TEXT.strings.map((c) => c.input));
  for (const s of TEXT.verifiedStrings) assert.ok(inputs.has(s), s);
  const pairs = new Set(TEXT.matchRank.map((c) => JSON.stringify([c.text, c.query])));
  for (const p of TEXT.verifiedPairs) assert.ok(pairs.has(JSON.stringify(p)), p.join(' / '));
});

test('text: U+001C–U+001F nie są białymi znakami (jak w Swift)', () => {
  for (const code of [0x1c, 0x1d, 0x1e, 0x1f]) {
    const s = 'a' + C(code) + 'b';
    assert.equal(text.cleanedName(' ' + s + ' '), s);
    assert.equal(text.wordsKey(s), 'a b');
  }
  assert.equal(text.cleanedName(C(0xa0) + 'a' + C(0x3000) + C(0x2009) + 'b\t'), 'a b');
  assert.equal(text.cleanedName('a ' + C(0x301) + 'b'), 'a b');
});

test('text: NFC, ł → l, ß → ss, pełna szerokość', () => {
  const decomposed = 'Ostatnie z' + C(0x307) + 'yczenie';
  assert.equal(text.nfc(decomposed), 'Ostatnie życzenie');
  assert.equal(text.nfc(null), null);
  assert.equal(text.nameKey(decomposed), 'ostatnie życzenie');
  assert.equal(text.searchKey('ŁÓDŹ'), 'lodz');
  assert.equal(text.searchKey('Straße'), 'strasse');
  assert.equal(text.searchKey('ＡＢＣ１'), 'abc1');
  assert.equal(text.nameKey('Straße'), 'straße');
  assert.equal(text.matchRank(decomposed, 'ŻYCZ'), 1);
  assert.equal(text.matchRank('Książka 👍🏽', '👍'), null);
});

test('text: searchKey z pamięcią podręczną zwraca stałe wyniki', () => {
  for (let i = 0; i < 3; i++) assert.equal(text.searchKey('Zażółć gęślą jaźń'), 'zazolc gesla jazn');
  assert.equal(text.searchKey(null), '');
});

test('text: sortowanie „localized standard”', () => {
  const expected = 'abc, Abc, ABD, ala, Ala, Ąbc, Cma, Ćma, Dom, lody, Łódź, Oko, Ósemka, tom 2, tom 10, zebra, Zebra, Źrebię, Żaba'.split(', ');
  const shuffled = [...expected].reverse();
  assert.deepEqual(shuffled.sort(text.compareLocalized), expected);
  assert.equal(text.collator.resolvedOptions().numeric, true);
  assert.equal(text.collator.resolvedOptions().sensitivity, 'base');
  assert.equal(text.compareLocalized('tom 2', 'tom 10') < 0, true);
  assert.equal(text.compareLocalized('a', 'a'), 0);
});

test('polish: wektory', () => {
  for (const c of POLISH.cases) {
    assert.equal(polish.form(c.n, c.noun), c.form, `${c.noun} ${c.n}`);
    assert.equal(polish.count(c.n, c.noun), c.count, `${c.noun} ${c.n}`);
  }
  assert.throws(() => polish.form(1, 'magazine'));
  assert.deepEqual(Object.keys(polish.NOUNS), ['book', 'series', 'volume', 'author']);
});

test('polish: biernik po czasowniku („Dodano 1 książkę”, „Usuń serię i 1 książkę”)', () => {
  assert.equal(polish.countAccusative(1, 'book'), '1 książkę');
  assert.equal(polish.countAccusative(3, 'book'), '3 książki');
  assert.equal(polish.countAccusative(5, 'book'), '5 książek');
  assert.equal(polish.countAccusative(12, 'book'), '12 książek');
  assert.equal(polish.countAccusative(22, 'book'), '22 książki');
  assert.equal(polish.countAccusative(0, 'book'), '0 książek');
  assert.equal(polish.countAccusative(1, 'series'), '1 serię');
  assert.equal(polish.countAccusative(1, 'volume'), '1 tom');
  assert.equal(polish.countAccusative(1, 'author'), '1 autora');
  assert.equal(polish.countAccusative(3, 'author'), '3 autorów');
  assert.equal(polish.formAccusative(4, 'series'), 'serie');
  // Poza liczbą pojedynczą (i męskoosobowym „autor”) biernik = mianownik po liczbie.
  for (const noun of ['book', 'series', 'volume']) {
    for (const n of [0, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 101, 112, -1]) {
      assert.equal(polish.formAccusative(n, noun), polish.form(n, noun), `${noun} ${n}`);
    }
  }
  assert.deepEqual(Object.keys(polish.NOUNS_ACCUSATIVE), Object.keys(polish.NOUNS));
  assert.throws(() => polish.countAccusative(1, 'magazine'));
});

test('isbn: wektory parsowania', () => {
  for (const c of ISBN.parse) {
    const got = isbn.parseISBN(c.input);
    if (c.digits === null) assert.equal(got, null, JSON.stringify(c.input));
    else assert.deepEqual(got, { digits: c.digits, isbn10: c.isbn10 }, JSON.stringify(c.input));
  }
  assert.equal(isbn.parseISBN(null), null);
});

test('isbn: wektory kodów kreskowych i cyfr kontrolnych', () => {
  for (const c of ISBN.classify) {
    const got = isbn.classifyBarcode(c.input);
    if (c.kind === 'book') {
      assert.equal(got.kind, 'book');
      assert.equal(got.isbn.digits, c.digits);
    } else {
      assert.deepEqual(got, { kind: c.kind }, JSON.stringify(c.input));
    }
  }
  for (const c of ISBN.check13) assert.equal(isbn.checkDigit13(c.in), c.out);
  for (const c of ISBN.check10) assert.equal(isbn.checkDigit10(c.in), c.out);
  assert.throws(() => isbn.checkDigit13('123'));
  assert.throws(() => isbn.checkDigit10('12345678X'));
});

test('isbn: formatISBN', () => {
  assert.equal(isbn.formatISBN('9788375780635'), '9788375780635');
  assert.equal(isbn.formatISBN('83-7054-061-9'), '9788370540616');
  assert.equal(isbn.formatISBN({ digits: '9788375780635' }), '9788375780635');
  assert.equal(isbn.formatISBN(' 12-34 '), '12-34');
  assert.equal(isbn.formatISBN(null), '');
});

test('palette: kolory z Palette.swift', () => {
  assert.deepEqual(
    palette.PALETTE.map((g) => ({ ...g })),
    PALETTE.palette,
  );
});

test('palette: FNV-1a 64 i numer gradientu (wektory Swift)', () => {
  for (const c of PALETTE.seeds) {
    const label = JSON.stringify(c.seed);
    assert.equal(text.nameKey(c.seed), c.nameKey, label);
    assert.equal(palette.fnv1a64(c.nameKey).toString(), c.hash, label);
    assert.equal(palette.paletteIndex(c.seed), c.index, label);
    assert.equal(palette.gradientFor(c.seed), palette.PALETTE[c.index], label);
  }
  assert.equal(palette.fnv1a64(''), 0xcbf29ce484222325n);
  // Port celowo działa na NFC: tekst rozłożony daje ten sam kolor co złożony.
  assert.equal(palette.paletteIndex('Ostatnie z' + C(0x307) + 'yczenie'), palette.paletteIndex('Ostatnie życzenie'));
});

test('palette: gradient CSS', () => {
  assert.equal(palette.gradientCSS('Wiedźmin'), 'linear-gradient(to bottom right, #FC7D70, #DB3D73)');
  assert.equal(palette.gradientCSS('Pucio'), 'linear-gradient(to bottom right, #FFBD47, #F27529)');
});

test('palette: inicjały (wektory Swift)', () => {
  for (const c of PALETTE.initials) {
    assert.equal(palette.titleInitials(c.input), c.title, `tytuł ${JSON.stringify(c.input)}`);
    assert.equal(palette.personInitials(c.input), c.person, `osoba ${JSON.stringify(c.input)}`);
  }
});

test('palette: napis, kolor i okładka w edytorze', () => {
  assert.equal(palette.coverSeed('Krew elfów', 'Wiedźmin'), 'Wiedźmin');
  assert.equal(palette.coverSeed('Solaris', null), 'Solaris');
  assert.equal(palette.coverLabel(true, 3), '3');
  assert.equal(palette.coverLabel(true, null), null);
  assert.equal(palette.coverLabel(false, 3), null);
  assert.equal(palette.coverText('Harry Potter i Czara Ognia', null), 'HP');
  assert.equal(palette.coverText('Krew elfów', '3'), '3');

  const empty = palette.editorCover({ title: '  ', seriesName: '', volume: 0 });
  assert.deepEqual(
    { title: empty.title, seed: empty.seed, label: empty.label, text: empty.text },
    { title: '?', seed: '?', label: null, text: '?' },
  );
  assert.equal(empty.gradient, palette.gradientFor('?'));

  const inSeries = palette.editorCover({ title: 'Krew elfów', seriesName: 'Wiedźmin', volume: 3 });
  assert.equal(inSeries.seed, 'Wiedźmin');
  assert.equal(inSeries.label, '3');
  assert.equal(inSeries.text, '3');
  assert.equal(inSeries.gradient, palette.PALETTE[1]);

  const noVolume = palette.editorCover({ title: 'Pucio', seriesName: 'Pucio', volume: 0 });
  assert.equal(noVolume.label, null);
  assert.equal(noVolume.text, 'P');

  const blankSeries = palette.editorCover({ title: 'Solaris', seriesName: '   ', volume: 2 });
  assert.equal(blankSeries.seed, 'Solaris');
  assert.equal(blankSeries.label, null);
  assert.equal(blankSeries.text, 'S');
});
