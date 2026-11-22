// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID_DRAG, edgeScrollSpeed, resolveDropZone, useGridDrag, type GridDrop } from '../hooks/useGridDrag.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('resolveDropZone (drop zone → intent)', () => {
  const dappOnDapp = { draggedKind: 'dapp', targetKind: 'dapp', allowMerge: true } as const;

  it('inserts in the outer quarters whatever the dwell', () => {
    expect(resolveDropZone({ ...dappOnDapp, fraction: 0.1, dwellMs: 5000 })).toBe('before');
    expect(resolveDropZone({ ...dappOnDapp, fraction: 0.9, dwellMs: 5000 })).toBe('after');
  });

  it('merges in the middle half only after the dwell; a quick drop inserts on the nearer side', () => {
    expect(resolveDropZone({ ...dappOnDapp, fraction: 0.4, dwellMs: 0 })).toBe('before');
    expect(resolveDropZone({ ...dappOnDapp, fraction: 0.6, dwellMs: GRID_DRAG.mergeDwellMs - 1 })).toBe('after');
    expect(resolveDropZone({ ...dappOnDapp, fraction: 0.25, dwellMs: GRID_DRAG.mergeDwellMs })).toBe('merge');
    expect(resolveDropZone({ ...dappOnDapp, fraction: 0.75, dwellMs: GRID_DRAG.mergeDwellMs })).toBe('merge');
  });

  it('adds to a folder at once and opens it after the long dwell', () => {
    const onFolder = { draggedKind: 'dapp', targetKind: 'folder', allowMerge: true } as const;
    expect(resolveDropZone({ ...onFolder, fraction: 0.5, dwellMs: 0 })).toBe('merge');
    expect(resolveDropZone({ ...onFolder, fraction: 0.5, dwellMs: GRID_DRAG.openDwellMs })).toBe('open');
    expect(resolveDropZone({ ...onFolder, fraction: 0.1, dwellMs: GRID_DRAG.openDwellMs })).toBe('before');
  });

  it('never merges a folder into anything, nor anything inside a folder (no folders in folders)', () => {
    expect(resolveDropZone({ draggedKind: 'folder', targetKind: 'dapp', allowMerge: true, fraction: 0.5, dwellMs: 5000 })).toBe('after');
    expect(resolveDropZone({ draggedKind: 'folder', targetKind: 'folder', allowMerge: true, fraction: 0.4, dwellMs: 5000 })).toBe('before');
    expect(resolveDropZone({ draggedKind: 'dapp', targetKind: 'dapp', allowMerge: false, fraction: 0.5, dwellMs: 5000 })).toBe('after');
  });
});

describe('edgeScrollSpeed', () => {
  it('is zero away from the edges and grows with depth', () => {
    expect(edgeScrollSpeed(400, 0, 800)).toBe(0);
    expect(edgeScrollSpeed(60, 0, 800)).toBeLessThan(0);
    expect(edgeScrollSpeed(10, 0, 800)).toBeLessThan(edgeScrollSpeed(60, 0, 800));
    expect(edgeScrollSpeed(0, 0, 800)).toBe(-GRID_DRAG.maxScrollPx);
    expect(edgeScrollSpeed(800, 0, 800)).toBe(GRID_DRAG.maxScrollPx);
  });
});

