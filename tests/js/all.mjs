// Punkt wejścia dla `node --test tests/js/`: wczytuje wszystkie pliki *.test.mjs z tego katalogu.
import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort();
for (const name of files) await import(new URL(name, dir).href);
