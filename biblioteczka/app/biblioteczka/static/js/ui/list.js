// Listy w stylu iOS „inset grouped”: sekcje, wiersze z akcjami (menu „…”, menu kontekstowe,
// przesunięcie palcem jak swipe actions), przyciski w wierszach, znaczniki.

import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { openMenu } from './menu.js';
import { haptic, uid, useChangePulse } from './a11y.js';

/**
 * ListSection({header, footer, children, plain, className, id})
 * Karta z zaokrąglonymi rogami na grupowanym tle. `plain` – bez tła karty
 * (np. kafelki statystyk, przełącznik filtrów). `header`/`footer` mogą być tekstem albo elementem.
 */
export function ListSection({ header, footer, children, plain = false, className = '', id, label }) {
  const headerId = useRef(uid('section')).current;
  return html`<section
    class=${`section ${plain ? 'section-plain' : ''} ${className}`}
    id=${id}
    aria-labelledby=${header ? headerId : undefined}
    aria-label=${!header && label ? label : undefined}
  >
    ${header && html`<h2 class="section-header" id=${headerId}>${header}</h2>`}
    <div class="section-body">${children}</div>
    ${footer && html`<div class="section-footer">${footer}</div>`}
  </section>`;
}

/**
 * Przypis z ikoną (stopka sekcji, ostrzeżenie pod polem).
 * Note({icon, tone: 'secondary'|'warning'|'success'|'accent', children})
 */
export function Note({ icon, tone = 'secondary', children, className = '', role }) {
  return html`<p class=${`note tone-${tone} ${className}`} role=${role}>
    ${icon ? Icon(icon, { className: 'note-icon' }) : null}
    <span class="note-text">${children}</span>
  </p>`;
}

/** Mała etykieta „Brakuje”. */
export function MissingBadge({ label = 'Brakuje' }) {
  return html`<span class="badge badge-missing">${label}</span>`;
}

/** Kółko „mam / brakuje” (OwnedToggle): jedno stuknięcie zmienia status. */
export function OwnedToggle({ owned, onToggle, disabled = false }) {
  const hintId = useRef(uid('owned-hint')).current;
  const pulse = useChangePulse(owned);
  useEffect(() => {
    if (pulse) haptic('selection');
  }, [pulse]);
  return html`<button
    type="button"
    class=${`owned-toggle ${owned ? 'is-owned' : ''} ${pulse ? 'is-pulsing' : ''}`}
    aria-label=${owned ? 'Posiadana' : 'Brakuje'}
    aria-describedby=${hintId}
    disabled=${disabled}
    onClick=${(event) => {
      event.stopPropagation();
      onToggle?.();
    }}
  >
    ${Icon(owned ? 'check-circle' : 'circle')}
    <span class="visually-hidden" id=${hintId}>Zmienia status książki</span>
  </button>`;
}

/**
 * Wiersz-przycisk w sekcji (np. „Dodaj pierwszy tom”, „Usuń serię”).
 * ListButton({label, icon, role: 'destructive', onClick, disabled, align: 'start'|'center'})
 */
export function ListButton({ label, icon, role, onClick, disabled = false, align = 'start', children, className = '' }) {
  return html`<button
    type="button"
    class=${`cell list-button ${role === 'destructive' ? 'is-destructive' : ''} align-${align} ${className}`}
    disabled=${disabled}
    onClick=${onClick}
  >
    ${icon ? Icon(icon, { className: 'list-button-icon' }) : null}
    <span class="list-button-label">${children ?? label}</span>
  </button>`;
}

/** Zwykła komórka sekcji na dowolną treść (np. tekst notatek). */
export function ListCell({ children, className = '' }) {
  return html`<div class=${`cell list-cell ${className}`}>${children}</div>`;
}

// ---------------------------------------------------------------------------
// ListRow
// ---------------------------------------------------------------------------

const ACTION_WIDTH = 76;
const LONG_PRESS_MS = 520;
let openRowCloser = null;

