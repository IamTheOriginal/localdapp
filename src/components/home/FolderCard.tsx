import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { useI18n } from '@/i18n';
import type { GridItemBinding } from '@/hooks/useGridDrag';
import type { DappFolder, DappListItem } from '@/types';
import { GridItem } from './GridItem.tsx';
import { fill } from './text.ts';

/** A folder on the Home grid: 2×2 mini icons, name and count; the name is a button stretched over the card. */
export function FolderCard({ folder, dapps, onOpen, actions, editMode = false, binding }: {
  folder: DappFolder;
  dapps: DappListItem[];
  onOpen: () => void;
  actions?: ReactNode;
  editMode?: boolean;
  binding?: GridItemBinding;
}) {
  const { t } = useI18n();
  return (
    <GridItem binding={binding} editMode={editMode}>
      <Card
        id={`dapp-folder-${folder.id}`}
        className="group relative bg-card py-0 transition-[border-color,background-color] duration-150 hover:border-foreground/20 hover:bg-card/90"
      >
        <CardContent className="flex flex-row items-center gap-3.5 px-4 py-3.5">
          <div className="grid h-11 w-11 shrink-0 grid-cols-2 grid-rows-2 place-items-center gap-1 rounded-lg border border-border/80 bg-muted/60 p-1 text-[0.65rem] leading-none" aria-hidden="true">
            {dapps.slice(0, 4).map((dapp) => (
              <span
                key={dapp.id}
                className="flex h-full w-full items-center justify-center rounded-[4px]"
                style={dapp.color ? { backgroundColor: `${dapp.color}20` } : undefined}
              >
                {dapp.icon}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col text-left">
            <h3 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
              <button
                type="button"
                data-grid-handle=""
                onClick={onOpen}
                aria-haspopup="dialog"
                className="max-w-full cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring/35 focus-visible:after:ring-inset"
              >
                {folder.name}
              </button>
            </h3>
            <span className="truncate text-xs text-muted-foreground">{fill(t('Folder · {count} apps'), { count: dapps.length })}</span>
          </div>
          {actions && <div className="relative z-10 flex shrink-0 items-center gap-0.5">{actions}</div>}
        </CardContent>
      </Card>
    </GridItem>
  );
}
