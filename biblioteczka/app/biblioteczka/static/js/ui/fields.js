// Pola formularzy: tekst (TextField), liczba (NumberField – reguły iOS NumberRow),
// podpowiedzi (SuggestionList) i pole z podpowiedziami (SuggestionField).
// Każde pole to wiersz (`.cell`) wewnątrz ListSection.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { uid } from './a11y.js';
import { applyNumberInput, numberText, stepNumber } from './pure.js';

function assignRef(ref, value) {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else ref.current = value;
}

function autosize(el, maxRows) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  const style = getComputedStyle(el);
  const line = parseFloat(style.lineHeight) || 22;
  const extra = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  el.style.height = 'auto';
  const max = line * maxRows + extra;
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}

/**
 * TextField({value, onInput, placeholder, label, multiline, rows=2, maxRows=6, size: 'body'|'title',
 *            mono, align: 'start'|'end', clearable=true, autofocus, inputMode, enterKeyHint,
 *            autocapitalize='words', onEnter, onFocus, onBlur, onKeyDown, inputRef, id, ariaLabel,
 *            ariaDescribedby, disabled, trailing, type='text', inputProps, className})
 * - `onInput(text, event)` przy każdej zmianie;
 * - `onEnter(event)` – Enter w polu jednowierszowym (np. przejście do następnego pola, wyszukanie ISBN);
 * - `label` – etykieta z lewej (wiersz „ISBN …”), pole wyrównane wtedy do prawej;
 * - przycisk „Wyczyść” widać, gdy pole ma fokus i nie jest puste (jak w iOS – także same spacje).
 */
export function TextField({
  value = '',
  onInput,
  placeholder,
  label,
  multiline = false,
  rows = 2,
  maxRows = 6,
  size = 'body',
  mono = false,
  align,
  clearable = true,
  autofocus = false,
  inputMode,
  enterKeyHint,
  autocapitalize = 'words',
  onEnter,
  onFocus,
  onBlur,
  onKeyDown,
  inputRef,
  id,
  ariaLabel,
  ariaDescribedby,
  disabled = false,
  trailing,
  type = 'text',
  inputProps = {},
  className = '',
}) {
  const ref = useRef(null);
  const fieldId = useRef(id || uid('field')).current;
  const [focused, setFocused] = useState(false);
  const textAlign = align || (label ? 'end' : 'start');

  useLayoutEffect(() => {
    assignRef(inputRef, ref.current);
    return () => assignRef(inputRef, null);
  }, [inputRef]);

  // Atrybut (nie właściwość): Safari rozumie „off”, a właściwość w Chrome jest logiczna.
  useLayoutEffect(() => {
    ref.current?.setAttribute('autocorrect', 'off');
  }, [multiline]);

  useEffect(() => {
    if (autofocus && ref.current) ref.current.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (multiline) autosize(ref.current, maxRows);
  }, [value, multiline, maxRows]);

  const handleInput = (event) => {
    if (multiline) autosize(event.currentTarget, maxRows);
    onInput?.(event.currentTarget.value, event);
  };

  const handleKeyDown = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && !multiline && !event.isComposing && onEnter) {
      event.preventDefault();
      onEnter(event);
    }
  };

  const clear = () => {
    onInput?.('', null);
    ref.current?.focus({ preventScroll: true });
  };

  const common = {
    id: fieldId,
    ref,
    class: `field-input size-${size} ${mono ? 'is-mono' : ''} align-${textAlign}`,
    value,
    placeholder,
    disabled,
    autocomplete: 'off',
    autocapitalize,
    spellcheck: false,
    inputMode,
    enterKeyHint,
    'aria-label': label ? undefined : ariaLabel || placeholder,
    'aria-describedby': ariaDescribedby,
    onInput: handleInput,
    onKeyDown: handleKeyDown,
    onFocus: (event) => {
      setFocused(true);
      onFocus?.(event);
    },
    onBlur: (event) => {
      setFocused(false);
      onBlur?.(event);
    },
    ...inputProps,
  };

  const input = multiline
    ? html`<textarea rows=${rows} ...${common}></textarea>`
    : html`<input type=${type} ...${common} />`;

  const showClear = clearable && !multiline && !disabled && focused && String(value ?? '') !== '';

  return html`<div
    class=${`cell field-row ${label ? 'has-label' : ''} ${multiline ? 'is-multiline' : ''} ${focused ? 'is-focused' : ''} ${className}`}
  >
    ${label && html`<label class="field-label" for=${fieldId}>${label}</label>`}
    ${input}
    ${showClear &&
    html`<button
      type="button"
      class="field-clear"
      aria-label="Wyczyść"
      tabindex="-1"
      onPointerDown=${(event) => event.preventDefault()}
      onMouseDown=${(event) => event.preventDefault()}
      onClick=${clear}
    >
      ${Icon('xmark-circle')}
    </button>`}
    ${trailing}
  </div>`;
}

