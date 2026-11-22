import type * as Y from 'yjs';
import { parseCodeAppManifest } from '../codeAppManifest.ts';
import { isValidGithubLocation, type GithubLocation, type GithubSourceSnapshot } from '../githubSource.ts';
import { requireRole } from './auth.ts';
import { createDapp, removeDappCatalogEntry, syncManifestEntities, syncManifestMeta } from './config.ts';
import { getDappSourceDoc, persistNewDapp, purgeDappLocalResources } from './docs.ts';
import { getCodeAppFiles, replaceCodeAppFiles, validateCodeAppFiles } from './source.ts';

/**
 * A dapp installed from a public GitHub folder remembers where its sources
 * came from and which revision is installed. The record lives in the source
 * doc (map `origin`) so it travels with the files to every member; only owners
 * act on it. Updates are NEVER applied automatically — not in the browser and
 * not on a keeper: an owner reviews the new revision and applies it by hand
 * (`applyGithubUpdate` is owner-gated like every other source write).
 *
 * The origin is ordinary synced doc state and therefore peer-writable, exactly
 * like the source files themselves: it is validated on read, and it only ever
 * decides which repository an owner is OFFERED to review — it never triggers a
 * download or an install by itself.
 */
export interface GithubOrigin extends GithubLocation {
  /** Commit the installed files were copied from. */
  commitSha: string;
  /** Fingerprint of the installed (path, git blob) set — see githubSource.ts. */
  fingerprint: string;
  installedAt: string;
}

const ORIGIN_MAP = 'origin';
const DEFAULT_ICON = '📦';
const DEFAULT_COLOR = '#6366f1';

function originMap(dappId: string): Y.Map<unknown> {
  return getDappSourceDoc(dappId).getMap<unknown>(ORIGIN_MAP);
}

export function getGithubOrigin(dappId: string): GithubOrigin | null {
  const map = originMap(dappId);
  if (map.get('provider') !== 'github') return null;
  const text = (key: string) => { const value = map.get(key); return typeof value === 'string' ? value : null; };
  const owner = text('owner'); const repo = text('repo'); const ref = text('ref'); const path = text('path');
  const commitSha = text('commitSha'); const fingerprint = text('fingerprint');
  if (owner === null || repo === null || ref === null || path === null || commitSha === null || fingerprint === null) return null;
  if (!/^[0-9a-f]{40}$/.test(commitSha) || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  if (!isValidGithubLocation({ owner, repo, ref, path })) return null;
  return { owner, repo, ref, path, commitSha, fingerprint, installedAt: text('installedAt') ?? '' };
}

export function observeGithubOrigin(dappId: string, listener: () => void): () => void {
  const map = originMap(dappId);
  map.observe(listener);
  return () => { map.unobserve(listener); };
}

function writeOrigin(dappId: string, snapshot: GithubSourceSnapshot): void {
  const map = originMap(dappId);
  getDappSourceDoc(dappId).transact(() => {
    map.set('provider', 'github');
    map.set('owner', snapshot.location.owner);
    map.set('repo', snapshot.location.repo);
    map.set('ref', snapshot.location.ref);
    map.set('path', snapshot.location.path);
    map.set('commitSha', snapshot.commitSha);
    map.set('fingerprint', snapshot.fingerprint);
    map.set('installedAt', new Date().toISOString());
  }, 'github-origin');
}

/** Stops tracking GitHub for this dapp; the installed files stay as they are. */
export function disconnectGithubOrigin(dappId: string): void {
  requireRole(dappId, 'owner');
  const map = originMap(dappId);
  getDappSourceDoc(dappId).transact(() => { for (const key of [...map.keys()]) map.delete(key); }, 'github-origin');
}

/** Display identity a GitHub snapshot would install with (manifest first, repository name as fallback). */
export function githubSnapshotIdentity(snapshot: GithubSourceSnapshot): { name: string; icon: string; color: string } {
  const { manifest } = parseCodeAppManifest(snapshot.files['manifest.yaml'] ?? '');
  return { name: manifest.name || snapshot.location.repo, icon: manifest.icon || DEFAULT_ICON, color: manifest.color || DEFAULT_COLOR };
}

function installSnapshot(dappId: string, snapshot: GithubSourceSnapshot): void {
  replaceCodeAppFiles(dappId, snapshot.files);
  const declaresEntities = (parseCodeAppManifest(snapshot.files['manifest.yaml']).manifest.entities?.length ?? 0) > 0;
  if (declaresEntities && !syncManifestEntities(dappId)) throw new Error('github: The manifest entity schema could not be applied');
  syncManifestMeta(dappId);
  writeOrigin(dappId, snapshot);
}

/** Installs a verified GitHub snapshot as a new dapp (this device becomes its owner); rolls back on failure. */
export async function createGithubDapp(snapshot: GithubSourceSnapshot): Promise<string> {
  validateCodeAppFiles(snapshot.files);
  const identity = githubSnapshotIdentity(snapshot);
  const dappId = createDapp(identity.name, identity.icon, identity.color);
  try {
    installSnapshot(dappId, snapshot);
  } catch (error) {
    removeDappCatalogEntry(dappId);
    try {
      await purgeDappLocalResources(dappId);
    } catch (cleanupError) {
      console.error('Failed to clean up incomplete GitHub dapp:', cleanupError);
    }
    throw error;
  }
  // Stored before it is reported as created: a reload right after must not lose the document.
  await persistNewDapp(dappId);
  return dappId;
}

export interface GithubUpdateDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
}

/** What applying the snapshot would do to the files installed right now (local edits show up as changed/removed). */
export function diffGithubSnapshot(dappId: string, snapshot: GithubSourceSnapshot): GithubUpdateDiff {
  const current = getCodeAppFiles(dappId);
  const diff: GithubUpdateDiff = { added: [], changed: [], removed: [], unchanged: 0 };
  for (const path of Object.keys(snapshot.files).sort()) {
    if (!Object.hasOwn(current, path)) diff.added.push(path);
    else if (current[path] !== snapshot.files[path]) diff.changed.push(path);
    else diff.unchanged += 1;
  }
  for (const path of Object.keys(current).sort()) if (!Object.hasOwn(snapshot.files, path)) diff.removed.push(path);
  return diff;
}

/**
 * Owner-only, explicit update: replaces the source files with the reviewed
 * snapshot and re-pins the origin. The snapshot must come from the repository
 * this dapp tracks — a stale dialog cannot install some other location.
 */
export function applyGithubUpdate(dappId: string, snapshot: GithubSourceSnapshot): void {
  requireRole(dappId, 'owner');
  const origin = getGithubOrigin(dappId);
  if (!origin) throw new Error('github: This dapp is not linked to a GitHub repository');
  const { owner, repo, ref, path } = snapshot.location;
  if (owner !== origin.owner || repo !== origin.repo || ref !== origin.ref || path !== origin.path) {
    throw new Error('github: The update does not belong to the linked repository');
  }
  validateCodeAppFiles(snapshot.files);
  installSnapshot(dappId, snapshot);
}
