# Biblioteczka dla Home Assistant OS – dokumentacja dla programistów

To repozytorium zawiera wersję Biblioteczki działającą jako **aplikacja Home Assistant OS**
(przed wersją 2026.2 nazywana „dodatkiem”): kontener Dockera z serwerem WWW, którego
interfejs jest wyświetlany na pasku bocznym Home Assistanta przez **Ingress**. Funkcje
i reguły są takie same jak w aplikacji na iOS (osobne, prywatne repozytorium), z kilkoma poprawkami i dodatkami (wspólna baza
dla domowników, import CSV z iOS, hurtowe pobieranie okładek).

Dokumentacja dla użytkowników (instalacja, skanowanie, import, kopie zapasowe) jest
w [`biblioteczka/DOCS.md`](biblioteczka/DOCS.md) – Home Assistant pokazuje ją na karcie
„Dokumentacja” aplikacji.

## Struktura

```
biblioteczka-ha/                # katalog główny repozytorium
  repository.yaml               # metadane repozytorium aplikacji HA (czyta je Supervisor)
  README.md                     # opis dla użytkowników ze zrzutami ekranu i instalacją
  DEVELOPMENT.md                # ten plik
  docs/screenshots/             # zrzuty ekranu używane w README
  requirements-dev.txt          # zależności środowiska deweloperskiego
  pytest.ini                    # konfiguracja pytest (katalog testów, pytest-asyncio)
  .venv/                        # lokalne środowisko Pythona (poza gitem)
  devdata/                      # domyślne dane z tools/dev.sh (poza gitem)
  biblioteczka/                 # FOLDER APLIKACJI HA – z niego Supervisor buduje obraz
    config.yaml                 # konfiguracja aplikacji (Ingress, watchdog, kopie zapasowe…)
    Dockerfile  run.sh          # obraz na bazie ghcr.io/home-assistant/base (Alpine)
    DOCS.md  README.md  CHANGELOG.md  icon.png  logo.png
    app/biblioteczka/           # pakiet Pythona (python -m biblioteczka)
      __main__.py  server.py    # CLI i serwer aiohttp (API REST + pliki statyczne)
      db.py                     # SQLite: schemat, migracje, licznik rewizji
      store.py  views.py        # operacje na bibliotece i migawka stanu dla klienta
      catalog.py  csvio.py  sample.py
      textmatch.py  polish.py  isbn.py   # czyste moduły (bliźniaki w static/js/core/)
      covers.py  barcode.py     # okładki (Pillow) i dekodowanie kodów (zxing-cpp)
      lookup/                   # wyszukiwanie po ISBN: BN (MARC), e-ISBN (ONIX), Open Library
      data/KatalogBajek.json    # wbudowany katalog podpowiedzi (z aplikacji iOS)
      static/                   # interfejs: index.html, css/, js/, vendor/
  tests/
    test_*.py                   # testy pytest
    js/*.test.mjs               # testy Node (czyste moduły z static/js: core, ui, screens, editors)
    vectors/                    # wspólne wektory testowe dla pytest i Node
    fixtures/                   # zapisane odpowiedzi BN / e-ISBN / Open Library
  tools/
    dev.sh                      # uruchomienie lokalne
    vendor.sh                   # odtworzenie bibliotek JS z npm z kontrolą SHA-256
    make_icons.py               # icon.png i logo.png z ikony aplikacji iOS
```

W repozytorium nie może być żadnego innego pliku `config.json` / `config.yaml` /
`config.yml` – Supervisor przeszukuje repozytorium rekurencyjnie i każdy taki plik
traktuje jak konfigurację aplikacji. Nie dodawaj też `node_modules`.

## Środowisko deweloperskie

