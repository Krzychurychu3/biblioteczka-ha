# Biblioteczka

Wspólna domowa biblioteczka dla całej rodziny, działająca w Home Assistancie. To ta sama
Biblioteczka co w aplikacji na iPhone’a, tylko z jedną bazą danych dla wszystkich
domowników: książkę dodaną na jednym telefonie od razu widać na pozostałych.

## Co potrafi

- **Serie i brakujące tomy** – dla każdej serii widać, które tomy już są na półce,
  a których brakuje („Brakuje tomu 4”), postęp kompletowania i łączną liczbę tomów.
- **Autorzy i książki** – listy autorów, pojedynczych książek oraz wyszukiwanie po
  tytule, autorze i serii (bez względu na polskie znaki i wielkość liter).
- **Dodawanie po numerze ISBN** – po zeskanowaniu kodu kreskowego albo wpisaniu numeru
  Biblioteczka sama uzupełnia tytuł, autora, serię, numer tomu, wydawnictwo, rok, liczbę
  stron i okładkę (Biblioteka Narodowa, e-ISBN, Open Library).
- **Podpowiedzi przy wpisywaniu** – istniejący autorzy, serie i tytuły, a także wbudowany
  katalog stu popularnych bajek i książek dla dzieci.
- **Okładki** – z internetu, ze zdjęcia albo z galerii; można też jednym poleceniem
  pobrać brakujące okładki dla wszystkich książek z numerem ISBN.
- **Import i eksport CSV** – w tym import pliku wyeksportowanego z aplikacji na iPhone’a.
- Interfejs po polsku, dopasowany do telefonu, tabletu i komputera, w jasnym i ciemnym
  motywie.

## Wymagania

- Home Assistant OS (aplikacje – dawniej „dodatki” – są dostępne tylko w tym rodzaju
  instalacji).
- Procesor 64-bitowy: `aarch64` (np. Raspberry Pi 4/5, Home Assistant Green i Yellow)
  albo `amd64` (komputery i mini PC).
- Dostęp do internetu przy instalacji (obraz aplikacji jest budowany na urządzeniu)
  oraz do wyszukiwania książek po numerze ISBN.

## Instalacja

Biblioteczkę instaluje się z repozytorium na GitHubie:
`https://github.com/Krzychurychu3/biblioteczka-ha`.

1. Otwórz **Ustawienia → Aplikacje** i kliknij **Zainstaluj aplikację**
   (otworzy się **Sklep z aplikacjami**).
2. W menu **⋮** w prawym górnym rogu wybierz **Repozytoria** i kliknij **Dodaj**. W oknie
   dodawania repozytorium wklej w polu **URL** powyższy adres, kliknij **Dodaj** i zamknij
   okno z listą repozytoriów.
3. Odśwież stronę (Ctrl+F5, na Macu ⌘⇧R). Na liście pojawi się sekcja **Biblioteczka** –
   kliknij aplikację **Biblioteczka**, a potem **Zainstaluj**. Home Assistant zbuduje obraz
   aplikacji na Twoim urządzeniu – na Raspberry Pi może to potrwać kilka minut.
4. Kliknij **Uruchom**.
5. Włącz **Pokaż na pasku bocznym** i **Watchdog** (automatyczny restart, gdyby aplikacja
   przestała odpowiadać). **Uruchamianie przy starcie** jest włączone domyślnie – zostaw je
   tak.

Biblioteczka pojawi się na pasku bocznym Home Assistanta – u wszystkich domowników,
także tych bez uprawnień administratora. Każdy użytkownik może ją u siebie ukryć albo
przesunąć w swoim profilu („Zmień kolejność i ukryj elementy na pasku bocznym”).

Jeśli aplikacja nie pojawia się w sklepie albo nie chce się zbudować, sprawdź logi
Supervisora: **Ustawienia → System → Logi**, a następnie wybierz z listy logów
„Supervisor”.

### Pierwsze uruchomienie

Przy pierwszym starcie Biblioteczka zakłada pustą bazę i wczytuje katalog podpowiedzi
(bajki i książki dla dzieci). Katalog nie pojawia się na listach – jego pozycje są
podpowiadane dopiero przy wpisywaniu tytułu nowej książki. Zacznij od przycisku **+**:
dodaj książkę, serię albo zeskanuj kod kreskowy.

Aplikacja nie ma żadnych opcji na karcie **Konfiguracja** – nie trzeba niczego ustawiać.

## Korzystanie na telefonie i komputerze