/**
 * NumberField({value, onChange, min=0, max=999, stepper=false, label, placeholder, inputRef,
 *              onEnter, disabled, id})
 * Reguły iOS NumberRow: 0 = „brak” (puste pole z podpowiedzią), tylko cyfry ASCII, najwyżej 4,
 * wartość przycinana do zakresu (wpisanie 1500 przy max 999 pokazuje „999”), przyciski −/+
 * zmieniają wartość w zakresie. `onChange(liczba)` – 0 oznacza brak wartości.
 */
export function NumberField({
  value,
  onChange,
  min = 0,
  max = 999,
  stepper = false,
  label,
  placeholder,
  inputRef,
  onEnter,
  disabled = false,
  id,
  className = '',
}) {
  const ref = useRef(null);
  const fieldId = useRef(id || uid('num')).current;
  const numeric = Number.isFinite(Number(value)) ? Math.trunc(Number(value) || 0) : 0;
  const [text, setText] = useState(() => numberText(numeric));

  useLayoutEffect(() => {
    assignRef(inputRef, ref.current);
    return () => assignRef(inputRef, null);
  }, [inputRef]);

  // Zmiana wartości z zewnątrz (przyciski, dane z katalogu) aktualizuje tekst.
  useEffect(() => {
    const shown = text ? parseInt(text, 10) : 0;
    if (shown !== numeric) setText(numberText(numeric));
  }, [numeric]);

  const commit = (next) => {
    if (next !== numeric) onChange?.(next);
  };

  const onInput = (event) => {
    const result = applyNumberInput(event.currentTarget.value, min, max);
    if (event.currentTarget.value !== result.text) event.currentTarget.value = result.text;
    setText(result.text);
    commit(result.value);
  };

  const step = (delta) => {
    const next = stepNumber(numeric, delta, min, max);
    setText(numberText(next));
    commit(next);
  };

  const onKeyDown = (event) => {
    if (stepper && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      step(event.key === 'ArrowUp' ? 1 : -1);
    } else if (event.key === 'Enter' && onEnter && !event.isComposing) {
      event.preventDefault();
      onEnter(event);
    }
  };

  return html`<div class=${`cell field-row number-row has-label ${stepper ? 'has-stepper' : ''} ${className}`}>
    <label class="field-label" for=${fieldId}>${label}</label>
    <input
      id=${fieldId}
      ref=${ref}
      class="field-input number-input align-end"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete="off"
      enterkeyhint=${onEnter ? 'next' : 'done'}
      value=${text}
      placeholder=${placeholder}
      disabled=${disabled}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
    />
    ${stepper &&
    html`<span class="stepper" role="group" aria-label=${label}>
      <button
        type="button"
        class="stepper-btn"
        aria-label="Zmniejsz"
        disabled=${disabled || numeric <= min}
        onClick=${() => step(-1)}
      >
        ${Icon('minus')}
      </button>
      <span class="stepper-sep" aria-hidden="true"></span>
      <button
        type="button"
        class="stepper-btn"
        aria-label="Zwiększ"
        disabled=${disabled || numeric >= max}
        onClick=${() => step(1)}
      >
        ${Icon('plus')}
      </button>
    </span>`}
  </div>`;
}

