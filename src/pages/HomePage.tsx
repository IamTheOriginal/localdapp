import { showAlert } from '@/services/dialogs.ts';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Link2, LogOut, Plus, RotateCcw, Search, Trash2, Upload, X } from 'lucide-react';
import { useHomeLayout } from '../hooks/useYjs.ts';
import { useGridDrag, type GridDrop } from '../hooks/useGridDrag.ts';
import {
  createFolderFromDapps,
  homeNodeId,
  importDefinitionBundle,
  moveDapp,
  moveFolder,
  readHomeLayout,
  renameFolder,
  stepTarget,
  ungroupFolder,
} from '../services/store/index.ts';
import { DAPP_FILE_ACCEPT, readDappFile } from '../services/dappFile.ts';
import type { CodeAppDefinitionBundle, DappListItem, HomeNode } from '../types.ts';
import { confirmAndDeleteDapp } from '../services/dappDeletionFlow.ts';
import { confirmAndLeaveDapp } from '../services/dappLeaveFlow.ts';
import { useI18n } from '../i18n/index.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { DappContent } from '../components/DappContent.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import DefinitionInstallDialog from '../components/code-app/DefinitionInstallDialog.tsx';
import { DappCard } from '../components/home/DappCard.tsx';
import { FolderCard } from '../components/home/FolderCard.tsx';
import { FolderDialog, NewFolderDialog } from '../components/home/FolderDialog.tsx';
import { HomeGridStyles } from '../components/home/GridItem.tsx';
import { MoveMenu, type MoveStep } from '../components/home/MoveMenu.tsx';
import { fill } from '../components/home/text.ts';

/** `data-grid-container` id of the top-level grid; an open folder's grid uses the folder id. */
const HOME_GRID = 'home';

type FolderNode = Extract<HomeNode, { kind: 'folder' }>;