- **Aplikacja Home Assistant** (Companion) na iPhone’a i Androida: otwórz menu boczne
  (☰) i wybierz **Biblioteczka**. Działa w domu i poza domem – tak samo jak cały Home
  Assistant.
- **Przeglądarka** na komputerze lub tablecie: zaloguj się do Home Assistanta
  i wybierz **Biblioteczka** na pasku bocznym.

**Widok na komputerze.** Gdy obszar Biblioteczki ma co najmniej ok. 1000 pikseli szerokości
(np. w przeglądarce na laptopie; przy rozwiniętym pasku bocznym Home Assistanta okno musi być
odpowiednio szersze), Biblioteczka pokazuje dwa panele: listę po lewej i szczegóły wybranej
pozycji po prawej. Kliknięcie pozycji od razu pokazuje jej szczegóły. Na klawiaturze strzałki
↑/↓ zmieniają wybór na liście, Enter przechodzi do szczegółów, a Esc wraca do listy.
W węższym oknie (np. na telefonie) Biblioteczka pokazuje jeden ekran naraz.

Logowanie zapewnia Home Assistant – Biblioteczka nie ma osobnych kont ani haseł.
Wszyscy domownicy pracują na jednej, wspólnej bazie. Zmiany z innych urządzeń pojawiają
się automatycznie po kilkunastu sekundach (albo od razu po powrocie do karty
z Biblioteczką).

## Skanowanie kodów kreskowych

Biblioteczka czyta kody EAN-13 z numerem ISBN (zaczynające się od 978 lub 979) z tyłu
okładki. Są dwa sposoby skanowania:

- **Skanowanie na żywo aparatem** – wymaga, żeby Home Assistant był otwarty przez
  **HTTPS** (adres zaczyna się od `https://`), np. przez Home Assistant Cloud (Nabu Casa)
  albo własną domenę z certyfikatem. To ograniczenie przeglądarek: przy adresie
  `http://homeassistant.local:8123` albo `http://192.168.…` strony nie mają dostępu do
  aparatu.
- **Zdjęcie kodu** – działa zawsze, także przez zwykłe HTTP: robisz zdjęcie kodu (albo
  wybierasz je z galerii), a Biblioteczka odczytuje z niego numer. Zdjęcie służy tylko do
  odczytania kodu i nie jest nigdzie zapisywane.

Numer ISBN zawsze można też wpisać ręcznie.

Wskazówki:

- Aplikacja Home Assistant w domu zwykle łączy się z **adresem w sieci lokalnej**. Jeśli to
  adres `http://…`, skanowanie na żywo będzie dostępne tylko poza domem – w domu skorzystaj
  ze zdjęcia kodu albo ustaw w ustawieniach serwera w aplikacji Home Assistant adres
  wewnętrzny zaczynający się od `https://`.
- Aplikacja Home Assistant na Maca nie udostępnia aparatu stronom – tam działa tylko
  zdjęcie z pliku.
- Trzymaj książkę ok. 20 cm od aparatu, w dobrym świetle. Nowsze iPhone’y z serii Pro
  nie ostrzą z bliższej odległości.
- Kody czasopism (zaczynające się od 977) i inne kody kreskowe są rozpoznawane, ale nie
  da się z nich dodać książki.

## Import danych z aplikacji na iPhone’a

Bibliotekę z aplikacji Biblioteczka na iPhone’a można przenieść do Home Assistanta:

1. Na iPhonie, w aplikacji Biblioteczka: karta **Serie** → przycisk **…** (Więcej) →
   **Eksportuj do CSV**. Zapisz plik `Biblioteczka.csv` w aplikacji Pliki (albo wyślij go
   na komputer).
2. Otwórz Biblioteczkę w Home Assistancie (na telefonie lub komputerze), wejdź na kartę
   **Serie**, kliknij przycisk **…** (Więcej) w lewym górnym rogu i wybierz **Importuj
   z CSV**, a potem wskaż zapisany plik.
3. Po imporcie pojawi się podsumowanie: ile książek dodano, ile uzupełniono, ile
   pominięto i ewentualne błędy w poszczególnych wierszach.

Zasady importu:

- Książka jest uznawana za już istniejącą, gdy ma ten sam numer ISBN, a jeśli go nie
  ma (albo jest niepoprawny) – ten sam tytuł i autora. Taka książka nie jest dodawana
  drugi raz. Wiersz bez autora w serii, która ma autora, liczy się jako książka autora serii.
- Import niczego nie nadpisuje: uzupełnia tylko puste pola istniejących książek.
  Wiersz ze statusem „Mam” oznacza istniejącą brakującą książkę jako posiadaną.
