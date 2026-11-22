import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import type { DappFolder, DappListItem, HomeNode } from '../../types.ts';

/**
 * Home-screen layout: a manual order plus one level of folders.
 *
 * Position lives on the catalog item itself (`sortOrder`, an integer string,
 * spaced by 1024; optional `folderId`), folders live in the root map
 * `dappFolders`. Top-level dapps and folders share one `sortOrder` space; the
 * dapps of a folder order among themselves. Every write is a per-field `set`
 * on an existing map — a catalog item is never deleted and re-inserted, because
 * it holds the room credentials. The root doc is not synced, so the layout is
 * per device.
 *
 * Reads never trust the stored shape: `buildHomeLayout` treats a folder with
 * one or zero active dapps as absent and a dangling `folderId` as top level, so
 * leave / delete / keeper-remove need no hooks. `pruneFolders` makes that
 * physical inside every layout write.
 */

export const SORT_GAP = 1024;
export const FOLDER_NAME_MAX = 40;
const DEFAULT_FOLDER_NAME = 'Folder';
const ORIGIN = 'home-layout';

type CatalogItem = Y.Map<string>;

function getCatalog(doc: Y.Doc): Y.Array<CatalogItem> {
  return doc.getArray<CatalogItem>('dapps');
}

function getFolderMap(doc: Y.Doc): Y.Map<Y.Map<string>> {
  return doc.getMap<Y.Map<string>>('dappFolders');
}

function parseOrder(value: string | undefined, fallback: number): number {
  const order = parseInt(value ?? '', 10);
  return Number.isFinite(order) ? order : fallback;
}

/**
 * Sort key between two neighbours (`null` = no neighbour on that side).
 * Returns `null` when the gap is exhausted and the sibling set must be renumbered.
 */
export function between(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return SORT_GAP;
  if (left === null) return (right as number) - SORT_GAP;
  if (right === null) return left + SORT_GAP;
  return right - left < 2 ? null : Math.floor((left + right) / 2);
}

/** The catalog as plain objects in array order; a missing `sortOrder` falls back to the array index. */
export function readCatalogItems(doc: Y.Doc = getRootDoc()): DappListItem[] {
  return getCatalog(doc).map((item, index) => ({
    id: item.get('id') || '',
    name: item.get('name') || '',
    icon: item.get('icon') || '📱',
    color: item.get('color') || '#f97316',
    roomId: item.get('roomId') || '',
    roomPassword: item.get('roomPassword') || '',
    joinMethod: (item.get('joinMethod') as DappListItem['joinMethod']) || 'owner',
    role: (item.get('role') || 'owner') as DappListItem['role'],
    sortOrder: parseOrder(item.get('sortOrder'), index),
    createdAt: item.get('createdAt') || '',
    ...(item.get('archivedAt') ? { archivedAt: item.get('archivedAt') } : {}),
    ...(item.get('folderId') ? { folderId: item.get('folderId') } : {}),
  }));
}

export function readFolders(doc: Y.Doc = getRootDoc()): DappFolder[] {
  const folders: DappFolder[] = [];
  getFolderMap(doc).forEach((folder, id) => {
    if (!(folder instanceof Y.Map)) return;
    folders.push({
      id,
      name: folder.get('name') || DEFAULT_FOLDER_NAME,
      sortOrder: parseOrder(folder.get('sortOrder'), 0),
      createdAt: folder.get('createdAt') || '',
    });
  });
  return folders;
}

export function homeNodeId(node: HomeNode): string {
  return node.kind === 'dapp' ? node.dapp.id : node.folder.id;
}

/**
 * Pure layout: `items` in catalog array order. Archived items are left out
 * (they belong to "Left apps"); a folder with fewer than two active dapps is
 * treated as absent and its survivor renders at the folder's position.
 * Comparator: `sortOrder`, then array index, then id.
 */
