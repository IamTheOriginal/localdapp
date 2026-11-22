import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Code2,
  FileCode2,
  FileJson,
  FilePlus2,
  FileText,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { useCodeAppFiles, useDappConfig, useMyRole } from '@/hooks/useYjs';
import {
  createCodeAppFile,
  DEFAULT_CODE_APP_HTML,
  DEFAULT_CODE_APP_MANIFEST_YAML,
  deleteCodeAppFile,
  renameCodeAppFile,
  setCodeAppFile,
  syncManifestEntities,
  syncManifestMeta,
} from '@/services/store';
import { parseCodeAppManifest } from '@/services/codeAppManifest';
import { grantedHostPermissionLabels } from './hostPermissionLabels.ts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { showConfirm } from '@/services/dialogs.ts';
import { clearCodeDraft, readCodeDraft, storeCodeDraft } from '@/services/codeDrafts.ts';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

function FileIcon({ path }: { path: string }) {
  if (path.endsWith('.json')) return <FileJson aria-hidden="true" />;
  if (/\.(?:html?|css|js|jsx|ts|tsx)$/i.test(path)) return <FileCode2 aria-hidden="true" />;
  return <FileText aria-hidden="true" />;
}

interface CodeAppEditorProps {
  dappId: string;
  /** Preselects this file on first load (e.g. from $ui.openCodeEditor({ file })), if it exists. */
  initialFile?: string;
}

