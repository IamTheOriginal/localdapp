import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { useI18n } from '@/i18n';
import { FOLDER_NAME_MAX } from '@/services/store/index.ts';
import { cn } from '@/lib/utils';
import type { DappFolder, DappListItem } from '@/types';
import { fill } from './text.ts';

/**
 * An open folder: inline rename plus the same draggable grid as Home
 * (`data-grid-container` is the folder id). While a card is dragged out, the
 * dialog only turns invisible (`hidden`) instead of closing — unmounting it
 * would remove the dragged element and end its pointer stream.
 */
export function FolderDialog({ folder, dapps, hidden, renaming, containerRef, renderDapp, onRename, onClose }: {
  folder: DappFolder;
  dapps: DappListItem[];
  hidden: boolean;
  /** Opened through "Rename": focus the name. Otherwise the first app — a focused input would pop up the touch keyboard. */
  renaming: boolean;
  containerRef: (element: HTMLElement | null) => (() => void) | undefined;
  renderDapp: (dapp: DappListItem) => ReactNode;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const nameRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        initialFocus={() => (renaming ? nameRef.current : gridRef.current?.querySelector('a') ?? null)}
        data-folder-hidden={hidden || undefined}
        className={cn('sm:max-w-2xl', hidden && 'pointer-events-none invisible')}
      >
        <DialogHeader>
          <DialogTitle className="sr-only">{fill(t('Folder {name}'), { name: folder.name })}</DialogTitle>
          <DialogDescription className="sr-only">{t('Rename the folder, reorder its apps, or move them out.')}</DialogDescription>
          <Input
            key={folder.name}
            ref={nameRef}
            defaultValue={folder.name}
            maxLength={FOLDER_NAME_MAX}
            aria-label={t('Folder name')}
            className="text-base font-semibold"
            onBlur={(event) => { if (event.target.value.trim() !== folder.name) onRename(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
        </DialogHeader>
        <div ref={gridRef}>
          <div ref={containerRef} data-grid-container={folder.id} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {dapps.map(renderDapp)}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "New folder…" from the Move menu. A folder needs two dapps (one alone
 * dissolves again), so the user names it and picks the second one.
 */
export function NewFolderDialog({ dapp, candidates, onCreate, onClose }: {
  dapp: DappListItem;
  candidates: DappListItem[];
  onCreate: (partnerId: string, name: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [partnerId, setPartnerId] = useState(candidates[0]?.id ?? '');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form
          className="grid min-w-0 gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (partnerId) onCreate(partnerId, name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('New folder')}</DialogTitle>
            <DialogDescription>{fill(t('A folder holds at least two apps. Choose the app that joins {name}.'), { name: dapp.name })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-folder-name">{t('Folder name')}</Label>
            <Input id="new-folder-name" value={name} maxLength={FOLDER_NAME_MAX} placeholder={t('Folder')} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-folder-partner">{t('Second app')}</Label>
            <NativeSelect id="new-folder-partner" wrapperClassName="w-full" value={partnerId} onChange={(event) => setPartnerId(event.target.value)}>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.icon} {candidate.name}</option>)}
            </NativeSelect>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <Button type="submit" disabled={!partnerId}>{t('Create folder')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