export default function HomePage() {
  const { nodes, leftDapps } = useHomeLayout();
  const { t } = useI18n();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deletingDappId, setDeletingDappId] = useState<string | null>(null);
  const [leavingDappId, setLeavingDappId] = useState<string | null>(null);
  const [definitionPreview, setDefinitionPreview] = useState<CodeAppDefinitionBundle | null>(null);
  const [installingDefinition, setInstallingDefinition] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Home-screen organising: all ephemeral UI state — the layout itself lives in the root doc.
  const [editMode, setEditMode] = useState(false);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [draggedOut, setDraggedOut] = useState(false);
  const [newFolderFor, setNewFolderFor] = useState<DappListItem | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [query, setQuery] = useState('');

  // OS-level app shortcuts (manifest `shortcuts`) land on /?action=…. App
  // attaches the dialog listeners in a parent effect, which runs after this
  // child effect on first mount — defer the dispatch past it; no cleanup, or
  // the param-strip rerun would cancel the pending timer.
  useEffect(() => {
    const action = searchParams.get('action');
    if (action !== 'new-dapp' && action !== 'join-invite') return;
    const event = action === 'new-dapp' ? 'open-new-dapp' : 'open-scan-invite';
    setTimeout(() => window.dispatchEvent(new Event(event)), 0);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!editMode) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setEditMode(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editMode]);

  const handleCreateNew = () => {
    // Dispatch event so App can open the global Create Dapp modal
    window.dispatchEvent(new Event('open-new-dapp'));
  };

  const handleScanInviteModal = () => {
    // Dispatch event so App can open the global Scan Invite modal
    window.dispatchEvent(new Event('open-scan-invite'));
  };

  const handleLeave = async (id: string) => {
    setLeavingDappId(id);
    try {
      await confirmAndLeaveDapp(id, t);
    } finally {
      setLeavingDappId(null);
    }
  };

  // Only left (read-only) copies keep a delete button on the card; an active dapp
  // is deleted from its sidebar card inside the app, next to the sync status.
  const handleDelete = async (id: string) => {
    setDeletingDappId(id);
    try {
      await confirmAndDeleteDapp(id, t);
    } finally {
      setDeletingDappId(null);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      setDefinitionPreview(await readDappFile(file));
    } catch (error) {
      void showAlert(`${t('Invalid dapp file')}: ${error instanceof Error ? error.message : String(error)}`, { title: t('Import failed') });
    }
  };

  const handleInstallDefinition = async () => {
    if (!definitionPreview || installingDefinition) return;
    setInstallingDefinition(true);
    try {
      const id = await importDefinitionBundle(definitionPreview);
      setDefinitionPreview(null);
      void navigate(`/dapp/${id}`);
    } catch (error) {
      void showAlert(`Definition installation failed: ${error instanceof Error ? error.message : String(error)}`, { title: 'Install failed' });
    } finally {
      setInstallingDefinition(false);
    }
  };

  // ── Layout: manual order and folders (store/homeLayout.ts) ──

  const folderNodes = nodes.filter((node): node is FolderNode => node.kind === 'folder');
  const topLevelDapps = nodes.flatMap((node) => (node.kind === 'dapp' ? [node.dapp] : []));
  const openFolder = folderNodes.find((node) => node.folder.id === openFolderId) ?? null;
  // While a card is dragged out of the open folder, drops land on the home grid again.
  const activeGrid = openFolder && !draggedOut ? openFolder.folder.id : HOME_GRID;

  const siblingIds = (folderId: string | null): string[] =>
    folderId === null ? nodes.map(homeNodeId) : folderNodes.find((node) => node.folder.id === folderId)?.dapps.map((dapp) => dapp.id) ?? [];

  /** Says where `id` ended up — read back from the store, so it is right whatever the move was. */
  const announceMove = (id: string, name: string) => {
    const layout = readHomeLayout();
    const folder = layout.find((node): node is FolderNode => node.kind === 'folder' && node.dapps.some((dapp) => dapp.id === id));
    const ids = folder ? folder.dapps.map((dapp) => dapp.id) : layout.map(homeNodeId);
    const values = { name, position: ids.indexOf(id) + 1, total: ids.length, folder: folder?.folder.name ?? '' };
    setAnnouncement(fill(folder ? t('{name} moved to position {position} of {total} in folder {folder}.') : t('{name} moved to position {position} of {total}.'), values));
  };

  const placeDapp = (dapp: { id: string; name: string }, folderId: string | null, beforeId: string | null) => {
    if (moveDapp(dapp.id, { folderId, beforeId })) announceMove(dapp.id, dapp.name);
  };

  const placeFolder = (folder: { id: string; name: string }, beforeId: string | null) => {
    if (moveFolder(folder.id, beforeId)) announceMove(folder.id, folder.name);
  };

  const makeFolder = (targetId: string, dragged: { id: string; name: string }, name: string) => {
    const folderId = createFolderFromDapps(targetId, dragged.id, name.trim() || t('Folder'));
    if (folderId) announceMove(dragged.id, dragged.name);
  };

  /** Renaming happens inline in the folder dialog; `rename` only decides what gets the focus. */
  const openFolderDialog = (folderId: string, rename: boolean) => {
    setRenamingFolder(rename);
    setOpenFolderId(folderId);
  };

  const handleDrop = (drop: GridDrop) => {
    const folderId = drop.containerId === HOME_GRID ? null : drop.containerId;
    const name = drop.kind === 'folder'
      ? folderNodes.find((node) => node.folder.id === drop.id)?.folder.name ?? ''
      : [...topLevelDapps, ...folderNodes.flatMap((node) => node.dapps)].find((dapp) => dapp.id === drop.id)?.name ?? '';
    const dragged = { id: drop.id, name };
    const { intent } = drop;
    if (!intent) {
      // Released over no card: only meaningful when the card changed grids (dragged out of / into a folder).
      if (drop.kind === 'dapp' && drop.containerId !== drop.fromContainer) placeDapp(dragged, folderId, null);
      return;
    }
    if (intent.type === 'merge') {
      if (drop.kind !== 'dapp') return;
      if (intent.targetKind === 'folder') placeDapp(dragged, intent.targetId, null);
      else makeFolder(intent.targetId, dragged, '');
      return;
    }
    const others = siblingIds(folderId).filter((id) => id !== drop.id);
    const at = others.indexOf(intent.targetId);
    if (at < 0) return; // the target vanished mid-drag
    const beforeId = intent.side === 'before' ? intent.targetId : others[at + 1] ?? null;
    if (drop.kind === 'folder') placeFolder(dragged, beforeId);
    else placeDapp(dragged, folderId, beforeId);
  };

  const { bind, containerRef } = useGridDrag({
    containerId: activeGrid,
    allowMerge: activeGrid === HOME_GRID,
    editMode,
    onEditMode: () => setEditMode(true),
    onDrop: handleDrop,
    onOpenFolder: (folderId) => { if (!draggedOut) openFolderDialog(folderId, false); },
    onLeaveContainer: () => setDraggedOut(true),
    onEnd: () => {
      if (draggedOut) setOpenFolderId(null);
      setDraggedOut(false);
    },
  });

  const step = (id: string, folderId: string | null, direction: MoveStep): string | null | undefined =>
    stepTarget(siblingIds(folderId), id, direction);

  const roleLabel = (role?: DappListItem['role']) => {
    if (role === 'owner') return t('Owner');
    if (role === 'editor') return t('Editor');
    if (role === 'viewer') return t('Viewer');
    return null;
  };

  const renderDapp = (dapp: DappListItem, folderId: string | null) => {
    const ids = siblingIds(folderId);
    const at = ids.indexOf(dapp.id);
    const partners = topLevelDapps.filter((other) => other.id !== dapp.id);
    const dateLabel = dapp.createdAt ? new Date(dapp.createdAt).toLocaleDateString() : 'Code App';
    const roleText = roleLabel(dapp.role);
    const subtitle = roleText ? `${roleText} · ${dateLabel}` : dateLabel;
    return (
      <DappCard
        key={dapp.id}
        dapp={dapp}
        editMode={editMode}
        binding={bind(dapp.id, 'dapp')}
        subtitle={subtitle}
        actions={(
          <>
            {(dapp.joinMethod === 'lobby' || dapp.joinMethod === 'direct') && (
              <Tooltip>
                <TooltipTrigger render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void handleLeave(dapp.id)}
                    disabled={leavingDappId !== null}
                    aria-label={leavingDappId === dapp.id ? t('Leaving app') : t('Leave')}
                  />
                }>
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>{t('Leave')}</TooltipContent>
              </Tooltip>
            )}
            <MoveMenu
              name={dapp.name}
              canMoveUp={at > 0}
              canMoveDown={at < ids.length - 1}
              onStep={(direction) => {
                const beforeId = step(dapp.id, folderId, direction);
                if (beforeId !== undefined) placeDapp(dapp, folderId, beforeId);
              }}
              folders={folderNodes.filter((node) => node.folder.id !== folderId).map((node) => node.folder)}
              onMoveToFolder={(targetFolderId) => placeDapp(dapp, targetFolderId, null)}
              onNewFolder={partners.length > 0 ? () => setNewFolderFor(dapp) : undefined}
              onRemoveFromFolder={folderId !== null ? () => {
                if (moveDapp(dapp.id, { beforeId: null })) setAnnouncement(fill(t('{name} removed from folder.'), { name: dapp.name }));
              } : undefined}
            />
          </>
        )}
      />
    );
  };

  const renderFolder = ({ folder, dapps }: FolderNode) => {
    const ids = siblingIds(null);
    const at = ids.indexOf(folder.id);
    return (
      <FolderCard
        key={folder.id}
        folder={folder}
        dapps={dapps}
        editMode={editMode}
        binding={bind(folder.id, 'folder')}
        onOpen={() => openFolderDialog(folder.id, false)}
        actions={(
          <MoveMenu
            name={folder.name}
            canMoveUp={at > 0}
            canMoveDown={at < ids.length - 1}
            onStep={(direction) => {
              const beforeId = step(folder.id, null, direction);
              if (beforeId !== undefined) placeFolder(folder, beforeId);
            }}
            onRename={() => openFolderDialog(folder.id, true)}
            onUngroup={() => {
              if (ungroupFolder(folder.id)) setAnnouncement(fill(t('Folder {name} ungrouped.'), { name: folder.name }));
            }}
          />
        )}
      />
    );
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleNodes = normalizedQuery
    ? nodes.filter((node) => (node.kind === 'dapp'
      ? node.dapp.name.toLowerCase().includes(normalizedQuery)
      : node.folder.name.toLowerCase().includes(normalizedQuery) || node.dapps.some((dapp) => dapp.name.toLowerCase().includes(normalizedQuery))))
    : nodes;

  return (
    <DappContent>
      <HomeGridStyles />
      <input type="file" accept={DAPP_FILE_ACCEPT} className="hidden" ref={fileInputRef} onChange={(event) => { void handleImport(event); }} />
      <PageHeader
        title={t('Your apps')}
        actions={(
          <>
            {editMode && <Button variant="outline" onClick={() => setEditMode(false)}>{t('Done')}</Button>}
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              {t('Import')}
            </Button>
            <Button variant="outline" onClick={handleScanInviteModal}>
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {t('Join with link')}
            </Button>
            <Button variant="default" onClick={handleCreateNew} id="create-dapp-btn">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('New app')}
            </Button>
          </>
        )}
      />
      <div aria-live="polite" role="status" className="sr-only">{announcement}</div>

      {nodes.length >= 4 && (
        <div className="relative mb-5 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search apps…')}
            aria-label={t('Search apps…')}
            className="pl-9 pr-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('Clear search')}
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {nodes.length === 0 && leftDapps.length === 0 ? (
        <EmptyState
          className="mx-auto mt-4 max-w-2xl py-14"
          icon="⬡"
          title={t('No apps yet')}
          description={t('Create an app, or join one with an invite link, to get started.')}
          action={(
            <>
              <Button variant="default" onClick={handleCreateNew}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('Create Blank App')}
              </Button>
              <Button variant="outline" onClick={handleScanInviteModal}>
                <Link2 className="h-4 w-4" aria-hidden="true" />
                {t('Join with link')}
              </Button>
            </>
          )}
        />
      ) : visibleNodes.length === 0 && normalizedQuery ? (
        <EmptyState
          className="mx-auto mt-4 max-w-xl py-10"
          icon={<Search className="h-5 w-5" />}
          title={t('No matching apps')}
          action={<Button variant="outline" size="sm" onClick={() => setQuery('')}>{t('Clear search')}</Button>}
        />
      ) : (
        <div ref={containerRef} data-grid-container={HOME_GRID} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleNodes.map((node) => (node.kind === 'dapp' ? renderDapp(node.dapp, null) : renderFolder(node)))}
        </div>
      )}

      {leftDapps.length > 0 && (
        <div className="mt-10">
          <div className="mb-3.5 flex flex-col gap-0.5">
            <h2 className="text-base font-semibold tracking-[-0.015em] text-foreground">{t('Left apps')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('Read-only local copies of apps you left. Rejoin with a fresh invite, or delete the copy.')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {leftDapps.map(dapp => (
              <DappCard
                key={dapp.id}
                dapp={dapp}
                muted
                subtitle={`${t('Left · local copy')}${dapp.archivedAt ? ` · ${new Date(dapp.archivedAt).toLocaleDateString()}` : ''}`}
                actions={(
                  <>
                    <Tooltip>
                      <TooltipTrigger render={
                        <Button size="icon-sm" variant="ghost" onClick={handleScanInviteModal} aria-label={t('Rejoin with a new invite')} />
                      }>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent>{t('Rejoin with a new invite')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger render={
                        <Button
                          size="icon-sm"
                          variant="destructive"
                          onClick={() => void handleDelete(dapp.id)}
                          disabled={deletingDappId !== null}
                          aria-label={deletingDappId === dapp.id ? t('Deleting…') : t('Delete')}
                        />
                      }>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent>{t('Delete')}</TooltipContent>
                    </Tooltip>
                  </>
                )}
              />
            ))}
          </div>
        </div>
      )}

      {openFolder && (
        <FolderDialog
          folder={openFolder.folder}
          dapps={openFolder.dapps}
          hidden={draggedOut}
          renaming={renamingFolder}
          containerRef={containerRef}
          renderDapp={(dapp) => renderDapp(dapp, openFolder.folder.id)}
          onRename={(name) => renameFolder(openFolder.folder.id, name)}
          onClose={() => setOpenFolderId(null)}
        />
      )}
      {newFolderFor && (
        <NewFolderDialog
          dapp={newFolderFor}
          candidates={topLevelDapps.filter((dapp) => dapp.id !== newFolderFor.id)}
          onClose={() => setNewFolderFor(null)}
          onCreate={(partnerId, name) => {
            makeFolder(partnerId, newFolderFor, name);
            setNewFolderFor(null);
          }}
        />
      )}

      <DefinitionInstallDialog
        bundle={definitionPreview}
        installing={installingDefinition}
        onCancel={() => setDefinitionPreview(null)}
        onInstall={() => { void handleInstallDefinition(); }}
      />
    </DappContent>
  );
}