Wymagania: Python 3.10 lub nowszy (w kontenerze działa Python 3.14 z Alpine 3.24),
Node.js 20.11 lub nowszy do testów JS (zalecany 22 LTS; projekt jest sprawdzany na Node 24), npm tylko do
`tools/vendor.sh`.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
```

Kod musi działać na Pythonie 3.10–3.14 oraz z wersjami bibliotek z Alpine 3.24
(aiohttp 3.13, Pillow 12.2, zxing-cpp 2.3) i z PyPI (zxing-cpp 3.x). `zxingcpp`
i `certifi` są opcjonalne – bez nich aplikacja działa, tylko z mniejszymi możliwościami
(brak dekodowania kodów na serwerze; systemowe certyfikaty zamiast `certifi`).

## Uruchomienie lokalne

```sh
tools/dev.sh                  # http://127.0.0.1:8099, dane w devdata/
tools/dev.sh --sample-data    # z przykładowymi danymi
tools/dev.sh --host 0.0.0.0   # dostęp z telefonu w tej samej sieci
tools/dev.sh --port 8100 --data /tmp/bib   # inny port i osobny katalog danych
```

Tryb deweloperski (`--dev`) wyłącza ograniczenie dostępu do adresu proxy Ingress
i udostępnia `POST /api/sample-data`. `--data KATALOG` wskazuje inny katalog danych
(ścieżka względna liczy się od bieżącego katalogu; katalog powstaje sam), np. żeby
równolegle uruchomić drugi serwer z osobną bazą. Bazę zaczyna się od nowa, usuwając
`devdata/` (albo katalog podany w `--data`).
Skanowanie na żywo aparatem działa lokalnie tylko pod `http://127.0.0.1` / `localhost`
(bezpieczny kontekst); z telefonu w sieci lokalnej zostaje tryb zdjęcia.

## Testy

```sh
.venv/bin/python -m pytest -q        # Python
.venv/bin/python -m pytest -q -W error::DeprecationWarning   # bez przestarzałych API
node --test tests/js/                          # JavaScript (czyste moduły z static/js)
```

Node 22+ nie rozwija katalogu podanego w `node --test`, dlatego `tests/js/package.json`
wskazuje `all.mjs`, który wczytuje wszystkie pliki `*.test.mjs`. Działa też
`node --test "tests/js/*.test.mjs"`.

Testy nie korzystają z sieci: wyszukiwanie po ISBN jest sprawdzane na zapisanych
odpowiedziach z `tests/fixtures/`, serwer – na testowym serwerze aiohttp. Reguły tekstowe,
odmiana liczebników, ISBN i paleta okładek mają wspólne wektory w `tests/vectors/`,
sprawdzane jednocześnie przez pytest i Node, żeby implementacje w Pythonie i JS się nie
rozjechały. `tools/vendor.sh --check` sprawdza sumy SHA-256 bibliotek w `static/vendor`.

## Architektura

**Backend – aiohttp + SQLite** (`app/biblioteczka/`):

- Jeden proces, jedno połączenie SQLite (`/data/biblioteczka.db`, WAL). Każda zmiana to
  jedna transakcja, która zwiększa licznik `revision` w tabeli `meta`. Identyfikatory
  (`AUTOINCREMENT`) nie są używane ponownie – także po „Usuń wszystkie dane” – więc
  nieaktualny edytor lub adres na innym urządzeniu dostaje `404`, a nie cudzą pozycję.
- `GET api/state` zwraca pełną migawkę biblioteki (`views.build_state`) z nagłówkiem
  nieprzezroczystym `ETag` (rewizja bazy, identyfikator uruchomienia serwera i postęp
  pobierania okładek); klient odpytuje co 15 s, a w trakcie pobierania okładek co 2 s.
  Ukryta karta nie odpytuje wcale; po powrocie do karty lub okna (`visibilitychange`,
  `focus`) i po odzyskaniu sieci (`online`) stan jest pobierany od razu. Gdy serwer nie odpowiada, odstępy rosną wykładniczo
  (2, 4, 8… s, ale nigdy krócej niż zwykły odstęp) do najwyżej 60 s; pierwsza udana
  odpowiedź przywraca zwykły rytm. Przy braku zmian serwer odpowiada `304`. Tak działa
  odświeżanie na wielu urządzeniach.