describe('useGridDrag', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onDrop = vi.fn<(drop: GridDrop) => void>();
  const onEnd = vi.fn();
  const onEditMode = vi.fn();
  const onClick = vi.fn();

  function Grid() {
    const { bind, containerRef } = useGridDrag({
      containerId: 'home', allowMerge: true, editMode: false,
      onEditMode, onDrop, onEnd, onOpenFolder: vi.fn(), onLeaveContainer: vi.fn(),
    });
    return (
      <div ref={containerRef} data-grid-container="home">
        {['a', 'b'].map((id) => {
          const binding = bind(id, 'dapp');
          return (
            <div key={id} id={`item-${id}`} {...binding.props} data-dragging={binding.dragging} data-drop={binding.drop?.type ?? ''}>
              <a href={`#${id}`} onClick={(event) => { event.preventDefault(); onClick(id); }}>{id}</a>
            </div>
          );
        })}
      </div>
    );
  }

  function el<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing ${selector}`);
    return found;
  }

  // happy-dom does no layout: a single column of 300×100 cards, 16 px apart.
  function layOut() {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    el('[data-grid-container]').getBoundingClientRect = () => rect(0, 0, 300, 216);
    el('#item-a').getBoundingClientRect = () => rect(0, 0, 300, 100);
    el('#item-b').getBoundingClientRect = () => rect(0, 116, 300, 100);
  }

  const pointer = (type: string, x: number, y: number, pointerType = 'mouse') =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, pointerType });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Grid />));
    layOut();
    [onDrop, onEnd, onEditMode, onClick].forEach((mock) => mock.mockReset());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.advanceTimersByTime(100); // lets a pending click-swallow window run out
    vi.useRealTimers();
  });

  const itemA = () => el('#item-a');
  const clones = () => document.body.querySelectorAll('[aria-hidden="true"]').length;

  it('starts a mouse drag after the threshold and reports an insert on drop', () => {
    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 12, 13)); });
    expect(clones()).toBe(0); // under 6 px: still a click
    act(() => { window.dispatchEvent(pointer('pointermove', 20, 206)); }); // bottom quarter of b
    expect(clones()).toBe(1);
    expect(itemA().dataset.dragging).toBe('true');
    expect(el('#item-b').dataset.drop).toBe('insert');
    act(() => { window.dispatchEvent(pointer('pointerup', 20, 206)); });
    expect(clones()).toBe(0);
    expect(onDrop).toHaveBeenCalledWith({
      id: 'a', kind: 'dapp', fromContainer: 'home', containerId: 'home',
      intent: { type: 'insert', targetId: 'b', side: 'after', axis: 'y' },
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('turns a rest in the middle of a card into a merge', () => {
    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 20, 166)); }); // middle of b
    expect(el('#item-b').dataset.drop).toBe('insert');
    act(() => { vi.advanceTimersByTime(GRID_DRAG.mergeDwellMs + 5); });
    expect(el('#item-b').dataset.drop).toBe('merge');
    act(() => { window.dispatchEvent(pointer('pointerup', 20, 166)); });
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ intent: { type: 'merge', targetId: 'b', targetKind: 'dapp' } }));
  });

  it('writes nothing after Escape, and nothing after pointercancel', () => {
    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 20, 206)); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(clones()).toBe(0);
    expect(itemA().dataset.dragging).toBe('false');
    act(() => { window.dispatchEvent(pointer('pointerup', 20, 206)); });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);

    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 20, 206)); });
    act(() => { window.dispatchEvent(pointer('pointercancel', 20, 206)); });
    expect(clones()).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('swallows the click that follows a drag, but not a plain click', () => {
    const link = el<HTMLAnchorElement>('#item-a a');
    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointerup', 10, 10)); });
    act(() => { link.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 20, 206)); });
    act(() => { window.dispatchEvent(pointer('pointerup', 20, 206)); });
    act(() => { link.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(60); });
    act(() => { link.click(); });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('lifts a touch only after the long-press; movement before it is a scroll', () => {
    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10, 'touch')); });
    act(() => { window.dispatchEvent(pointer('pointermove', 10, 40, 'touch')); });
    act(() => { vi.advanceTimersByTime(GRID_DRAG.holdMs + 5); });
    expect(clones()).toBe(0);
    expect(onEditMode).not.toHaveBeenCalled();

    act(() => { itemA().dispatchEvent(pointer('pointerdown', 10, 10, 'touch')); });
    act(() => { vi.advanceTimersByTime(GRID_DRAG.holdMs + 5); });
    expect(clones()).toBe(1);
    expect(onEditMode).toHaveBeenCalledTimes(1);

    // While lifted, the grid's non-passive touchmove listener stops the page from scrolling.
    const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
    itemA().dispatchEvent(touchMove);
    expect(touchMove.defaultPrevented).toBe(true);
    act(() => { window.dispatchEvent(pointer('pointerup', 10, 10, 'touch')); });
    const idleMove = new Event('touchmove', { bubbles: true, cancelable: true });
    itemA().dispatchEvent(idleMove);
    expect(idleMove.defaultPrevented).toBe(false);
  });

  it('ignores a press on a button inside the card', () => {
    const button = document.createElement('button');
    itemA().appendChild(button);
    act(() => { button.dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 20, 206)); });
    expect(clones()).toBe(0);
  });
});