export function buildHomeLayout(items: DappListItem[], folders: DappFolder[]): HomeNode[] {
  const index = new Map(items.map((item, i) => [item.id, i]));
  const byOrder = (a: DappListItem, b: DappListItem) =>
    a.sortOrder - b.sortOrder || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0) || a.id.localeCompare(b.id);

  const members = new Map<string, DappListItem[]>(folders.map((folder) => [folder.id, []]));
  const topLevel: DappListItem[] = [];
  for (const item of items) {
    if (item.archivedAt) continue;
    const group = item.folderId ? members.get(item.folderId) : undefined;
    if (group) group.push(item);
    else topLevel.push(item);
  }

  const nodes: HomeNode[] = [];
  for (const folder of folders) {
    const dapps = members.get(folder.id) ?? [];
    if (dapps.length >= 2) nodes.push({ kind: 'folder', folder, dapps: dapps.sort(byOrder) });
    else topLevel.push(...dapps.map((dapp) => ({ ...dapp, sortOrder: folder.sortOrder })));
  }
  for (const item of topLevel) {
    const dapp = { ...item };
    delete dapp.folderId; // dangling or dissolved
    nodes.push({ kind: 'dapp', dapp });
  }

  const order = (node: HomeNode) => (node.kind === 'dapp' ? node.dapp.sortOrder : node.folder.sortOrder);
  // Folders have no array index; on equal keys they sort after dapps.
  const position = (node: HomeNode) => (node.kind === 'dapp' ? index.get(node.dapp.id) ?? 0 : Number.MAX_SAFE_INTEGER);
  return nodes.sort((a, b) => order(a) - order(b) || position(a) - position(b) || homeNodeId(a).localeCompare(homeNodeId(b)));
}

/** Every active dapp in layout order, folder members inline at their folder's position. */
export function flattenHomeOrder(nodes: HomeNode[]): DappListItem[] {
  return nodes.flatMap((node) => (node.kind === 'dapp' ? [node.dapp] : node.dapps));
}

export function readHomeLayout(doc: Y.Doc = getRootDoc()): HomeNode[] {
  return buildHomeLayout(readCatalogItems(doc), readFolders(doc));
}

/**
 * Keyboard / menu moves as a drop position: the sibling to insert before
 * (`null` = the end), or `undefined` when the item cannot move that way.
 */
export function stepTarget(siblingIds: string[], id: string, step: 'up' | 'down' | 'top'): string | null | undefined {
  const at = siblingIds.indexOf(id);
  if (at < 0) return undefined;
  if (step === 'down') return at === siblingIds.length - 1 ? undefined : siblingIds[at + 2] ?? null;
  if (at === 0) return undefined;
  return step === 'top' ? siblingIds[0] : siblingIds[at - 1];
}

/** Next end position for a new top-level entry: max over top-level dapps AND folders, plus the gap. */
export function nextTopLevelSortOrder(doc: Y.Doc = getRootDoc()): string {
  let max = 0;
  getCatalog(doc).forEach((item, index) => {
    if (!item.get('folderId')) max = Math.max(max, parseOrder(item.get('sortOrder'), index));
  });
  for (const folder of readFolders(doc)) max = Math.max(max, folder.sortOrder);
  return String(max + SORT_GAP);
}

// ── Writes ──

/** One orderable thing: a catalog item or a folder map. */
interface Sibling {
  id: string;
  order: number;
  map: Y.Map<string>;
}

function setField(map: Y.Map<string>, key: string, value: string): void {
  if (map.get(key) !== value) map.set(key, value);
}

function catalogMaps(doc: Y.Doc): Map<string, CatalogItem> {
  const maps = new Map<string, CatalogItem>();
  getCatalog(doc).forEach((item) => maps.set(item.get('id') || '', item));
  return maps;
}

function dappSibling(dapp: DappListItem, maps: Map<string, CatalogItem>): Sibling | null {
  const map = maps.get(dapp.id);
  return map ? { id: dapp.id, order: dapp.sortOrder, map } : null;
}