function closeOpenRow() {
  if (openRowCloser) openRowCloser();
}

function actionTint(action) {
  if (action.tint) return action.tint;
  return action.role === 'destructive' ? 'red' : 'gray';
}

/**
 * Wiersz listy.
 * ListRow({onClick, href, leading, title, subtitle, detail, trailing, chevron, dimmed, selected, actions,
 *          actionsLabel, ariaLabel, className})
 * - `title` (tekst lub element), `subtitle` (druga linia), `detail` (trzecia linia, dowolny element);
 * - `leading` – okładka/awatar/ikona; `trailing` – element po prawej (np. OwnedToggle);
 * - `chevron` – strzałka przejścia (wiersze otwierające ekran szczegółów);
 * - `selected` – pozycja wybrana na liście w trybie dwóch paneli (wyróżnienie, `aria-current`);
 * - `actions` – pozycje jak w Menu; zawsze dostępne z przycisku „…”, prawym przyciskiem myszy,
 *   długim przytrzymaniem i klawiszem menu kontekstowego. Akcje z `swipe: 'leading'|'trailing'`
 *   pojawiają się po przesunięciu wiersza palcem (`tint`: 'green'|'orange'|'red'|'indigo'|'gray',
 *   `fullSwipe: true` – pełne przesunięcie wykonuje pierwszą akcję po tej stronie).
 */
