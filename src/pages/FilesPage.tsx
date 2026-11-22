import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, FileIcon, FolderOpen, HardDrive, Loader2, Paperclip, Pin, PinOff, Trash2, Users } from 'lucide-react';
import { getDappDoc, deleteFileRecord, listFileRecords } from '../services/store/index.ts';
import { isBlobStillReferenced } from '../services/store/blobReferences.ts';
import { ingestLocalFile } from '../services/fileIngest.ts';
import { getDappBlobReplication, setDappBlobReplication, type BlobReplicationMode } from '../services/store/docs.ts';
import { blobDescriptorOf, getBlobStore, type BlobMeta } from '../services/blobStore.ts';
import { countBlobHolders, ensureBlobChannel, fetchBlobFromPeers, replicateAllBlobs } from '../services/blobRoomManager.ts';
import { useMyRole } from '../hooks/useYjs.ts';
import { useI18n } from '@/i18n';
import { showConfirm } from '@/services/dialogs.ts';
import type { FileRecord } from '../types.ts';
import { formatBytes } from '../lib/format.ts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DappContent } from '@/components/DappContent.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { Card, CardContent } from '@/components/ui/card';

/** Returns `previous` when both maps hold the same entries, so an unchanged poll does not re-render. */
function keepIfEqual<T extends string | number | boolean>(previous: Record<string, T>, next: Record<string, T>): Record<string, T> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return next;
  return keys.every((key) => previous[key] === next[key]) ? previous : next;
}

