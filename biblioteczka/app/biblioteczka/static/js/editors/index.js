// Edytory i skaner – jedyne wejście dla ekranów (kontrakt §7.4):
//
//   openBookEditor({bookId?, seriesId?, authorId?, volumeNumber?, scannedIsbn?})
//   openSeriesEditor({seriesId?, authorId?, onDelete?})
//   openAuthorEditor({authorId?, onDelete?, onMerged?})
//   openScanner({onIsbn?})   // bez onIsbn: po skanie edytor nowej książki z tym numerem
//
// Każda funkcja otwiera arkusz i zwraca jego uchwyt `{id, close}` (albo null, gdy edytowanego
// obiektu już nie ma). `onDelete` – opcjonalne wywołanie z ekranu szczegółów po usunięciu;
// bez niego edytor sam cofa ekran usuniętej serii/autora, jeśli jest na wierzchu.

export { openBookEditor } from './book-editor.js';
export { openSeriesEditor } from './series-editor.js';
export { openAuthorEditor } from './author-editor.js';
export { openScanner, ManualIsbnSection, decodeBarcodePhoto, getDetector } from './scanner.js';
