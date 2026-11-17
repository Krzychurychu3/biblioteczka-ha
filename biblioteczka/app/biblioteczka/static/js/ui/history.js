// Jedna kolejka operacji na historii przeglądarki.
//
// Router (zmiany hasha) i warstwy (arkusze i dialogi mają własny wpis w historii,
// żeby systemowe „wstecz” – np. na Androidzie – zamykało arkusz zamiast ekranu)
// korzystają z historii równolegle. `history.go()` działa asynchronicznie, więc
// kolejne operacje czekają na zakończenie poprzedniej. Zamknięcia warstw mają
// pierwszeństwo: dopiero po zdjęciu ich wpisów router decyduje, czy cofnąć się
// w historii, czy podmienić adres.

const ops = [];
let layerPops = 0;
let scheduled = false;
let traversing = false;
let traverseTimer = 0;
// Ścieżka, na której powinno skończyć się bieżące cofnięcie „wstecz do rodzica” (null – bez kontroli).
let expectAfterTraverse = null;
// Dwa panele: wybór z listy, który jeszcze czeka na zapis w historii (przeglądanie strzałkami) –
// `{op, timer}`. Kolejne wybory zmieniają tylko jego adres, każda inna operacja zapisuje go najpierw.
let selection = null;
// Zmiany adresu zlecone przez tę kolejkę: ich synchroniczny `popstate` nie pochodzi od użytkownika.
let ownNavigation = 0;
// Dwa panele: w tym przebiegu kolejki zapisano wybór z listy. Router obsłuży `hashchange` dopiero po
// całym przebiegu i zobaczy tylko ostatni adres (oznaczyłby go nieaktualną ścieżką), więc od tej chwili
// nowe wpisy – razem z wpisem samego wyboru – oznacza kolejka: `bibFrom` to adres opuszczanego wpisu.
let selectionInRun = false;
// Trwa zapis wyboru z listy (także jego cofnięcie HISTORY-1): `popstate` tego zapisu tylko dogania
// trasę, którą już widać – nasłuchy dostają `selection: true` (np. menu otwarte w międzyczasie zostaje).
let selectionWrite = false;
const popListeners = new Set();

function urlWithHash(path) {
  return `${location.href.split('#')[0]}#${path}`;
}

function setOwnLocation(change) {
  ownNavigation += 1;
  try {
    change();
  } finally {
    ownNavigation -= 1;
  }
}

/** Zapisuje czekający wybór z listy (przed każdą inną operacją, żeby zachować kolejność). */
function commitSelection() {
  if (!selection) return;
  clearTimeout(selection.timer);
  ops.push(selection.op);
  selection = null;
  schedule();
}

function cancelSelection() {
  if (!selection) return;
  clearTimeout(selection.timer);
  selection = null;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(run, 0);
}

function startTraverse(delta) {
  traversing = true;
  // Gdy nie ma dokąd wrócić, `popstate` nie przyjdzie – nie blokujmy kolejki.
  traverseTimer = setTimeout(() => finishTraverse(), 700);
  history.go(delta);
}

/** `popped` – wywołane z `popstate` cofnięcia (history.state to wpis, na który wróciliśmy). */
function finishTraverse(popped = false) {
  clearTimeout(traverseTimer);
  // Najpierw koniec przejścia: location.replace niżej od razu wysyła zagnieżdżony `popstate`,
  // który ma się liczyć jako zewnętrzny.
  traversing = false;
  const expected = expectAfterTraverse;
  expectAfterTraverse = null;
  if (expected && location.hash !== '#' + expected) {
    // Dwa panele: wpis pod spodem został podmieniony (inny wybór z listy), a wpis „dalej” wciąż
    // wskazuje dawnego rodzica w `bibFrom`. Popraw adres i zachowaj `bibFrom` wpisu, na który
    // wróciliśmy (inaczej router oznaczyłby go ścieżką dziecka).
    const landed = popped ? history.state : null;
    setOwnLocation(() => location.replace(urlWithHash(expected)));
    if (landed && landed.bibRoute) {
      history.replaceState({ bibRoute: expected, bibFrom: landed.bibFrom ?? null }, '');
    }
  }
  run();
}