export default function FilesPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const role = useMyRole(id);
  const canWrite = role === 'owner' || role === 'editor';

  const [records, setRecords] = useState<FileRecord[]>([]);
  const [localAvailability, setLocalAvailability] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [holders, setHolders] = useState<Record<string, number>>({});
  const [replication, setReplication] = useState<BlobReplicationMode>(() => (id ? getDappBlobReplication(id) : 'onDemand'));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Holder counts come from memory (the mesh's have-announcements) and change over
  // time; local availability needs an IndexedDB read and only changes on an event.
  const refreshHolders = useCallback((rows: FileRecord[]) => {
    if (id) setHolders((previous) => keepIfEqual(previous, Object.fromEntries(rows.map((row) => [row.sha256, countBlobHolders(id, row.sha256)]))));
  }, [id]);

  const refreshAvailability = useCallback(async (rows: FileRecord[]) => {
    const store = getBlobStore();
    const metas = new Map((await store.listBlobs()).map((meta: BlobMeta) => [meta.sha256, meta]));
    setLocalAvailability((previous) => keepIfEqual(previous, Object.fromEntries(rows.map((row) => [row.sha256, metas.get(row.sha256)?.complete === true]))));
    setPinned((previous) => keepIfEqual(previous, Object.fromEntries(rows.map((row) => [row.sha256, metas.get(row.sha256)?.pinned === true]))));
    refreshHolders(rows);
  }, [refreshHolders]);

  useEffect(() => {
    if (!id) return;
    const doc = getDappDoc(id);
    const files = doc.getMap('files');
    const refresh = () => {
      const rows = listFileRecords(id);
      setRecords(rows);
      void refreshAvailability(rows);
    };
    refresh();
    files.observeDeep(refresh);
    void ensureBlobChannel(id).then(() => replicateAllBlobs(id)).then(() => refresh())
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    // Peer have-announcements arrive over time: poll the (in-memory) holder counts
    // often, and re-read the chunk store only now and then — pin-all replication
    // completes files in the background without any doc event.
    let tick = 0;
    const holderTimer = window.setInterval(() => {
      tick += 1;
      if (tick % 6 === 0) refresh();
      else refreshHolders(listFileRecords(id));
    }, 5000);
    // The channel is NOT closed here: it is the member mesh that carries the
    // dapp's live sync, and its lifecycle belongs to store/docs.ts. Closing it
    // on leaving this page took the whole dapp offline until it was reopened.
    return () => {
      files.unobserveDeep(refresh);
      window.clearInterval(holderTimer);
    };
  }, [id, refreshAvailability, refreshHolders]);

  const handleReplicationToggle = async () => {
    if (!id) return;
    const next: BlobReplicationMode = replication === 'pinAll' ? 'onDemand' : 'pinAll';
    setDappBlobReplication(id, next);
    setReplication(next);
    if (next === 'pinAll') {
      setBusy(t('Fetching from peers…'));
      setError(null);
      try {
        await replicateAllBlobs(id);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
        void refreshAvailability(listFileRecords(id));
      }
    }
  };

  const handlePinToggle = async (record: FileRecord) => {
    if (!id) return;
    setError(null);
    try {
      await getBlobStore().setPinned(record.sha256, !pinned[record.sha256]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    void refreshAvailability(listFileRecords(id));
  };

  const handleAttach = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!id || chosen.length === 0) return;
    setBusy(t('Adding files…'));
    setError(null);
    try {
      // Inline thumbnails live in the shared doc — for bulk attachments skip
      // them so the document stays light for every member.
      const thumbnail = chosen.length <= 20;
      for (const file of chosen) {
        await ingestLocalFile(id, file, { name: file.name, mime: file.type, thumbnail });
      }
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : String(attachError));
    } finally {
      setBusy(null);
    }
  };

  const handleOpen = async (record: FileRecord) => {
    if (!id) return;
    setError(null);
    let bytes: Uint8Array | null;
    try {
      bytes = await getBlobStore().getBlob(record.sha256);
      if (!bytes) {
        setBusy(t('Fetching from peers…'));
        const fetched = await fetchBlobFromPeers(id, blobDescriptorOf(record));
        if (fetched) {
          bytes = await getBlobStore().getBlob(record.sha256);
          void refreshAvailability(listFileRecords(id));
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    } finally {
      setBusy(null);
    }
    if (!bytes) {
      setError(t('This file is not on this device yet. A connected member must be online to fetch it.'));
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes as BufferSource], { type: record.mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = record.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const handleDelete = async (record: FileRecord) => {
    if (!id) return;
    if (!(await showConfirm(t('Delete this file for all members? Devices that already downloaded it keep their copy until they clean up.'), { title: t('Delete'), confirmLabel: t('Delete'), danger: true }))) return;
    setError(null);
    try {
      await deleteFileRecord(id, record.id);
      if (!(await isBlobStillReferenced(id, record.sha256))) await getBlobStore().deleteBlob(record.sha256);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  if (!id) return null;

  return (
    <DappContent>
      <PageHeader
        icon={<FolderOpen className="h-5 w-5" />}
        title={t('Files')}
        description={t('Files sync peer-to-peer between members. Content stays on member devices — nothing is uploaded to a server.')}
        actions={(
          <>
            <Button variant={replication === 'pinAll' ? 'default' : 'outline'} onClick={() => void handleReplicationToggle()} disabled={busy !== null}>
              <Pin className="h-4 w-4" aria-hidden="true" />
              {replication === 'pinAll' ? t('Keeping all files on this device') : t('Keep all files on this device')}
            </Button>
            {canWrite && (
              <Button onClick={() => fileInputRef.current?.click()} disabled={busy !== null}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Paperclip className="h-4 w-4" aria-hidden="true" />}
                {busy ?? t('Add files')}
              </Button>
            )}
          </>
        )}
      />
      <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={(event) => void handleAttach(event)} aria-label={t('Add files')} />

      {error && <Alert variant="destructive" role="alert" className="mb-4">{error}</Alert>}

      {records.length === 0 ? (
        <EmptyState icon={<FolderOpen className="h-6 w-6" />} title={t('No files yet.')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {records.map((record) => (
            <li key={record.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3 p-4">
                  <div className="flex items-center gap-3">
                    {record.thumbnail ? (
                      <img src={record.thumbnail} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <FileIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={record.name}>{record.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(record.size)}</p>
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
                      {localAvailability[record.sha256] ? t('On this device') : t('Remote')}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground" title={t('Connected members holding a copy')}>
                      <Users className="h-3.5 w-3.5" aria-hidden="true" />
                      {(holders[record.sha256] ?? 0) + (localAvailability[record.sha256] ? 1 : 0)}
                    </span>
                    <span className="ml-auto flex gap-1">
                      {localAvailability[record.sha256] && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={pinned[record.sha256] ? t('Unpin') : t('Pin')}
                          title={pinned[record.sha256] ? t('Pinned: never evicted by cleanup') : t('Unpinned: may be evicted when storage runs low')}
                          onClick={() => void handlePinToggle(record)}
                        >
                          {pinned[record.sha256]
                            ? <Pin className="h-4 w-4 text-primary" aria-hidden="true" />
                            : <PinOff className="h-4 w-4" aria-hidden="true" />}
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" aria-label={`${t('Download')}: ${record.name}`} onClick={() => void handleOpen(record)}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      {canWrite && (
                        <Button variant="ghost" size="icon" aria-label={`${t('Delete')}: ${record.name}`} onClick={() => void handleDelete(record)}>
                          <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                        </Button>
                      )}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </DappContent>
  );
}