- Zmiany idą przez REST (`POST/PUT/DELETE api/books|series|authors…`); logika edytorów
  z iOS (zapis książki, łączenie autorów, przyjęcie istniejącego rekordu) jest na serwerze
  w `store.Library`. Błędy mają polskie komunikaty: `{"error": "…", "code": "…"}`.
- Wyszukiwanie po ISBN (`api/lookup`) wykonuje serwer: Biblioteka Narodowa (MARC),
  e-ISBN (ONIX) i Open Library, scalane według priorytetów z aplikacji iOS. Do sieci
  trafia tylko numer ISBN.
- Okładki są zmniejszane (≤ 900 px, JPEG 80) i zapisywane pod nazwą będącą skrótem SHA-1
  w `/data/covers/`; nieużywane są sprzątane po 24 h.
- Kody kreskowe dekoduje przeglądarka (WebAssembly), a `api/barcode` z zxing-cpp jest
  zapasowym dekoderem zdjęć.
- Ingress: Supervisor przekazuje żądania z adresu `172.30.32.2` z obciętym prefiksem
  `/api/hassio_ingress/<token>`. Serwer odrzuca inne adresy (poza `/healthz`, dostępnym
  też z `127.0.0.1` – do ręcznego sprawdzania z wnętrza kontenera), a do `index.html` wstawia
  `<base href>` z nagłówka `X-Ingress-Path`. Logowania nie ma – zapewnia je Home Assistant.

**Frontend – Preact + htm bez kroku budowania** (`static/`):

- Moduły ES ładowane bezpośrednio przez przeglądarkę; `vendor/preact-htm.js` to Preact 10
  z hookami i szablonami htm (tagged template `html`) w jednym pliku. Nie ma npm, bundlera
  ani transpilacji.
- Wszystkie adresy są względne (`api/state`, `static/…`) i rozwiązywane względem
  `<base href>`, bo strona działa pod ścieżką Ingress. Routing przez `#hash`.
- Pamięć podręczna: klucz plików statycznych to wersja i 10 znaków skrótu SHA-1 całego
  katalogu `static/` (ścieżki i zawartość), liczony raz przy starcie serwera, np.
  `0.1.0-11c0cecaef`. Trafia do `?v=` w `index.html`, do `data-version` i do `appVersion`
  w `api/state`. Pliki pod adresem z bieżącym kluczem mają `max-age=86400`, pozostałe
  (importy modułów, stare klucze) `no-cache` z ETag-iem. Klucz zmienia się po każdej zmianie
  interfejsu, także po **Przebuduj** bez nowego numeru wersji: przeglądarki nie mieszają
  starych plików z nowymi, a otwarte strony pokazują „Dostępna jest nowa wersja Biblioteczki.”
  z przyciskiem **Odśwież**.
- `js/core/` – czyste moduły (tekst, odmiana, ISBN, paleta) testowane w Node;
  `js/store.js` – stan biblioteki i odpytywanie; `js/ui/` – wspólne komponenty w stylu
  iOS; `js/screens/` i `js/editors/` – ekrany i edytory.
- Skaner: `barcode-detector` (ponyfill) z lokalnym `zxing_reader.wasm` – nic nie jest
  pobierane z CDN.