function run() {
  scheduled = false;
  while (!traversing) {
    selectionWrite = false;
    if (layerPops > 0) {
      const delta = -layerPops;
      layerPops = 0;
      startTraverse(delta);
      return;
    }
    const op = ops.shift();
    if (!op) {
      selectionInRun = false;
      return;
    }
    if (op.select) selectionInRun = selectionWrite = true;
    switch (op.type) {
      case 'push':
        if (location.hash !== '#' + op.path) {
          const from = (history.state && history.state.bibRoute) || location.hash.slice(1) || null;
          setOwnLocation(() => (location.hash = op.path));
          if (selectionInRun) history.replaceState({ bibRoute: op.path, bibFrom: from }, '');
        }
        break;
      case 'replace': {
        const state = history.state;
        if (op.keepFrom) {
          // Wybór z listy: ten sam adres (np. ↓ i ↑ z powrotem) – nie ma czego zapisywać.
          if (location.hash === '#' + op.path) break;
          // Wybór równy wpisowi pod spodem (klik w podświetlony wiersz z głębszego ekranu, ↓ i ↑
          // z powrotem na głębokości 2): cofnięcie zamiast dwóch takich samych wpisów obok siebie.
          if (state && state.bibRoute && !state.bibLayer && state.bibFrom === op.path) {
            expectAfterTraverse = op.path;
            startTraverse(-1);
            break;
          }
        }
        setOwnLocation(() => location.replace(urlWithHash(op.path)));
        // Dwa panele: zmiana wyboru na liście nie zmienia wpisu pod spodem, więc nowy adres
        // dziedziczy `bibFrom`. Tylko wpis już oznaczony (przez router albo kolejkę) – bez znacznika
        // router sam oznaczy wpis po `hashchange`.
        if (op.keepFrom && state && state.bibRoute) {
          history.replaceState({ bibRoute: op.path, bibFrom: state.bibFrom ?? null }, '');
        }
        break;
      }
      case 'back': {
        // Wróć do ekranu nadrzędnego: cofnięcie, jeśli bieżący wpis powstał
        // z przejścia z rodzica; w przeciwnym razie podmiana adresu.
        const state = history.state || {};
        if (state.bibFrom === op.parentPath && !state.bibLayer) {
          // Po cofnięciu sprawdzamy, czy naprawdę jesteśmy u rodzica (finishTraverse).
          expectAfterTraverse = op.parentPath;
          startTraverse(-1);
        } else setOwnLocation(() => location.replace(urlWithHash(op.parentPath)));
        break;
      }
      case 'layer':
        op.pushed = true;
        history.pushState({ ...(history.state || {}), bibLayer: op.layerId }, '', location.href);
        break;
      default:
        break;
    }
  }
}

/** Nowy wpis z podanym hashem (ścieżka bez `#`). */
export function historyPush(path) {
  commitSelection();
  ops.push({ type: 'push', path });
  schedule();
}

/**
 * Podmiana bieżącego wpisu na podany hash. `keepFrom` – nowy adres zachowuje `bibFrom`
 * podmienianego wpisu (wybór pozycji z listy w trybie dwóch paneli).
 */
export function historyReplace(path, { keepFrom = false } = {}) {
  commitSelection();
  ops.push({ type: 'replace', path, keepFrom });
  schedule();
}

/**
 * Dwa panele: wybór pozycji z listy. `push` – nowy wpis (nic nie było wybrane), inaczej podmiana
 * z zachowaniem `bibFrom`. `delay` (ms) – zapis dopiero po tylu ms bez kolejnego wyboru: przeglądanie
 * strzałkami nie zasypuje historii (Chrome po ~200 operacjach w 10 s zaczyna je po cichu pomijać,
 * WebKit rzuca wyjątek). Wybory w tym czasie łączą się w jedną operację: rodzaj – pierwszego, adres –
 * ostatniego. Każda inna operacja albo wybór bez opóźnienia zapisuje czekający wybór od razu.
 */