function topLevelSiblings(doc: Y.Doc, nodes: HomeNode[]): Sibling[] {
  const maps = catalogMaps(doc);
  const folders = getFolderMap(doc);
  return nodes.flatMap((node) => {
    if (node.kind === 'dapp') return dappSibling(node.dapp, maps) ?? [];
    const map = folders.get(node.folder.id);
    return map ? { id: node.folder.id, order: node.folder.sortOrder, map } : [];
  });
}

function renumber(siblings: Sibling[]): void {
  siblings.forEach((sibling, i) => setField(sibling.map, 'sortOrder', String(i * SORT_GAP)));
}

/**
 * Puts `moved` before `beforeId` among `siblings` (`null` = at the end).
 * Returns false when the target vanished (stale drop) or nothing would change.
 */
function place(siblings: Sibling[], moved: Sibling, beforeId: string | null): boolean {
  if (beforeId === moved.id) return false;
  const current = siblings.findIndex((sibling) => sibling.id === moved.id);
  const others = siblings.filter((sibling) => sibling.id !== moved.id);
  const at = beforeId === null ? others.length : others.findIndex((sibling) => sibling.id === beforeId);
  if (at < 0) return false;
  if (current === at) return false; // already there
  const key = between(others[at - 1]?.order ?? null, others[at]?.order ?? null);
  if (key === null) renumber([...others.slice(0, at), moved, ...others.slice(at)]);
  else setField(moved.map, 'sortOrder', String(key));
  return true;
}

/**
 * Makes the on-read dissolve physical: a folder with one or zero active dapps
 * is removed (its survivor takes the folder's position) and dangling
 * `folderId`s are cleared. Runs inside every layout write.
 */
export function pruneFolders(doc: Y.Doc = getRootDoc()): void {
  doc.transact(() => {
    const folders = getFolderMap(doc);
    const active = new Map<string, CatalogItem[]>();
    getCatalog(doc).forEach((item) => {
      const folderId = item.get('folderId');
      if (!folderId) return;
      if (!folders.has(folderId)) item.delete('folderId');
      else if (!item.get('archivedAt')) active.set(folderId, [...(active.get(folderId) ?? []), item]);
    });
    for (const [folderId, folder] of [...folders.entries()]) {
      const members = active.get(folderId) ?? [];
      if (members.length >= 2) continue;
      const position = folder.get('sortOrder');
      if (members[0] && position) setField(members[0], 'sortOrder', position);
      getCatalog(doc).forEach((item) => {
        if (item.get('folderId') === folderId) item.delete('folderId');
      });
      folders.delete(folderId);
    }
  }, ORIGIN);
}

/**
 * Moves a dapp before the sibling `beforeId` (`null` / omitted = the end) at
 * top level, or inside the folder `folderId`. Returns false without writing
 * when the dapp, folder or sibling no longer exists, or nothing would change.
 */
export function moveDapp(
  dappId: string,
  target: { folderId?: string | null; beforeId?: string | null } = {},
  doc: Y.Doc = getRootDoc(),
): boolean {
  const folderId = target.folderId ?? null;
  const beforeId = target.beforeId ?? null;
  let moved = false;
  doc.transact(() => {
    pruneFolders(doc);
    const item = catalogMaps(doc).get(dappId);
    if (!item || item.get('archivedAt')) return;
    const nodes = readHomeLayout(doc);
    const dapp = flattenHomeOrder(nodes).find((entry) => entry.id === dappId);
    if (!dapp) return;
    let siblings: Sibling[];
    if (folderId === null) {
      siblings = topLevelSiblings(doc, nodes);
    } else {
      const folder = nodes.find((node) => node.kind === 'folder' && node.folder.id === folderId);
      if (folder?.kind !== 'folder') return;
      const maps = catalogMaps(doc);
      siblings = folder.dapps.flatMap((entry) => dappSibling(entry, maps) ?? []);
    }
    moved = place(siblings, { id: dappId, order: dapp.sortOrder, map: item }, beforeId);
    if (!moved) return;
    if (folderId === null) item.delete('folderId');
    else setField(item, 'folderId', folderId);
    pruneFolders(doc);
  }, ORIGIN);
  return moved;
}