/**
 * Jednorazowo wywołuje `callback(event)`, gdy wskaźnik `pointerId` zostanie puszczony albo anulowany –
 * gdziekolwiek na stronie (nasłuch na `target` – domyślnie na dokumencie – w fazie przechwytywania).
 * Mysz wciśnięta na liście i puszczona poza nią też się liczy. Zwraca funkcję rezygnującą z nasłuchu.
 */
export function onPointerRelease(pointerId, callback, target = document) {
  // Opcje jako obiekt (nie `true`) – tak samo w przeglądarce i w EventTarget z node (testy).
  const capture = { capture: true };
  const handler = (event) => {
    if (pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== pointerId) return;
    stop();
    callback(event);
  };
  const stop = () => {
    target.removeEventListener('pointerup', handler, capture);
    target.removeEventListener('pointercancel', handler, capture);
  };
  target.addEventListener('pointerup', handler, capture);
  target.addEventListener('pointercancel', handler, capture);
  return stop;
}

/**
 * SuggestionList({items: [{id, title, subtitle, icon}], onPick, listId, activeIndex, onHover, onPointerState})
 * Wiersze podpowiedzi pod polem (ikona w kolorze akcentu, tytuł, podtytuł, strzałka ↖).
 * Wciśnięcie nie zabiera fokusu polu, więc wybór nie ginie przy utracie fokusu.
 * `onPointerState(true)` przy wciśnięciu na liście, `onPointerState(false)` po puszczeniu – także poza listą.
 */
export function SuggestionList({ items = [], onPick, listId, activeIndex = -1, onHover, onPointerState, label }) {
  const hintId = useRef(uid('sugg-hint')).current;
  const ownId = useRef(listId || uid('sugg')).current;
  if (!items.length) return null;
  return html`<div
    class="suggestion-list"
    id=${ownId}
    role="listbox"
    aria-label=${label || 'Podpowiedzi'}
    onPointerDown=${(event) => {
      event.preventDefault();
      onPointerState?.(true);
      // Puszczenie przycisku poza listą nie trafia do listy – bez tego pole „trzymałoby” fokus
      // i lista zostałaby otwarta po przejściu do innego pola.
      onPointerRelease(event.pointerId, () => onPointerState?.(false));
    }}
    onMouseDown=${(event) => event.preventDefault()}
  >
    <span class="visually-hidden" id=${hintId}>Wybiera podpowiedź</span>
    ${items.map(
      (item, i) => html`<div
        key=${item.id ?? i}
        id=${`${ownId}-${i}`}
        class=${`cell suggestion ${i === activeIndex ? 'is-active' : ''}`}
        role="option"
        aria-selected=${i === activeIndex ? 'true' : 'false'}
        aria-describedby=${hintId}
        onMouseEnter=${() => onHover?.(i)}
        onClick=${() => onPick?.(item)}
      >
        <span class="suggestion-icon">${Icon(item.icon || 'person-fill')}</span>
        <span class="suggestion-text">
          <span class="suggestion-title">${item.title}</span>
          ${item.subtitle && html`<span class="suggestion-subtitle">${item.subtitle}</span>`}
        </span>
        ${Icon('arrow-up-left', { className: 'suggestion-arrow' })}
      </div>`,
    )}
  </div>`;
}

/**
 * Pole z podpowiedziami (iOS SuggestionField): podpowiedzi widać tylko, gdy pole ma fokus.
 * SuggestionField({value, onInput, suggestions, onPick, …props TextField})
 * Strzałki ↑/↓ wybierają podpowiedź, Enter ją wstawia (bez wybranej – `onEnter`),
 * Esc odznacza podpowiedź. Zwraca dwa wiersze sekcji: pole i listę.
 */