export function historySelect(path, { push = false, delay = 0 } = {}) {
  if (selection) {
    clearTimeout(selection.timer);
    selection.op.path = path;
  } else {
    const op = push ? { type: 'push', path } : { type: 'replace', path, keepFrom: true };
    selection = { op: { ...op, select: true }, timer: 0 };
  }
  if (delay > 0) selection.timer = setTimeout(commitSelection, delay);
  else commitSelection();
}

/** Powrót do ekranu nadrzędnego (decyzja zapada w chwili wykonania operacji). */
export function historyBack(parentPath) {
  commitSelection();
  ops.push({ type: 'back', parentPath });
  schedule();
}

/** Wpis w historii dla otwieranej warstwy. Zwraca żeton dla `historyPopLayer`. */
export function historyPushLayer(layerId) {
  commitSelection();
  const op = { type: 'layer', layerId, pushed: false };
  ops.push(op);
  schedule();
  return op;
}

/** Zdejmuje wpis zamykanej warstwy (albo anuluje jego dodanie, jeśli jeszcze czeka). */
export function historyPopLayer(token) {
  if (!token) return;
  commitSelection();
  if (!token.pushed) {
    const index = ops.indexOf(token);
    if (index >= 0) ops.splice(index, 1);
    return;
  }
  layerPops += 1;
  schedule();
}

/** Najwięcej wpisów warstw zdejmowanych przy starcie (arkusz, nad nim dialog…). */
const MAX_ORPHAN_LAYERS = 8;

function stripLayerState() {
  const { bibLayer, ...rest } = history.state;
  history.replaceState(rest, '');
}

/**
 * Przy starcie strony (app.js, przed pierwszym renderem): wpisy warstw sprzed przeładowania
 * nie mają już swoich arkuszy. Schodzi z nich w historii (jak przy zamknięciu arkusza), żeby
 * pierwsze „wstecz” – w aplikacji, w przeglądarce albo systemowe na Androidzie – nie trafiało
 * w ten sam ekran. Adresy wpisów są takie same, więc nie ma `hashchange` ani przeładowania.
 * Dialog nad arkuszem zostawia dwa wpisy. Gdy nie ma dokąd wrócić, tylko usuwa znacznik warstwy.
 * Zwraca Promise rozwiązywany po zejściu z ostatniego wpisu warstwy.
 */
export function historyLeaveOrphanLayers({ timeout = 700 } = {}) {
  return new Promise((resolve) => {
    let steps = 0;
    const step = () => {
      if (!history.state || !history.state.bibLayer) {
        resolve();
        return;
      }
      if (steps >= MAX_ORPHAN_LAYERS) {
        stripLayerState();
        resolve();
        return;
      }
      steps += 1;
      let timer = 0;
      const finish = (popped) => {
        removeEventListener('popstate', onPop);
        clearTimeout(timer);
        if (popped) {
          step();
          return;
        }
        if (history.state && history.state.bibLayer) stripLayerState();
        resolve();
      };
      const onPop = () => finish(true);
      addEventListener('popstate', onPop);
      timer = setTimeout(() => finish(false), timeout);
      history.back();
    };
    step();
  });
}

/**
 * Nasłuch `popstate`; `internal` = przejście zlecone przez tę kolejkę, `external` = przejście
 * użytkownika (wstecz/dalej przeglądarki, wpisany adres), a nie zmiana adresu z tej kolejki.
 * `selection` = zapis adresu wyboru z listy (dwa panele), który tylko dogania widoczną już trasę.
 */
export function onHistoryPop(listener) {
  popListeners.add(listener);
  return () => popListeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => {
    const internal = traversing;
    const external = !traversing && ownNavigation === 0;
    const selection = selectionWrite;
    // Wstecz/dalej w trakcie przeglądania listy: czekający wybór nie może potem podmienić wpisu,
    // na który użytkownik właśnie przeszedł.
    if (external) cancelSelection();
    for (const listener of popListeners) {
      try {
        listener({ state: event.state, internal, external, selection });
      } catch (error) {
        console.error(error);
      }
    }
    if (internal) finishTraverse(true);
  });
}