/** Moves a folder before the top-level sibling `beforeId` (`null` = the end). */
export function moveFolder(folderId: string, beforeId: string | null = null, doc: Y.Doc = getRootDoc()): boolean {
  let moved = false;
  doc.transact(() => {
    pruneFolders(doc);
    if (!getFolderMap(doc).has(folderId)) return;
    const siblings = topLevelSiblings(doc, readHomeLayout(doc));
    const folder = siblings.find((sibling) => sibling.id === folderId);
    if (folder) moved = place(siblings, folder, beforeId);
  }, ORIGIN);
  return moved;
}

function cleanFolderName(name: string): string {
  return name.trim().slice(0, FOLDER_NAME_MAX) || DEFAULT_FOLDER_NAME;
}

/**
 * Drop `draggedId` onto the top-level dapp `targetId`: a new folder takes the
 * target's position and holds both (target first). No folders in folders — the
 * target must be a top-level dapp. Returns the folder id, or null when stale.
 */
export function createFolderFromDapps(
  targetId: string,
  draggedId: string,
  name: string = DEFAULT_FOLDER_NAME,
  doc: Y.Doc = getRootDoc(),
): string | null {
  let folderId: string | null = null;
  doc.transact(() => {
    pruneFolders(doc);
    if (targetId === draggedId) return;
    const maps = catalogMaps(doc);
    const dapps = flattenHomeOrder(readHomeLayout(doc));
    const target = dapps.find((dapp) => dapp.id === targetId);
    const dragged = dapps.find((dapp) => dapp.id === draggedId);
    const targetMap = maps.get(targetId);
    const draggedMap = maps.get(draggedId);
    if (!target || target.folderId || !dragged || !targetMap || !draggedMap) return;

    const id = crypto.randomUUID();
    const folder = new Y.Map<string>();
    folder.set('id', id);
    folder.set('name', cleanFolderName(name));
    folder.set('sortOrder', String(target.sortOrder));
    folder.set('createdAt', new Date().toISOString());
    getFolderMap(doc).set(id, folder);
    [targetMap, draggedMap].forEach((map, i) => {
      map.set('folderId', id);
      setField(map, 'sortOrder', String(i * SORT_GAP));
    });
    folderId = id;
    pruneFolders(doc); // the dragged dapp's previous folder may have dropped to one
  }, ORIGIN);
  return folderId;
}

export function renameFolder(folderId: string, name: string, doc: Y.Doc = getRootDoc()): boolean {
  let renamed = false;
  doc.transact(() => {
    const folder = getFolderMap(doc).get(folderId);
    if (!folder) return;
    setField(folder, 'name', cleanFolderName(name));
    renamed = true;
  }, ORIGIN);
  return renamed;
}

/** Dissolves a folder: its dapps return to top level, in order, at the folder's position. */
export function ungroupFolder(folderId: string, doc: Y.Doc = getRootDoc()): boolean {
  let ungrouped = false;
  doc.transact(() => {
    pruneFolders(doc);
    const nodes = readHomeLayout(doc);
    const folder = nodes.find((node) => node.kind === 'folder' && node.folder.id === folderId);
    if (folder?.kind !== 'folder') return;
    const maps = catalogMaps(doc);
    const members = folder.dapps.flatMap((dapp) => dappSibling(dapp, maps) ?? []);
    const siblings = topLevelSiblings(doc, nodes).flatMap((sibling) => (sibling.id === folderId ? members : [sibling]));
    members.forEach((member) => member.map.delete('folderId'));
    getFolderMap(doc).delete(folderId);
    renumber(siblings);
    ungrouped = true;
  }, ORIGIN);
  return ungrouped;
}