export default function CodeAppEditor({ dappId: id, initialFile }: CodeAppEditorProps) {
  const navigate = useNavigate();
  const config = useDappConfig(id);
  const role = useMyRole(id);
  const { files, localReady } = useCodeAppFiles(id);
  const paths = useMemo(() => Object.keys(files).sort((a, b) => a.localeCompare(b)), [files]);
  const [selectedPath, setSelectedPath] = useState('');
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  /** The file's content when the current draft was started — to notice a save from another device. */
  const [base, setBase] = useState('');
  const [status, setStatus] = useState<{ text: string; failed?: boolean }>({ text: '' });
  const [createOpen, setCreateOpen] = useState(false);
  const [createPath, setCreatePath] = useState('');
  const [createError, setCreateError] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePath, setRenamePath] = useState('');
  const [renameError, setRenameError] = useState('');
  const initialFileAppliedRef = useRef(false);

  useEffect(() => {
    if (!localReady) return;
    if (selectedPath && Object.hasOwn(files, selectedPath)) return;

    const requested = !initialFileAppliedRef.current && initialFile && Object.hasOwn(files, initialFile) ? initialFile : undefined;
    initialFileAppliedRef.current = true;
    const fallback = requested ?? (paths.includes('index.html') ? 'index.html' : (paths[0] ?? ''));
    // The selected source file must follow the externally synchronized file map.
    setSelectedPath(fallback);
    const content = fallback ? files[fallback] : '';
    // Unsaved work from before a navigation or reload comes back instead of being lost.
    const stored = fallback ? readCodeDraft(id, fallback) : null;
    if (stored && stored.draft !== content) {
      setDraft(stored.draft);
      setBase(stored.base);
      setDirty(true);
      setStatus({ text: `Restored your unsaved changes to ${fallback}.` });
      return;
    }
    setDraft(content);
    setBase(content);
    setDirty(false);
    setStatus({ text: '' });
  }, [files, id, initialFile, localReady, paths, selectedPath]);

  useEffect(() => {
    // Keep a clean draft synchronized with remote Yjs updates.
    if (dirty || !selectedPath) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(files[selectedPath] ?? '');
    setBase(files[selectedPath] ?? '');
  }, [dirty, files, selectedPath]);

  useEffect(() => {
    // Mirror the unsaved draft into the tab's session storage (services/codeDrafts.ts).
    if (!selectedPath) return;
    if (dirty) storeCodeDraft(id, selectedPath, { draft, base });
    else clearCodeDraft(id, selectedPath);
  }, [base, dirty, draft, id, selectedPath]);

  useEffect(() => {
    // Closing the tab is the one exit the stored draft does not survive.
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [dirty]);

  if (!id || !config || role === null || !localReady) {
    return <div className="p-8 text-center animate-pulse">Loading isolated source document…</div>;
  }

  if (role !== 'owner') {
    return <div className="p-8 text-center">Only the owner can edit Code App source.</div>;
  }

  const manifestResult = parseCodeAppManifest(files['manifest.yaml'] || '');
  const grantedHostSurfaces = manifestResult.error ? [] : grantedHostPermissionLabels(manifestResult.manifest);
  const fail = (error: unknown) => setStatus({ text: error instanceof Error ? error.message : String(error), failed: true });

  const discardDirtyDraft = async () => {
    if (!dirty) return true;
    const discard = await showConfirm(`Discard unsaved changes to ${selectedPath}?`, { title: 'Unsaved changes', confirmLabel: 'Discard', danger: true });
    if (discard) clearCodeDraft(id, selectedPath);
    return discard;
  };

  const selectFile = async (path: string) => {
    if (path === selectedPath) return;
    if (!(await discardDirtyDraft())) return;
    const content = files[path] ?? '';
    const stored = readCodeDraft(id, path);
    const restored = stored !== null && stored.draft !== content;
    setDirty(restored);
    setStatus({ text: restored ? `Restored your unsaved changes to ${path}.` : '' });
    setSelectedPath(path);
    setDraft(restored ? stored.draft : content);
    setBase(restored ? stored.base : content);
  };

  const save = async () => {
    if (!selectedPath) return;
    try {
      if (selectedPath === 'manifest.yaml') {
        const { error } = parseCodeAppManifest(draft);
        if (error) throw new Error(error);
      }
      // Another owner device saved this file while the draft was open: say so before replacing it.
      const current = files[selectedPath] ?? '';
      if (current !== base && current !== draft && !(await showConfirm(
        `${selectedPath} was changed on another device since you started editing. Saving replaces that version with yours.`,
        { title: 'File changed meanwhile', confirmLabel: 'Save mine', danger: true },
      ))) return;
      setCodeAppFile(id, selectedPath, draft);
      setBase(draft);
      // The manifest is the authoritative home of the schema (`entities`) and
      // of the display identity (`name`/`icon`/`color`); keep the dapp doc's
      // derived config.schema / config.meta in step with every save.
      if (selectedPath === 'manifest.yaml') {
        syncManifestEntities(id);
        syncManifestMeta(id);
      }
      setDirty(false);
      setStatus({ text: `Saved ${selectedPath} to the isolated Yjs source document.` });
    } catch (error) {
      fail(error);
    }
  };

  const createFile = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError('');
    if (!(await discardDirtyDraft())) return;

    try {
      createCodeAppFile(id, createPath, '');
      const nextPath = createPath.trim();
      setDirty(false);
      setSelectedPath(nextPath);
      setDraft('');
      setStatus({ text: `Created ${nextPath}.` });
      setCreateOpen(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const renameFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPath) return;
    setRenameError('');
    if (!(await discardDirtyDraft())) return;

    try {
      const previousPath = selectedPath;
      renameCodeAppFile(id, previousPath, renamePath);
      const nextPath = renamePath.trim();
      setDirty(false);
      setSelectedPath(nextPath);
      setDraft(files[previousPath] ?? '');
      setStatus({ text: `Renamed ${previousPath} to ${nextPath}.` });
      setRenameOpen(false);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteFile = async () => {
    if (!selectedPath || !(await discardDirtyDraft())) return;
    if (!(await showConfirm(`Delete ${selectedPath}? This cannot be undone.`, { title: 'Delete file', confirmLabel: 'Delete', danger: true }))) return;

    try {
      const deletedPath = selectedPath;
      const deletedIndex = paths.indexOf(deletedPath);
      const remainingPaths = paths.filter((path) => path !== deletedPath);
      const fallback = remainingPaths[Math.min(deletedIndex, remainingPaths.length - 1)] ?? '';
      deleteCodeAppFile(id, deletedPath);
      setDirty(false);
      setSelectedPath(fallback);
      setDraft(fallback ? files[fallback] ?? '' : '');
      setStatus({ text: `Deleted ${deletedPath}.` });
    } catch (error) {
      fail(error);
    }
  };

  const starter = selectedPath === 'index.html'
    ? DEFAULT_CODE_APP_HTML
    : selectedPath === 'manifest.yaml'
      ? DEFAULT_CODE_APP_MANIFEST_YAML
      : null;

  return (
    <div className="flex h-full w-full flex-col gap-5 overflow-y-auto overscroll-contain">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Code2 className="h-5 w-5 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-semibold">Code App</h1>
            {selectedPath && <Badge variant="secondary">{selectedPath}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            Source and route metadata sync in their own P2P Yjs document. Runtime data remains separate.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Host permissions: {grantedHostSurfaces.length ? grantedHostSurfaces.join(', ') : 'none declared'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {starter !== null && (
            <Button
              variant="outline"
              onClick={() => {
                void (async () => {
                  if (!dirty || await showConfirm(`Replace the current ${selectedPath} draft with its starter?`, { title: 'Reset to starter', confirmLabel: 'Replace' })) {
                    setDraft(starter);
                    setDirty(true);
                    setStatus({ text: 'Unsaved changes' });
                  }
                })();
              }}
            >
              <RotateCcw /> Starter
            </Button>
          )}
          <Button variant="outline" onClick={() => { void navigate(`/dapp/${id}`); }}>
            <Play /> View App
          </Button>
          <Button onClick={() => { void save(); }} disabled={!selectedPath || !dirty}>
            <Save /> Save
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 md:flex-row">
        <aside className="flex shrink-0 flex-col gap-3 md:min-h-0 md:w-64" aria-label="Code App file explorer">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Files</h2>
            <div className="flex gap-1">
              <Dialog open={createOpen} onOpenChange={(open) => {
                setCreateOpen(open);
                if (open) {
                  setCreatePath('');
                  setCreateError('');
                }
              }}>
                <DialogTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label="Create file" />}
                >
                  <FilePlus2 />
                </DialogTrigger>
                <DialogContent>
                  <form onSubmit={(event) => void createFile(event)} className="grid gap-4">
                    <DialogHeader>
                      <DialogTitle>Create file</DialogTitle>
                      <DialogDescription>Use a relative path such as styles/app.css.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2">
                      <Label htmlFor="create-code-app-path">File path</Label>
                      <Input
                        id="create-code-app-path"
                        value={createPath}
                        onChange={(event) => setCreatePath(event.target.value)}
                        autoFocus
                        aria-invalid={Boolean(createError)}
                      />
                      {createError && <p className="text-sm text-destructive" role="alert">{createError}</p>}
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                      <Button type="submit" disabled={!createPath.trim()}>Create</Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              <Dialog open={renameOpen} onOpenChange={(open) => {
                setRenameOpen(open);
                if (open) {
                  setRenamePath(selectedPath);
                  setRenameError('');
                }
              }}>
                <DialogTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label="Rename selected file" disabled={!selectedPath} />}
                >
                  <Pencil />
                </DialogTrigger>
                <DialogContent>
                  <form onSubmit={(event) => void renameFile(event)} className="grid gap-4">
                    <DialogHeader>
                      <DialogTitle>Rename file</DialogTitle>
                      <DialogDescription>Rename {selectedPath} or move it to a nested path.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2">
                      <Label htmlFor="rename-code-app-path">File path</Label>
                      <Input
                        id="rename-code-app-path"
                        value={renamePath}
                        onChange={(event) => setRenamePath(event.target.value)}
                        autoFocus
                        aria-invalid={Boolean(renameError)}
                      />
                      {renameError && <p className="text-sm text-destructive" role="alert">{renameError}</p>}
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
                      <Button type="submit" disabled={!renamePath.trim() || renamePath.trim() === selectedPath}>Rename</Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete selected file"
                disabled={!selectedPath}
                onClick={() => void deleteFile()}
              >
                <Trash2 />
              </Button>
            </div>
          </div>

          <div className="flex gap-1 overflow-x-auto rounded-lg border border-border p-1 md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto" role="group" aria-label="Code App files">
            {paths.length === 0 ? (
              <p className="min-w-52 p-4 text-center text-sm text-muted-foreground md:min-w-0">
                No files yet. Create one to get started.
              </p>
            ) : paths.map((path) => (
              <Button
                key={path}
                // Plain buttons, not a listbox: a listbox promises arrow-key navigation that was never there.
                aria-current={selectedPath === path ? 'true' : undefined}
                variant={selectedPath === path ? 'secondary' : 'ghost'}
                size="sm"
                className="min-w-max justify-start font-mono md:w-full md:min-w-0"
                title={path}
                onClick={() => void selectFile(path)}
              >
                <FileIcon path={path} />
                <span className="truncate">{path}</span>
              </Button>
            ))}
          </div>
        </aside>

        {selectedPath ? (
          <Card className="flex-1 overflow-hidden pb-0">
            <CardHeader className="border-b border-border py-3">
              <CardTitle className="flex items-center justify-between gap-4 text-sm font-medium">
                <span className="truncate">{selectedPath}</span>
                <span className="shrink-0 font-normal text-muted-foreground">{draft.length.toLocaleString()} characters</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col p-0">
              <Textarea
                aria-label={`Code App ${selectedPath} source`}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setDirty(true);
                  setStatus({ text: 'Unsaved changes' });
                }}
                spellCheck={false}
                className="min-h-[50vh] flex-1 resize-none rounded-none border-0 bg-transparent font-mono text-[13px] leading-5 shadow-none focus-visible:ring-0 md:min-h-64 dark:bg-transparent"
              />
            </CardContent>
          </Card>
        ) : (
          <Card className="flex min-h-80 flex-1 items-center justify-center">
            <CardContent className="text-center text-sm text-muted-foreground">
              Create a file to begin editing your Code App.
            </CardContent>
          </Card>
        )}
      </div>

      <p className={`min-h-5 text-sm ${status.failed ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
        {status.text}
      </p>
    </div>
  );
}
