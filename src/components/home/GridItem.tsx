import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { GridItemBinding } from '@/hooks/useGridDrag';

/**
 * One cell of a draggable grid: carries the drag wiring, dims while its clone
 * is in the air, wiggles in edit mode and shows where a drop would land (a bar
 * in the gap for "insert", a ring for "merge into a folder").
 *
 * `touch-action` stays `manipulation` so a swipe over a full-width card still
 * scrolls the page; the long-press in `useGridDrag` is what lifts a card.
 */
export function GridItem({ binding, editMode = false, children }: {
  binding?: GridItemBinding;
  editMode?: boolean;
  children: ReactNode;
}) {
  const drop = binding?.drop ?? null;
  return (
    <div
      {...binding?.props}
      className={cn(
        'relative touch-manipulation rounded-2xl select-none [-webkit-touch-callout:none]',
        binding?.dragging && 'opacity-40',
        editMode && !binding?.dragging && 'motion-safe:animate-[home-wiggle_0.28s_ease-in-out_infinite_alternate]',
        drop?.type === 'merge' && 'ring-2 ring-primary ring-offset-2 ring-offset-background motion-safe:scale-[1.02] motion-safe:transition-transform',
      )}
    >
      {drop?.type === 'insert' && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute z-20 rounded-full bg-primary',
            drop.axis === 'x' ? 'inset-y-1 w-1' : 'inset-x-1 h-1',
            drop.axis === 'x' && (drop.side === 'before' ? '-left-2.5' : '-right-2.5'),
            drop.axis === 'y' && (drop.side === 'before' ? '-top-2.5' : '-bottom-2.5'),
          )}
        />
      )}
      {children}
    </div>
  );
}

const HOME_GRID_CSS = `
@keyframes home-wiggle { from { transform: rotate(-0.6deg); } to { transform: rotate(0.6deg); } }
[data-slot="dialog-overlay"]:has(~ [data-folder-hidden]) { visibility: hidden; }
`;

/**
 * Rendered once by the Home page: the edit-mode wiggle keyframes (`motion-safe:`
 * keeps the animation off under reduced motion) and the rule that hides the
 * folder dialog's backdrop together with the dialog while a card is dragged out.
 */
export function HomeGridStyles() {
  return <style>{HOME_GRID_CSS}</style>;
}
