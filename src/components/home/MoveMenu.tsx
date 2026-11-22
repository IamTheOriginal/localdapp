import { MoreHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/i18n';
import { fill } from './text.ts';

export type MoveStep = 'up' | 'down' | 'top';

/**
 * The keyboard / screen-reader path to everything drag and drop does: the "⋯"
 * menu of a dapp card (move, move to folder, remove from folder) or of a folder
 * card (rename, move, ungroup). Handlers that are left out hide their items.
 */
export function MoveMenu({ name, canMoveUp, canMoveDown, onStep, folders, onMoveToFolder, onNewFolder, onRemoveFromFolder, onRename, onUngroup }: {
  /** The dapp's or folder's name, for the trigger's accessible name. */
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStep: (step: MoveStep) => void;
  /** Folders this dapp can move to (its own folder left out). */
  folders?: Array<{ id: string; name: string }>;
  onMoveToFolder?: (folderId: string) => void;
  /** Absent when no second top-level dapp exists to start a folder with. */
  onNewFolder?: () => void;
  onRemoveFromFolder?: () => void;
  onRename?: () => void;
  onUngroup?: () => void;
}) {
  const { t } = useI18n();
  const showFolderMenu = !!onMoveToFolder && ((folders?.length ?? 0) > 0 || !!onNewFolder);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={fill(t('Move {name}'), { name })} />}>
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {onRename && <DropdownMenuItem onClick={onRename}>{t('Rename')}</DropdownMenuItem>}
        <DropdownMenuItem disabled={!canMoveUp} onClick={() => onStep('up')}>{t('Move up')}</DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onClick={() => onStep('down')}>{t('Move down')}</DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveUp} onClick={() => onStep('top')}>{t('Move to top')}</DropdownMenuItem>
        {showFolderMenu && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('Move to folder')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {folders?.map((folder) => (
                <DropdownMenuItem key={folder.id} onClick={() => onMoveToFolder(folder.id)}>{folder.name}</DropdownMenuItem>
              ))}
              {onNewFolder && <DropdownMenuItem onClick={onNewFolder}>{t('New folder…')}</DropdownMenuItem>}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onRemoveFromFolder && <DropdownMenuItem onClick={onRemoveFromFolder}>{t('Remove from folder')}</DropdownMenuItem>}
        {onUngroup && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onUngroup}>{t('Ungroup')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