export function SuggestionField({ suggestions = [], onPick, onFocus, onBlur, onKeyDown, inputRef, ...fieldProps }) {
  const listId = useRef(uid('sugg-list')).current;
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const pointerInList = useRef(false);
  const inputEl = useRef(null);
  const signature = suggestions.map((s) => s.id ?? s.title).join('\u0001');

  useEffect(() => setActive(-1), [signature]);

  const visible = focused && suggestions.length > 0;

  const pick = (item) => {
    setActive(-1);
    onPick?.(item);
  };

  const handleKeyDown = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !visible) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === 'Enter' && active >= 0 && !event.isComposing) {
      event.preventDefault();
      pick(suggestions[active]);
    } else if (event.key === 'Escape' && active >= 0) {
      event.preventDefault();
      setActive(-1);
    }
  };

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const outerRef = useRef(inputRef);
  outerRef.current = inputRef;
  const setRef = useRef((el) => {
    inputEl.current = el;
    assignRef(outerRef.current, el);
  }).current;

  return [
    html`<${TextField}
      key="field"
      ...${fieldProps}
      inputRef=${setRef}
      onKeyDown=${handleKeyDown}
      onFocus=${(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur=${(event) => {
        if (!pointerInList.current) setFocused(false);
        onBlur?.(event);
      }}
      inputProps=${{
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': visible ? 'true' : 'false',
        'aria-controls': listId,
        'aria-activedescendant': visible && active >= 0 ? `${listId}-${active}` : undefined,
        ...(fieldProps.inputProps || {}),
      }}
    />`,
    visible
      ? html`<${SuggestionList}
          key="list"
          items=${suggestions}
          listId=${listId}
          activeIndex=${active}
          onHover=${setActive}
          onPick=${pick}
          onPointerState=${(down) => {
            pointerInList.current = down;
            if (!down) {
              // Po stuknięciu: jeśli fokus i tak opuścił pole, schowaj podpowiedzi.
              setTimeout(() => {
                if (document.activeElement !== inputEl.current) setFocused(false);
              }, 0);
            }
          }}
        />`
      : null,
  ];
}

/**
 * Pole wyszukiwania pod dużym tytułem (iOS `.searchable`): lupa, „Wyczyść”, bez autokorekty.
 * SearchField({value, onInput, placeholder, autofocus, inputRef, onEnter, label})
 */
export function SearchField({ value = '', onInput, placeholder, autofocus = false, inputRef, onEnter, label, className = '' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    assignRef(inputRef, ref.current);
    ref.current?.setAttribute('autocorrect', 'off');
    return () => assignRef(inputRef, null);
  }, [inputRef]);
  useEffect(() => {
    if (autofocus && ref.current) ref.current.focus({ preventScroll: true });
  }, []);
  return html`<div class=${`search-field ${className}`} role="search">
    ${Icon('search', { className: 'search-field-icon' })}
    <input
      ref=${ref}
      type="search"
      class="search-field-input"
      value=${value}
      placeholder=${placeholder}
      aria-label=${label || placeholder}
      autocomplete="off"
      autocapitalize="none"
      spellcheck=${false}
      enterkeyhint="search"
      onInput=${(event) => onInput?.(event.currentTarget.value, event)}
      onKeyDown=${(event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          onEnter?.(event);
          event.currentTarget.blur();
        } else if (event.key === 'Escape' && value) {
          event.preventDefault();
          onInput?.('', null);
        }
      }}
    />
    ${value &&
    html`<button
      type="button"
      class="field-clear"
      aria-label="Wyczyść"
      onPointerDown=${(event) => event.preventDefault()}
      onClick=${() => {
        onInput?.('', null);
        ref.current?.focus({ preventScroll: true });
      }}
    >
      ${Icon('xmark-circle')}
    </button>`}
  </div>`;
}