- Widok na komputerze („dwa panele”): od 1008 px szerokości (`SPLIT_QUERY` w `js/ui/pure.js`,
  ten sam próg w bloku 3b `css/app.css`) `app.js` ustawia klasę `is-split` na `<html>`
  i zamiast jednego ekranu rysuje dla karty `SplitPanel`: po lewej korzeń karty (lista), po prawej
  ekran z wierzchu stosu albo zachętę do wyboru. Okno się nie przewija – każdy panel ma własne
  przewijanie i pasek tytułu. Ekrany i wiersze pytają o panel przez `usePane()` (`PaneContext`
  z `js/ui/split.js`); wiersz listy nie przechodzi dalej, tylko wybiera pozycję przez
  `selectEntry()` z `js/ui/router.js`: pierwszy wybór dodaje wpis w historii, zmiana wyboru
  podmienia bieżący wpis z zachowaniem `bibFrom`, więc „wstecz” wraca do listy, a strzałki
  ↑/↓ nie zaśmiecają historii. W prawym panelu nawigacja działa jak na telefonie. Szczegóły
  książki to zwykły ekran stosu (`…/ksiazka/:id`) – działa w obu układach. Poniżej progu
  działa układ jednoekranowy (jak na telefonie).

**Pakowanie dla Home Assistanta** (`biblioteczka/`):

- `Dockerfile`: `ghcr.io/home-assistant/base:3.24` + pakiety Alpine `python3`,
  `py3-aiohttp`, `py3-pillow`, `py3-zxing-cpp` (bez pip i bez kompilacji, więc obraz
  buduje się szybko także na Raspberry Pi). `ARG BUILD_FROM` ma wartość domyślną,
  bo Supervisor od 2026.04 jej nie przekazuje; `build.yaml` jest przestarzały i go nie ma.
  `ARG BUILD_VERSION` (Supervisor przekazuje w nim `version` z `config.yaml`) jest
  zadeklarowany po `FROM` i trafia do `ENV BIBLIOTECZKA_VERSION`, z którego
  `app/biblioteczka/__init__.py` bierze `__version__`, oraz do etykiet obrazu.
- `run.sh` (`#!/command/with-contenv bashio`, S6 overlay jako PID 1, więc `init: false`)
  uruchamia `python3 -m biblioteczka --data /data --host 0.0.0.0 --port 8099`.
- `config.yaml`: tylko Ingress (bez portów), `panel_admin: false` (panel dla wszystkich
  domowników), `ingress_stream: true` (Supervisor bez tego buforuje treść POST
  i odrzuca powyżej 16 MiB; przesyłana jest surowa treść żądania (body) do 20 MB – serwer nie może
  wymagać nagłówka `Content-Length`, bo strumień dochodzi jako `chunked`),
  `backup: cold` (spójna kopia SQLite), `watchdog` na `/healthz`.

## Biblioteki JS (vendoring)

Pliki w `static/vendor/` pochodzą bez zmian z npm: `htm@3.1.1` (z Preactem),
`barcode-detector@3.2.3`, `zxing-wasm@3.1.6` – wersje, licencje i sumy są w
`static/vendor/NOTICE.md`.

```sh
tools/vendor.sh           # pobiera paczki (npm pack, bez skryptów) i odtwarza pliki
tools/vendor.sh --check   # tylko sprawdza sumy SHA-256 (bez sieci)
```

Skrypt najpierw sprawdza sumy wszystkich plików, a dopiero potem nadpisuje katalog.
Aby zmienić wersję biblioteki, zaktualizuj w nim specyfikację paczki i sumę, uruchom go,
przejrzyj zmiany i uzupełnij `NOTICE.md`.

## Ikony

```sh
.venv/bin/python tools/make_icons.py
```

Tworzy `biblioteczka/icon.png` (128×128) i `biblioteczka/logo.png` (250×100) z
`../Biblioteczka/Assets.xcassets/AppIcon.appiconset/AppIcon.png` – ikony aplikacji iOS
z prywatnego repozytorium, które musi leżeć katalog wyżej (napis czcionką systemową macOS).
Bez niego podaj inną ikonę: `.venv/bin/python tools/make_icons.py --source ŚCIEŻKA.png`
(`--out KATALOG` zapisuje pliki gdzie indziej).

## Instalacja na Home Assistancie do testów

Zwykła instalacja idzie z tego repozytorium na GitHubie (zob. `README.md`). Zmiany przed
wysłaniem na GitHuba można sprawdzić jako **aplikację lokalną**:

1. Skopiuj folder `biblioteczka` do udziału `local_apps` (Samba share) albo przez SSH
   (aplikacja Terminal & SSH z włączonym serwerem SSH):

   ```sh
   COPYFILE_DISABLE=1 tar --exclude __pycache__ -cf - biblioteczka \
     | ssh -p 22 root@homeassistant.local "rm -rf /local_apps/biblioteczka && tar -xf - -C /local_apps"
   ```

2. **Ustawienia → Aplikacje → Zainstaluj aplikację → ⋮ → Sprawdź aktualizacje**, potem
   **Local apps → Biblioteczka → Zainstaluj → Uruchom** i **Pokaż na pasku bocznym**.
   Identyfikator aplikacji to `local_biblioteczka`.
3. Po zmianach w kodzie skopiuj folder ponownie, wybierz w sklepie **⋮ → Sprawdź
   aktualizacje**, a potem **Przebuduj** na stronie aplikacji (albo wydaj nową wersję –
   kroki w sekcji „Nowa wersja” niżej; po sprawdzeniu aktualizacji Home Assistant ją
   zaproponuje).
   Z wiersza poleceń (SSH): `ha apps rebuild local_biblioteczka`, logi:
   `ha apps logs local_biblioteczka`. W obu przypadkach otwarte strony Biblioteczki
   zaproponują odświeżenie, bo zmienia się klucz plików statycznych.
4. Błędy walidacji `config.yaml` i budowania obrazu są w logach Supervisora
   (**Ustawienia → System → Logi → Supervisor**).

Samo budowanie obrazu (bez Home Assistanta) można sprawdzić poleceniem
`docker buildx build --platform linux/arm64 biblioteczka`. Uruchomiony poza Home
Assistantem kontener odrzuca (403) żądania spoza proxy Ingress, więc interfejs testuje się
przez `tools/dev.sh`; stan serwera w kontenerze sprawdzisz poleceniem
`docker exec <kontener> curl -fsS http://127.0.0.1:8099/healthz`.

Aplikacja lokalna (`local_biblioteczka`) i aplikacja z repozytorium GitHuba
(`<hash>_biblioteczka`) to dla Home Assistanta dwie różne aplikacje z osobnymi danymi.
Dane między nimi przenosi się eksportem i importem CSV (okładki pobiera się potem
poleceniem „Pobierz brakujące okładki”).

## Nowa wersja

Numer wersji ustala `version` w `biblioteczka/config.yaml`. Supervisor przekazuje go przy
budowaniu obrazu jako `BUILD_VERSION`, `Dockerfile` zapisuje go w `BIBLIOTECZKA_VERSION`,
a serwer pokazuje go w dzienniku i w kluczu plików statycznych.

1. Zwiększ `version` w `config.yaml`.
2. Wpisz ten sam numer jako wartość domyślną: `_DEFAULT_VERSION` w
   `app/biblioteczka/__init__.py` i `ARG BUILD_VERSION` w `Dockerfile`. Są używane poza
   Home Assistantem (`tools/dev.sh`, testy, `docker buildx build` bez argumentów).
3. Dopisz na początku `CHANGELOG.md` sekcję `## <wersja>` z listą zmian (Home Assistant
   pokazuje ją przy aktualizacji).
4. Uruchom testy (sekcja „Testy”). `tests/test_packaging.py` sprawdza, czy numery
   w `config.yaml`, `__init__.py`, `Dockerfile` i `CHANGELOG.md` się zgadzają, czy w
   repozytorium jest tylko jeden plik `config.*` i czy `run.sh` ma końce linii LF.
5. Zatwierdź zmiany i wyślij je na GitHuba (`git push`). Home Assistant sam co jakiś czas
   sprawdza repozytoria; od razu: **Sklep z aplikacjami → ⋮ → Sprawdź aktualizacje**.
   Aktualizacja pojawi się w **Ustawieniach**.
