# Biblioteki zewnętrzne (static/vendor)

Pliki w tym katalogu pochodzą bez zmian z paczek npm. Odtwarza je skrypt
`tools/vendor.sh` (`npm pack` + kontrola SHA-256); `tools/vendor.sh --check`
sprawdza sumy bez dostępu do sieci. Nie edytuj tych plików ręcznie.

| Plik | Paczka npm | Plik w paczce | Licencja | SHA-256 |
|---|---|---|---|---|
| `preact-htm.js` | `htm@3.1.1` | `preact/standalone.module.js` | Apache-2.0 (htm) + MIT (Preact) | `72284e8e9079c87817145df1110f74e8a2aa040b2fc384922e18dfcb46fc1fd7` |
| `htm/LICENSE` | `htm@3.1.1` | `LICENSE` | – | `740725f7252e750af735d0028cc534970772f513331e9f68150fede8fb3ce00f` |
| `preact/LICENSE` | `preact@10.5.14` | `LICENSE` | – | `1fe6958409c8c257a70c587a18b6f7f412b179b456630790d30b2ec9a8e4b7d4` |
| `barcode-detector/ponyfill.js` | `barcode-detector@3.2.3` | `dist/es/ponyfill.js` | MIT | `47c5899850108764cc762a203555c43396f25c885ae303cd543841e982a0313a` |
| `barcode-detector/zxing-exported.js` | `barcode-detector@3.2.3` | `dist/es/zxing-exported.js` | MIT (+ kod zxing-wasm, MIT) | `1832f3789359d15a8117dfd6b8b1d45de6c20dacd1976350f43080d57447736f` |
| `barcode-detector/LICENSE` | `barcode-detector@3.2.3` | `LICENSE` | – | `fb506e4ade12d7a9efa67c9d76a9a28c8e15d347ca49a69e48e29b40b34ad2ab` |
| `zxing-wasm/zxing_reader.wasm` | `zxing-wasm@3.1.6` | `dist/reader/zxing_reader.wasm` | MIT (zxing-wasm) + Apache-2.0 (zxing-cpp) | `5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e` |
| `zxing-wasm/LICENSE` | `zxing-wasm@3.1.6` | `LICENSE` | – | `fb506e4ade12d7a9efa67c9d76a9a28c8e15d347ca49a69e48e29b40b34ad2ab` |

## Składniki i prawa autorskie

- **htm** 3.1.1 – Copyright 2018 Google Inc., licencja Apache 2.0
  (pełny tekst: `htm/LICENSE`). https://github.com/developit/htm
- **Preact** 10 z hookami – Copyright (c) 2015-present Jason Miller, licencja MIT
  (pełny tekst: `preact/LICENSE`). https://github.com/preactjs/preact
  Preact jest wbudowany w `preact-htm.js` (plik „standalone” paczki htm). Paczka htm
  nie zapisuje dokładnej wersji Preacta, z którą ją zbudowano; porównanie kodu wskazuje
  na gałąź 10.5 (najbliżej 10.5.14). Tekst licencji MIT jest taki sam we wszystkich
  wydaniach Preact 10, dlatego `preact/LICENSE` pochodzi z `preact@10.5.14`.
- **barcode-detector** 3.2.3 – Copyright (c) 2023 Ze-Zheng Wu, licencja MIT
  (pełny tekst: `barcode-detector/LICENSE`). https://github.com/Sec-ant/barcode-detector
- **zxing-wasm** 3.1.6 – Copyright (c) 2023 Ze-Zheng Wu, licencja MIT
  (pełny tekst: `zxing-wasm/LICENSE`). https://github.com/Sec-ant/zxing-wasm
  Kod JavaScript ładujący moduł (wygenerowany przez Emscripten) jest częścią
  `barcode-detector/zxing-exported.js`.
- **zxing-cpp** (commit `2c3dcfeffa7878950a58c1703c86774a428b0c91`), skompilowany do
  `zxing_reader.wasm` – Copyright zxing-cpp authors, licencja Apache 2.0
  (ten sam tekst licencji co w `htm/LICENSE`). https://github.com/zxing-cpp/zxing-cpp

## Uwagi

- `barcode-detector` domyślnie pobiera `zxing_reader.wasm` z jsDelivr. Aplikacja nadpisuje
  `locateFile`, tak by plik był ładowany lokalnie z `static/vendor/zxing-wasm/`
  (żadnych zapytań do zewnętrznych serwerów z przeglądarki).
- Suma `zxing_reader.wasm` jest zgodna ze stałą `ZXING_WASM_SHA256` eksportowaną przez
  `barcode-detector@3.2.3`.