- Import można bezpiecznie powtórzyć – nie powstaną duplikaty.
- Plik CSV nie zawiera okładek. Po imporcie wybierz w tym samym menu (**Serie → …**)
  polecenie **Pobierz brakujące okładki** – Biblioteczka pobierze je w tle dla wszystkich
  książek z numerem ISBN.

Poleceniem **Eksportuj do CSV** z tego samego menu wyeksportujesz bibliotekę z Home
Assistanta do pliku CSV (ten sam format co w aplikacji na iPhone’a, do otwarcia np. w Excelu lub Numbers).

## Kopie zapasowe

Baza danych i okładki są zapisane w prywatnym folderze danych aplikacji na urządzeniu
z Home Assistantem.

- Kopie zapasowe Home Assistanta (**Ustawienia → System → Kopie zapasowe**) domyślnie
  obejmują zainstalowane aplikacje razem z ich danymi, więc zawierają też Biblioteczkę.
  Sprawdź w ustawieniach automatycznej kopii zapasowej (sekcja **Dane w kopii zapasowej**),
  że Biblioteczka jest wśród zaznaczonych aplikacji.
- Na czas tworzenia kopii aplikacja jest na chwilę **zatrzymywana** i potem sama się
  uruchamia. Dzięki temu kopia bazy danych jest zawsze spójna. W tym czasie Biblioteczka
  jest niedostępna – zwykle kilka sekund, przy wielu okładkach nieco dłużej.
- Dodatkową, przenośną kopią jest eksport do CSV (bez okładek).

Przywrócenie kopii zapasowej Home Assistanta przywraca też bazę Biblioteczki.

## Aktualizacja

Home Assistant sam co jakiś czas sprawdza repozytorium Biblioteczki. Gdy pojawi się nowa
wersja, aktualizacja będzie czekać w **Ustawieniach** – zainstaluj ją jak każdą inną. Lista
zmian jest na karcie aplikacji. Żeby sprawdzić od razu, wybierz w **Sklepie z aplikacjami**
w menu **⋮** polecenie **Sprawdź aktualizacje**.

Dane zostają nienaruszone – baza danych jest automatycznie dostosowywana do nowej wersji
przy pierwszym uruchomieniu.

Po aktualizacji Biblioteczka otwarta w przeglądarce albo
w aplikacji Home Assistant pokaże komunikat „Dostępna jest nowa wersja Biblioteczki.” –
naciśnij **Odśwież**, żeby wczytać nową wersję.

## Prywatność

- Wszystkie dane biblioteczki (książki, serie, autorzy, notatki, okładki) są
  przechowywane wyłącznie na Twoim urządzeniu z Home Assistantem.
- Przy wyszukiwaniu książki do zewnętrznych serwisów wysyłany jest **wyłącznie numer
  ISBN**: do Biblioteki Narodowej (`data.bn.org.pl`), serwisu e-ISBN (`e-isbn.pl`)
  i Open Library (`openlibrary.org`, okładki z `covers.openlibrary.org`, który przekierowuje
  pobieranie obrazów do `archive.org`). Zapytania wysyła serwer aplikacji, a nie przeglądarka.
- Interfejs nie ładuje niczego z zewnętrznych serwerów, nie ma reklam ani statystyk.
- Zdjęcia kodów kreskowych służą tylko do odczytania numeru i nie są zapisywane.
- Dostęp ma każdy użytkownik Home Assistanta, któremu Biblioteczka jest widoczna na
  pasku bocznym – wszyscy mogą dodawać, zmieniać i usuwać książki.

## Rozwiązywanie problemów

- **„Brak połączenia z Home Assistant.”** – sprawdź na stronie aplikacji (**Ustawienia →
  Aplikacje → Biblioteczka**), czy jest uruchomiona, i zajrzyj na kartę **Log**.
- **Skanowanie na żywo jest niedostępne** – Home Assistant jest otwarty przez HTTP
  (zob. „Skanowanie kodów kreskowych”); użyj zdjęcia kodu.
- **Wyszukiwanie po ISBN nic nie znajduje** – nie każda książka jest w katalogach;
  uzupełnij dane ręcznie. Komunikat o braku połączenia oznacza, że Home Assistant nie
  ma w tej chwili dostępu do internetu.
- **Aplikacja nie pojawia się w sklepie** – sprawdź w **⋮ → Repozytoria**, czy adres
  repozytorium jest dodany bez literówki, wybierz **⋮ → Sprawdź aktualizacje**, odśwież
  stronę i przejrzyj logi Supervisora.