export function ListRow({
  onClick,
  href,
  leading,
  title,
  subtitle,
  detail,
  trailing,
  chevron = false,
  dimmed = false,
  selected = false,
  actions,
  actionsLabel = 'Akcje',
  ariaLabel,
  className = '',
}) {
  const rowRef = useRef(null);
  const slideRef = useRef(null);
  const moreRef = useRef(null);
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const [openSide, setOpenSide] = useState(null);

  const list = (actions || []).filter((a) => a && !a.hidden && !a.divider && !a.header);
  const menuItems = (actions || []).filter((a) => a && !a.hidden);
  const leadingActions = list.filter((a) => a.swipe === 'leading');
  const trailingActions = list.filter((a) => a.swipe === 'trailing');
  const hasMenu = list.length > 0;

  const setOffset = (px, animate) => {
    const slide = slideRef.current;
    if (!slide) return;
    slide.style.transition = animate ? '' : 'none';
    slide.style.transform = px ? `translate3d(${px}px,0,0)` : '';
    rowRef.current?.style.setProperty('--swipe', `${Math.abs(px)}px`);
    rowRef.current?.classList.toggle('is-swiping', px !== 0);
    rowRef.current?.classList.toggle('is-dragging', !animate && px !== 0);
    rowRef.current?.classList.toggle('swipe-leading', px > 0);
    rowRef.current?.classList.toggle('swipe-trailing', px < 0);
  };

  // Stała funkcja zamykająca (porównywana z `openRowCloser` między renderami).
  const close = useRef(() => {
    setOffset(0, true);
    setOpenSide(null);
    if (openRowCloser === close) openRowCloser = null;
  }).current;

  const openTo = (side) => {
    if (openRowCloser && openRowCloser !== close) openRowCloser();
    const count = side === 'leading' ? leadingActions.length : trailingActions.length;
    setOffset((side === 'leading' ? 1 : -1) * count * ACTION_WIDTH, true);
    setOpenSide(side);
    openRowCloser = close;
  };

  // Stuknięcie gdziekolwiek indziej zamyka odsłonięte akcje.
  useEffect(() => {
    if (!openSide) return undefined;
    const onDown = (event) => {
      if (rowRef.current && !rowRef.current.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [openSide]);

  useEffect(() => () => {
    if (openRowCloser === close) openRowCloser = null;
  }, []);

  const showMenu = (opts = {}) => {
    if (!hasMenu) return;
    close();
    openMenu({ items: menuItems, label: actionsLabel, ...opts });
  };

  const runAction = (action) => {
    close();
    if (action.disabled) return;
    try {
      action.onClick?.();
    } catch (error) {
      console.error(error);
    }
  };

  // Po geście (przesunięcie, przytrzymanie) przeglądarka może jeszcze wysłać „click”.
  const suppressBriefly = () => {
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 450);
  };

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' || event.button > 0) return;
    const g = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: openSide === 'leading' ? leadingActions.length * ACTION_WIDTH : openSide === 'trailing' ? -trailingActions.length * ACTION_WIDTH : 0,
      mode: 'pending',
      offset: 0,
      timer: 0,
    };
    if (hasMenu) {
      g.timer = setTimeout(() => {
        if (gesture.current !== g || g.mode !== 'pending') return;
        g.mode = 'longpress';
        haptic('selection');
        showMenu({ anchor: rowRef.current, align: 'start', focusFirst: false });
      }, LONG_PRESS_MS);
    }
    gesture.current = g;
  };

  const onPointerMove = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (g.mode === 'pending') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        clearTimeout(g.timer);
        g.mode = 'scroll';
        return;
      }
      const canSwipe = g.base !== 0 || (dx > 0 ? leadingActions.length : trailingActions.length) > 0;
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2 && canSwipe) {
        clearTimeout(g.timer);
        g.mode = 'swipe';
        g.x = event.clientX;
        try {
          slideRef.current?.setPointerCapture(event.pointerId);
        } catch {
          // Bez przechwycenia wskaźnika gest działa, dopóki palec jest nad wierszem.
        }
      } else if (Math.abs(dx) > 10) {
        clearTimeout(g.timer);
        g.mode = 'scroll';
      }
      return;
    }
    if (g.mode !== 'swipe') return;
    event.preventDefault();
    let offset = g.base + (event.clientX - g.x);
    const maxLeading = leadingActions.length * ACTION_WIDTH;
    const maxTrailing = trailingActions.length * ACTION_WIDTH;
    const width = rowRef.current ? rowRef.current.offsetWidth : 320;
    const limitLeading = leadingActions.some((a) => a.fullSwipe) ? width : maxLeading;
    const limitTrailing = trailingActions.some((a) => a.fullSwipe) ? width : maxTrailing;
    // Opór (rubber band) za ostatnią akcją.
    if (offset > limitLeading) offset = limitLeading + (offset - limitLeading) * 0.25;
    if (offset < -limitTrailing) offset = -limitTrailing + (offset + limitTrailing) * 0.25;
    if (!maxLeading && offset > 0) offset *= 0.2;
    if (!maxTrailing && offset < 0) offset *= 0.2;
    g.offset = offset;
    const full = width * 0.55;
    rowRef.current?.classList.toggle(
      'is-full-swipe',
      (offset > full && leadingActions[0]?.fullSwipe) || (offset < -full && trailingActions[0]?.fullSwipe) || false,
    );
    setOffset(offset, false);
  };

  const onPointerUp = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    clearTimeout(g.timer);
    gesture.current = null;
    if (g.mode === 'longpress') {
      suppressBriefly();
      return;
    }
    if (g.mode !== 'swipe') return;
    suppressBriefly();
    rowRef.current?.classList.remove('is-full-swipe');
    const width = rowRef.current ? rowRef.current.offsetWidth : 320;
    const offset = g.offset;
    if (offset > width * 0.55 && leadingActions[0]?.fullSwipe) {
      haptic('selection');
      runAction(leadingActions[0]);
    } else if (offset < -width * 0.55 && trailingActions[0]?.fullSwipe) {
      haptic('selection');
      runAction(trailingActions[0]);
    } else if (offset > (leadingActions.length * ACTION_WIDTH) / 2 && leadingActions.length) {
      openTo('leading');
    } else if (offset < -(trailingActions.length * ACTION_WIDTH) / 2 && trailingActions.length) {
      openTo('trailing');
    } else {
      close();
    }
  };

  const onPointerCancel = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    clearTimeout(g.timer);
    gesture.current = null;
    if (g.mode === 'swipe') {
      if (openSide) openTo(openSide);
      else close();
    }
  };

  const onClickCapture = (event) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (openSide) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onContextMenu = (event) => {
    if (!hasMenu) return;
    event.preventDefault();
    if (event.pointerType === 'touch' || (gesture.current && gesture.current.mode === 'longpress')) return;
    if (event.button === 0 && event.clientX === 0 && event.clientY === 0) {
      showMenu({ anchor: rowRef.current, align: 'start', focusFirst: true });
    } else {
      showMenu({ point: { x: event.clientX, y: event.clientY } });
    }
  };

  const onMainKeyDown = (event) => {
    if (!hasMenu) return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      showMenu({ anchor: rowRef.current, align: 'start', focusFirst: true });
    }
  };

  const onMainClick = (event) => {
    if (href) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      if (onClick) {
        event.preventDefault();
        onClick(event);
      }
      return;
    }
    onClick?.(event);
  };

  const body = html`
    ${leading && html`<span class="row-leading">${leading}</span>`}
    <span class="row-body">
      <span class="row-text">
        <span class="row-title">${title}</span>
        ${subtitle && html`<span class="row-subtitle">${subtitle}</span>`}
        ${detail && html`<span class="row-detail">${detail}</span>`}
      </span>
      ${chevron && Icon('chevron', { className: 'row-chevron' })}
    </span>
  `;

  const interactive = Boolean(onClick || href);
  const main = href
    ? html`<a
        class="row-main"
        href=${href}
        aria-label=${ariaLabel}
        aria-current=${selected ? 'true' : undefined}
        onClick=${onMainClick}
        onKeyDown=${onMainKeyDown}
      >${body}</a>`
    : interactive
      ? html`<button
          type="button"
          class="row-main"
          aria-label=${ariaLabel}
          aria-current=${selected ? 'true' : undefined}
          onClick=${onMainClick}
          onKeyDown=${onMainKeyDown}
        >
          ${body}
        </button>`
      : html`<div class="row-main is-static">${body}</div>`;

  const swipeButtons = (side, items) =>
    items.length
      ? html`<div class=${`row-swipe row-swipe-${side}`} aria-hidden="true">
          ${items.map(
            (action, i) => html`<button
              type="button"
              tabindex="-1"
              key=${i}
              class=${`swipe-btn tint-${actionTint(action)}`}
              style=${`--i:${i}`}
              onClick=${(event) => {
                event.stopPropagation();
                runAction(action);
              }}
            >
              ${action.icon ? Icon(action.icon) : null}
              <span>${action.label}</span>
            </button>`,
          )}
        </div>`
      : null;

  return html`<div
    ref=${rowRef}
    class=${`cell row ${interactive ? 'is-interactive' : ''} ${dimmed ? 'is-dimmed' : ''}${selected ? ' is-selected' : ''} ${hasMenu ? 'has-actions' : ''} ${className}`}
    onContextMenu=${onContextMenu}
  >
    ${swipeButtons('leading', leadingActions)} ${swipeButtons('trailing', [...trailingActions].reverse())}
    <div
      class="row-slide"
      ref=${slideRef}
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${onPointerUp}
      onPointerCancel=${onPointerCancel}
      onClickCapture=${onClickCapture}
    >
      ${main}
      ${(trailing || hasMenu) &&
      html`<span class="row-trailing">
        ${trailing}
        ${hasMenu &&
        html`<button
          type="button"
          ref=${moreRef}
          class="row-more"
          aria-label=${actionsLabel}
          aria-haspopup="menu"
          onClick=${(event) => {
            event.stopPropagation();
            showMenu({ anchor: moreRef.current, align: 'end', focusFirst: event.detail === 0 });
          }}
        >
          ${Icon('ellipsis')}
        </button>`}
      </span>`}
    </div>
  </div>`;
}

export { closeOpenRow };
