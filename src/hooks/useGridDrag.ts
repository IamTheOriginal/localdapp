import { useCallback, useEffect, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * Pointer-driven drag for the Home grid and the folder dialog (no library):
 * mouse drags after a small threshold, touch lifts after a long-press (so a
 * plain swipe still scrolls — the cards never set `touch-action: none`), a
 * fixed-position clone follows the pointer, the hovered card maps to a drop
 * intent (outer quarters insert, the middle merges after a dwell), the nearest
 * scroller auto-scrolls near its edges, and Escape / pointercancel / a hidden
 * tab cancel without calling `onDrop`.
 *
 * Markup contract: every grid is `data-grid-container="<containerId>"` (bound
 * with `containerRef`), every card inside spreads `bind(id, kind).props`. Hit
 * testing is by rectangle within the ACTIVE container (`options.containerId`),
 * so a modal dialog's inert background never gets in the way.
 */

export type GridItemKind = 'dapp' | 'folder';

export type DropIntent =
  | { type: 'insert'; targetId: string; side: 'before' | 'after'; axis: 'x' | 'y' }
  | { type: 'merge'; targetId: string; targetKind: GridItemKind };

export interface GridDrop {
  id: string;
  kind: GridItemKind;
  /** Container the drag started in / ended in (`containerId` values). */
  fromContainer: string;
  containerId: string;
  /** `null`: released over no card (the caller decides, e.g. "dragged out of the folder"). */
  intent: DropIntent | null;
}

export interface GridDragOptions {
  /** The grid drops currently land in: the open folder's id, else the home grid. */
  containerId: string;
  /** Only the home grid merges (no folders in folders). */
  allowMerge: boolean;
  editMode: boolean;
  /** A touch long-press lifted a card. */
  onEditMode: () => void;
  onDrop: (drop: GridDrop) => void;
  /** The drag rested on a folder long enough to open it. */
  onOpenFolder: (folderId: string) => void;
  /** The drag rested outside the active container's dialog. */
  onLeaveContainer: () => void;
  /** Every lifted drag ends here, dropped or cancelled. */
  onEnd: () => void;
}

export const GRID_DRAG = {
  mouseSlopPx: 6,
  touchSlopPx: 8,
  holdMs: 400,
  editHoldMs: 150,
  mergeDwellMs: 350,
  openDwellMs: 700,
  leaveDwellMs: 400,
  edgePx: 64,
  maxScrollPx: 18,
  /** Half the grid gap: the pointer in a gap still counts for the nearer card. */
  hitSlackPx: 8,
} as const;

/**
 * Drop zone → intent. `fraction` is the pointer's position along the reading
 * axis of the hovered card (0 = leading edge, 1 = trailing edge). The outer 25 %
 * insert; the middle 50 % merges once the pointer has dwelt there (a folder
 * accepts at once and opens after a longer dwell) and otherwise inserts on the
 * nearer side, so a quick drop still lands somewhere sensible.
 */
export function resolveDropZone(input: {
  fraction: number;
  draggedKind: GridItemKind;
  targetKind: GridItemKind;
  dwellMs: number;
  allowMerge: boolean;
}): 'before' | 'after' | 'merge' | 'open' {
  const { fraction, draggedKind, targetKind, dwellMs, allowMerge } = input;
  if (fraction < 0.25) return 'before';
  if (fraction > 0.75) return 'after';
  if (allowMerge && draggedKind === 'dapp') {
    if (targetKind === 'folder') return dwellMs >= GRID_DRAG.openDwellMs ? 'open' : 'merge';
    if (dwellMs >= GRID_DRAG.mergeDwellMs) return 'merge';
  }
  return fraction < 0.5 ? 'before' : 'after';
}

/** Auto-scroll speed (px per frame) for a pointer at `position` inside `[start, end]`; proportional to depth. */
export function edgeScrollSpeed(position: number, start: number, end: number): number {
  const { edgePx, maxScrollPx } = GRID_DRAG;
  if (position < start + edgePx) return -Math.ceil((Math.min(edgePx, start + edgePx - position) / edgePx) * maxScrollPx);
  if (position > end - edgePx) return Math.ceil((Math.min(edgePx, position - (end - edgePx)) / edgePx) * maxScrollPx);
  return 0;
}

export type DropMark = { type: 'insert'; side: 'before' | 'after'; axis: 'x' | 'y' } | { type: 'merge' };

export interface GridItemBinding {
  props: {
    'data-grid-item': string;
    'data-grid-kind': GridItemKind;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  };
  dragging: boolean;
  drop: DropMark | null;
}

interface Session {
  id: string;
  kind: GridItemKind;
  el: HTMLElement;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  fromContainer: string;
  /** Lifted: the clone is up and moves count as a drag. */
  active: boolean;
  /** Escape / hidden tab: nothing is written, but the pointer is still down. */
  cancelled: boolean;
  clone: HTMLElement | null;
  hoverKey: string;
  hoverSince: number;
  intent: DropIntent | null;
  holdTimer: number;
  dwellTimer: number;
  leaveTimer: number;
  frame: number;
  restoreBody: () => void;
}

/** Controls inside a card keep their own pointer behaviour — except a `data-grid-handle` (the folder's stretched name button). */
const NO_DRAG_SELECTOR = 'button, input, select, textarea, [data-no-drag]';

function findScroller(from: Element | null): Element {
  for (let node = from; node && node !== document.body; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

function sameIntent(a: DropIntent | null, b: DropIntent | null): boolean {
  if (!a || !b) return a === b;
  return a.type === b.type && a.targetId === b.targetId && (a.type !== 'insert' || (b.type === 'insert' && a.side === b.side && a.axis === b.axis));
}

interface DragView { id: string; intent: DropIntent | null }

/** The imperative half: one pointer session at a time; the hook keeps `options` fresh through `setOptions`. */
function createDragController(initialOptions: GridDragOptions, setDrag: (drag: DragView | null) => void) {
  let options = initialOptions;
  const getOptions = () => options;
  let current: Session | null = null;
  let lastPointerType = 'mouse';

  const container = () => document.querySelector<HTMLElement>(`[data-grid-container="${CSS.escape(getOptions().containerId)}"]`);

  /** `final`: the drop itself — read the zone once more, but open nothing and arm no timers. */
  const updateIntent = (final = false) => {
    const session = current;
    if (!session?.active || session.cancelled) return;
    const opts = getOptions();
    const grid = container();
    const now = performance.now();
    const slack = GRID_DRAG.hitSlackPx;

    // Resting outside the open folder's dialog hands the drag back to the home grid.
    const popupRect = grid?.closest<HTMLElement>('[data-slot="dialog-content"]')?.getBoundingClientRect();
    const outside = !!popupRect && (session.x < popupRect.left || session.x > popupRect.right || session.y < popupRect.top || session.y > popupRect.bottom);
    if (!outside || final) {
      clearTimeout(session.leaveTimer);
      session.leaveTimer = 0;
    } else if (!session.leaveTimer) {
      session.leaveTimer = window.setTimeout(() => {
        session.leaveTimer = 0;
        getOptions().onLeaveContainer();
      }, GRID_DRAG.leaveDwellMs);
    }

    let intent: DropIntent | null = null;
    let hoverKey = '';
    for (const el of Array.from(grid?.querySelectorAll<HTMLElement>('[data-grid-item]') ?? [])) {
      const targetId = el.dataset.gridItem ?? '';
      if (targetId === session.id) continue;
      const rect = el.getBoundingClientRect();
      if (session.x < rect.left - slack || session.x > rect.right + slack || session.y < rect.top - slack || session.y > rect.bottom + slack) continue;
      // Several columns read left-to-right, a single column top-to-bottom.
      const axis = rect.width * 2 <= (grid?.getBoundingClientRect().width ?? 0) ? 'x' : 'y';
      const raw = axis === 'x' ? (session.x - rect.left) / (rect.width || 1) : (session.y - rect.top) / (rect.height || 1);
      const fraction = Math.min(1, Math.max(0, raw));
      const targetKind: GridItemKind = el.dataset.gridKind === 'folder' ? 'folder' : 'dapp';
      hoverKey = `${targetId}:${fraction >= 0.25 && fraction <= 0.75 ? 'middle' : 'edge'}`;
      if (hoverKey !== session.hoverKey) {
        session.hoverKey = hoverKey;
        session.hoverSince = now;
        clearTimeout(session.dwellTimer);
        // The pointer may rest without further move events — re-evaluate at both dwell marks.
        if (!final) {
          session.dwellTimer = window.setTimeout(() => {
            updateIntent();
            session.dwellTimer = window.setTimeout(updateIntent, GRID_DRAG.openDwellMs - GRID_DRAG.mergeDwellMs);
          }, GRID_DRAG.mergeDwellMs + 1);
        }
      }
      const zone = resolveDropZone({ fraction, draggedKind: session.kind, targetKind, dwellMs: now - session.hoverSince, allowMerge: opts.allowMerge });
      if (zone === 'open' && !final) {
        session.hoverSince = now;
        opts.onOpenFolder(targetId);
      }
      intent = zone === 'merge' || zone === 'open' ? { type: 'merge', targetId, targetKind } : { type: 'insert', targetId, side: zone, axis };
      break;
    }
    if (!hoverKey) {
      session.hoverKey = '';
      clearTimeout(session.dwellTimer);
    }
    if (!sameIntent(intent, session.intent)) {
      session.intent = intent;
      if (!final) setDrag({ id: session.id, intent });
    }
  };

  const positionClone = (session: Session) => {
    if (session.clone) session.clone.style.transform = `translate(${session.x - session.startX}px, ${session.y - session.startY}px) scale(1.03)`;
  };

  const autoScroll = () => {
    const session = current;
    if (!session?.active || session.cancelled) return;
    const scroller = findScroller(container());
    const isPage = scroller === document.scrollingElement || scroller === document.documentElement;
    const rect = scroller.getBoundingClientRect();
    const top = isPage ? 0 : Math.max(0, rect.top);
    const bottom = isPage ? window.innerHeight : Math.min(window.innerHeight, rect.bottom);
    const speed = edgeScrollSpeed(session.y, top, bottom);
    if (speed !== 0) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      if (scroller.scrollTop !== before) updateIntent();
    }
    session.frame = requestAnimationFrame(autoScroll);
  };

  const lift = (session: Session) => {
    session.active = true;
    try { session.el.setPointerCapture(session.pointerId); } catch { /* pointer already gone */ }
    const rect = session.el.getBoundingClientRect();
    const clone = session.el.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-grid-item');
    [clone, ...Array.from(clone.querySelectorAll('[id]'))].forEach((node) => node.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true');
    Object.assign(clone.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      margin: '0', zIndex: '1000', pointerEvents: 'none', opacity: '0.92', animation: 'none', transition: 'none',
      filter: 'drop-shadow(0 18px 30px rgba(15,16,24,0.22))',
    });
    document.body.appendChild(clone);
    session.clone = clone;
    positionClone(session);

    const { userSelect, overscrollBehavior } = document.body.style;
    document.body.style.userSelect = 'none';
    document.body.style.overscrollBehavior = 'contain';
    session.restoreBody = () => {
      document.body.style.userSelect = userSelect;
      document.body.style.overscrollBehavior = overscrollBehavior;
    };

    if (session.touch) {
      navigator.vibrate?.(10);
      getOptions().onEditMode();
    }
    setDrag({ id: session.id, intent: null });
    session.frame = requestAnimationFrame(autoScroll);
  };

  /** Takes the drag off screen (idempotent); the session lives on until the pointer is released. */
  const putDown = (session: Session) => {
    clearTimeout(session.holdTimer);
    clearTimeout(session.dwellTimer);
    clearTimeout(session.leaveTimer);
    cancelAnimationFrame(session.frame);
    session.clone?.remove();
    session.clone = null;
    session.restoreBody();
    session.restoreBody = () => undefined;
    setDrag(null);
  };

  // The browser still sends a click after a drag (the pointer was captured by the card's link).
  const swallowNextClick = () => {
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
  };

  const end = (commit: boolean) => {
    const session = current;
    if (!session) return;
    const write = commit && session.active && !session.cancelled;
    if (write) updateIntent(true); // the pointer may have rested since the last move
    current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    clearTimeout(session.holdTimer);
    if (!session.active) return; // a plain click or tap
    putDown(session);
    try { session.el.releasePointerCapture(session.pointerId); } catch { /* already released */ }
    if (commit) swallowNextClick(); // a released pointer clicks; a cancelled one does not
    if (write) options.onDrop({ id: session.id, kind: session.kind, fromContainer: session.fromContainer, containerId: options.containerId, intent: session.intent });
    if (!session.cancelled) options.onEnd(); // a cancelled drag already reported its end
  };

  /** Escape / hidden tab: nothing will be written, but the pointer is still down — `end` follows on release. */
  const cancel = () => {
    const session = current;
    if (!session) return;
    if (!session.active) {
      end(false);
      return;
    }
    session.cancelled = true;
    putDown(session);
    options.onEnd();
  };

  function onPointerMove(event: PointerEvent) {
    const session = current;
    if (!session || event.pointerId !== session.pointerId || session.cancelled) return;
    session.x = event.clientX;
    session.y = event.clientY;
    if (!session.active) {
      const distance = Math.hypot(session.x - session.startX, session.y - session.startY);
      if (session.touch) {
        if (distance > GRID_DRAG.touchSlopPx) end(false); // movement before the hold is a scroll
        return;
      }
      if (distance <= GRID_DRAG.mouseSlopPx) return;
      lift(session);
    }
    positionClone(session);
    updateIntent();
  }
  function onPointerUp(event: PointerEvent) {
    if (event.pointerId === current?.pointerId) end(true);
  }
  function onPointerCancel(event: PointerEvent) {
    if (event.pointerId === current?.pointerId) end(false);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !current?.active) return;
    // The drag owns this Escape — an open folder dialog must not close on it.
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') cancel();
  }

  const begin = (event: ReactPointerEvent<HTMLElement>, id: string, kind: GridItemKind) => {
    lastPointerType = event.pointerType;
    if (current || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const control = (event.target as Element).closest(NO_DRAG_SELECTOR);
    if (control && !control.hasAttribute('data-grid-handle')) return;
    const el = event.currentTarget;
    const session: Session = {
      id, kind, el,
      touch: event.pointerType === 'touch',
      pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      fromContainer: el.closest<HTMLElement>('[data-grid-container]')?.dataset.gridContainer ?? getOptions().containerId,
      active: false, cancelled: false, clone: null, hoverKey: '', hoverSince: 0, intent: null,
      holdTimer: 0, dwellTimer: 0, leaveTimer: 0, frame: 0,
      restoreBody: () => undefined,
    };
    current = session;
    if (session.touch) {
      session.holdTimer = window.setTimeout(() => {
        if (current === session) lift(session);
      }, getOptions().editMode ? GRID_DRAG.editHoldMs : GRID_DRAG.holdMs);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
  };

  return {
    begin,
    setOptions: (next: GridDragOptions) => { options = next; },
    /** Unmount: drop everything without a write. */
    abort: () => { cancel(); end(false); },
    isLifted: () => !!current?.active && !current.cancelled,
    wasTouch: () => lastPointerType === 'touch',
  };
}

export function useGridDrag(options: GridDragOptions): {
  bind: (id: string, kind: GridItemKind) => GridItemBinding;
  containerRef: (element: HTMLElement | null) => (() => void) | undefined;
  dragging: boolean;
} {
  const [drag, setDrag] = useState<DragView | null>(null);
  const [controller] = useState(() => createDragController(options, setDrag));
  useEffect(() => { controller.setOptions(options); });
  useEffect(() => controller.abort, [controller]);

  // Must be non-passive and in place BEFORE the touch starts: while a card is
  // lifted the page must not scroll under the finger; otherwise it scrolls freely.
  const containerRef = useCallback((element: HTMLElement | null) => {
    if (!element) return undefined;
    const blockScroll = (event: TouchEvent) => {
      if (controller.isLifted() && event.cancelable) event.preventDefault();
    };
    element.addEventListener('touchmove', blockScroll, { passive: false });
    return () => element.removeEventListener('touchmove', blockScroll);
  }, [controller]);

  const bind = (id: string, kind: GridItemKind): GridItemBinding => {
    const intent = drag?.intent;
    const drop: DropMark | null = intent?.targetId !== id ? null
      : intent.type === 'merge' ? { type: 'merge' } : { type: 'insert', side: intent.side, axis: intent.axis };
    return {
      props: {
        'data-grid-item': id,
        'data-grid-kind': kind,
        onPointerDown: (event) => controller.begin(event, id, kind),
        // A touch long-press would otherwise open the browser's link menu mid-drag.
        onContextMenu: (event) => { if (controller.wasTouch()) event.preventDefault(); },
        // Links are natively draggable; an HTML5 drag would cancel the pointer stream.
        onDragStart: (event) => event.preventDefault(),
      },
      dragging: drag?.id === id,
      drop,
    };
  };

  return { bind, containerRef, dragging: drag !== null };
}
