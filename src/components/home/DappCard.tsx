import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { GridItemBinding } from '@/hooks/useGridDrag';
import type { DappListItem } from '@/types';
import { GridItem } from './GridItem.tsx';

/**
 * A dapp on the Home grid. The name is a real `<Link>` stretched over the whole
 * card, so the card is keyboard-focusable and opens like any link; the action
 * buttons sit above the stretched link.
 */
export function DappCard({ dapp, subtitle, actions, muted = false, editMode = false, binding }: {
  dapp: DappListItem;
  subtitle: ReactNode;
  actions?: ReactNode;
  /** Left (archived) copy: greyed out. */
  muted?: boolean;
  /** Home-screen edit mode: a tap no longer opens the dapp. */
  editMode?: boolean;
  binding?: GridItemBinding;
}) {
  return (
    <GridItem binding={binding} editMode={editMode}>
      <Card
        id={`dapp-card-${dapp.id}`}
        className={cn(
          'group relative bg-card py-0',
          muted ? 'opacity-75' : 'transition-[border-color,background-color,transform] duration-150 hover:border-foreground/20 hover:bg-card/90',
        )}
      >
        <CardContent className="flex flex-row items-center gap-3.5 px-4 py-3.5">
          <div
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border text-xl',
              muted ? 'border-border bg-muted grayscale' : 'border-border/60',
            )}
            style={!muted && dapp.color ? { backgroundColor: `${dapp.color}18`, borderColor: `${dapp.color}30` } : undefined}
          >
            {dapp.icon}
          </div>
          <div className="flex min-w-0 flex-1 flex-col text-left">
            <h3 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
              <Link
                to={`/dapp/${dapp.id}`}
                draggable={false}
                onClick={(event) => { if (editMode) event.preventDefault(); }}
                className="text-foreground outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring/35 focus-visible:after:ring-inset"
              >
                {dapp.name}
              </Link>
            </h3>
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          </div>
          {actions && <div className="relative z-10 flex shrink-0 items-center gap-0.5">{actions}</div>}
        </CardContent>
      </Card>
    </GridItem>
  );
}
