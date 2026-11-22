import { bufferToHex } from '../lib/hex.ts';

/**
 * Public-GitHub source loader for Code Apps. Plain fetch against two open,
 * CORS-enabled endpoints — no SDK, no token:
 *   - api.github.com   resolves a ref to a commit and lists its file tree
 *   - raw.githubusercontent.com   serves file bytes at that exact commit
 * Every downloaded file is re-hashed as a git blob and compared with the tree
 * listing, so what gets installed is exactly what the pinned commit contains.
 * Unauthenticated API calls are rate limited (60/hour per IP): an install
 * costs 2 calls, an update check 1 (2 when the commit moved).
 *
 * This module is pure transport + validation. It never touches the store and
 * nothing here runs on its own — callers decide when to fetch.
 */

const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
/** Code App files are text (Y.Text) — only these extensions are copied. */
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.json', '.yaml', '.yml', '.svg', '.txt']);
const REQUIRED_FILES = ['index.html', 'manifest.yaml'];
const MAX_FILES = 64;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;
/** `tree/<ref>/<path>` is ambiguous when a branch name contains slashes; try this many leading segments as the ref. */
const MAX_REF_SEGMENTS = 3;

export interface GithubLocation {
  owner: string;
  repo: string;
  /** Branch, tag or commit; '' follows the repository's default branch. */
  ref: string;
  /** Folder inside the repository that holds index.html + manifest.yaml; '' is the repository root. */
  path: string;
}

export interface GithubTreeSnapshot {
  commitSha: string;
  /** Code App path (relative to the location's folder) -> git blob SHA-1. */
  blobs: Record<string, string>;
  /** Repository files in the folder that are not copied (binary/unsupported type or dot-paths). */
  skipped: string[];
  /** SHA-256 over the sorted (path, blob) pairs — changes exactly when a copied file changes. */
  fingerprint: string;
}

export interface GithubSourceSnapshot extends GithubTreeSnapshot {
  location: GithubLocation;
  files: Record<string, string>;
}

function isSafeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..' || segment.includes('\\')) return false;
  for (let index = 0; index < segment.length; index++) {
    const code = segment.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

/** `.` and `..` match the character class but make URL normalization climb to another api.github.com path. */
function isRepositoryName(name: string): boolean {
  return NAME_PATTERN.test(name) && !/^\.+$/.test(name);
}

function assertLocation(location: GithubLocation): void {
  if (!isRepositoryName(location.owner) || !isRepositoryName(location.repo)) throw new Error('github: Invalid repository name');
  if (location.ref.length > 255 || (location.ref && !location.ref.split('/').every(isSafeSegment))) throw new Error('github: Invalid branch or tag');
  if (location.path.length > 1_024 || (location.path && !location.path.split('/').every(isSafeSegment))) throw new Error('github: Invalid folder path');
}

/** Whether a value read from untrusted storage is a well-formed location. */
export function isValidGithubLocation(value: GithubLocation): boolean {
  try { assertLocation(value); return true; } catch { return false; }
}

export function githubLocationUrl(location: GithubLocation, commitSha?: string): string {
  const base = `https://github.com/${location.owner}/${location.repo}`;
  const ref = commitSha ?? location.ref;
  if (!ref && !location.path) return base;
  return `${base}/tree/${ref || 'HEAD'}${location.path ? `/${location.path}` : ''}`;
}

export function githubCompareUrl(location: GithubLocation, fromCommit: string, toCommit: string): string {
  return `https://github.com/${location.owner}/${location.repo}/compare/${fromCommit}...${toCommit}`;
}

/**
 * Parses a github.com link into candidate locations (most likely first).
 * Accepts the repository root, `/tree/<ref>[/<folder>]`, and a `/blob/` link to
 * a file (its folder is used). More than one candidate is returned only when
 * the ref/folder split is ambiguous; `resolveGithubLocation` picks the real one.
 */
export function parseGithubUrl(input: string): GithubLocation[] {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('github: Not a valid link');
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')) {
    throw new Error('github: Only https://github.com links are supported');
  }
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error('github: Not a valid link');
  }
  if (segments.length < 2) throw new Error('github: The link must point to a repository (github.com/<owner>/<repo>)');
  const [owner, rawRepo, kind, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/, '');
  if (kind === undefined) {
    const location = { owner, repo, ref: '', path: '' };
    assertLocation(location);
    return [location];
  }
  if ((kind !== 'tree' && kind !== 'blob') || rest.length === 0) {
    throw new Error('github: Link the repository itself or a folder inside it (…/tree/<branch>/<folder>)');
  }
  // A /blob/ link names a file: the app folder is the file's directory.
  const refAndPath = kind === 'blob' ? rest.slice(0, -1) : rest;
  if (refAndPath.length === 0) throw new Error('github: Link the repository itself or a folder inside it (…/tree/<branch>/<folder>)');
  const candidates: GithubLocation[] = [];
  for (let refLength = 1; refLength <= Math.min(refAndPath.length, MAX_REF_SEGMENTS); refLength++) {
    const location = { owner, repo, ref: refAndPath.slice(0, refLength).join('/'), path: refAndPath.slice(refLength).join('/') };
    assertLocation(location);
    candidates.push(location);
  }
  return candidates;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

class GithubNotFoundError extends Error {}

async function apiJson(path: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-cache' });
  } catch (error) {
    throw new Error('github: GitHub is not reachable right now', { cause: error });
  }
  if (response.status === 404 || response.status === 422) {
    throw new GithubNotFoundError('github: Repository, branch or folder not found — only public repositories can be added');
  }
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('github: GitHub rate limit reached for this network — try again in an hour');
  }
  if (!response.ok) throw new Error(`github: GitHub answered with status ${response.status}`);
  return response.json();
}

interface ResolvedCommit { commitSha: string; treeSha: string }

async function resolveCommit(location: GithubLocation, fetchImpl: typeof fetch): Promise<ResolvedCommit> {
  const payload = await apiJson(`/repos/${location.owner}/${location.repo}/commits/${encodePath(location.ref || 'HEAD')}`, fetchImpl) as
    { sha?: unknown; commit?: { tree?: { sha?: unknown } } } | null;
  const commitSha = payload?.sha;
  const treeSha = payload?.commit?.tree?.sha;
  if (typeof commitSha !== 'string' || !SHA1_PATTERN.test(commitSha) || typeof treeSha !== 'string' || !SHA1_PATTERN.test(treeSha)) {
    throw new Error('github: Unexpected commit response');
  }
  return { commitSha, treeSha };
}

/** Picks the first candidate whose ref exists; returns it with the commit it currently points to. */
export async function resolveGithubLocation(
  candidates: GithubLocation[],
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedCommit & { location: GithubLocation }> {
  let notFound: unknown = new Error('github: No repository location given');
  for (const location of candidates) {
    assertLocation(location);
    try {
      return { location, ...await resolveCommit(location, fetchImpl) };
    } catch (error) {
      if (!(error instanceof GithubNotFoundError)) throw error;
      notFound = error;
    }
  }
  throw notFound;
}

interface TreeEntry { path: string; type: string; sha: string; size?: number }

async function fetchTree(location: GithubLocation, sha: string, recursive: boolean, fetchImpl: typeof fetch): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const payload = await apiJson(`/repos/${location.owner}/${location.repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, fetchImpl) as
    { tree?: unknown; truncated?: unknown } | null;
  if (!payload || !Array.isArray(payload.tree)) throw new Error('github: Unexpected tree response');
  const entries = (payload.tree as Array<Partial<TreeEntry>>).filter((entry): entry is TreeEntry => (
    typeof entry.path === 'string' && typeof entry.type === 'string' && typeof entry.sha === 'string' && SHA1_PATTERN.test(entry.sha)
  ));
  return { entries, truncated: payload.truncated === true };
}

async function fingerprintBlobs(blobs: Record<string, string>): Promise<string> {
  const pairs = Object.keys(blobs).sort().map((path) => [path, blobs[path]]);
  return bufferToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(pairs))));
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Lists the Code App files of a location at one commit — no file content is downloaded. */
export async function fetchGithubTree(
  location: GithubLocation,
  commit: ResolvedCommit,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTreeSnapshot> {
  assertLocation(location);
  let { entries, truncated } = await fetchTree(location, commit.treeSha, true, fetchImpl);
  let prefix = location.path ? `${location.path}/` : '';
  if (truncated && location.path) {
    // Huge repository: walk down to the app folder and list only that subtree.
    let sha = commit.treeSha;
    for (const segment of location.path.split('/')) {
      const level = await fetchTree(location, sha, false, fetchImpl);
      const next = level.entries.find((entry) => entry.type === 'tree' && entry.path === segment);
      if (!next) throw new Error('github: Folder not found in the repository');
      sha = next.sha;
    }
    ({ entries, truncated } = await fetchTree(location, sha, true, fetchImpl));
    prefix = '';
  }
  if (truncated) throw new Error('github: This repository is too large to list — link the folder that contains the app instead');

  const blobs: Record<string, string> = {};
  const skipped: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    const segments = path.split('/');
    if (!segments.every(isSafeSegment)) continue;
    if (segments.some((segment) => segment.startsWith('.')) || segments.includes('node_modules') || !TEXT_EXTENSIONS.has(extensionOf(path))) {
      skipped.push(path);
      continue;
    }
    const size = typeof entry.size === 'number' ? entry.size : 0;
    if (size > MAX_FILE_BYTES) throw new Error(`github: ${path} is larger than the 1 MB Code App file limit`);
    totalBytes += size;
    Object.defineProperty(blobs, path, { value: entry.sha, enumerable: true, configurable: true, writable: true });
  }
  const missing = REQUIRED_FILES.filter((path) => !Object.hasOwn(blobs, path));
  if (missing.length > 0) {
    throw new Error(`github: No ${missing.join(' and ')} in ${location.path ? `the folder "${location.path}"` : 'the repository root'} — link the folder that contains the Code App`);
  }
  if (Object.keys(blobs).length > MAX_FILES) throw new Error(`github: The folder has more than ${MAX_FILES} source files — link a smaller folder`);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('github: The sources exceed the 4 MB Code App limit');
  return { commitSha: commit.commitSha, blobs, skipped: skipped.sort(), fingerprint: await fingerprintBlobs(blobs) };
}

async function gitBlobSha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  // git hashes "blob <byte length><NUL><content>".
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}`);
  const framed = new Uint8Array(header.byteLength + 1 + bytes.byteLength);
  framed.set(header);
  framed.set(bytes, header.byteLength + 1);
  return bufferToHex(await crypto.subtle.digest('SHA-1', framed));
}

async function fetchBlobText(location: GithubLocation, commitSha: string, path: string, expectedSha: string, fetchImpl: typeof fetch): Promise<string> {
  const fullPath = location.path ? `${location.path}/${path}` : path;
  let response: Response;
  try {
    response = await fetchImpl(`${RAW_BASE}/${location.owner}/${location.repo}/${commitSha}/${encodePath(fullPath)}`, { cache: 'no-cache' });
  } catch (error) {
    throw new Error('github: GitHub is not reachable right now', { cause: error });
  }
  if (!response.ok) throw new Error(`github: Failed to download ${path} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await gitBlobSha(bytes) !== expectedSha) throw new Error(`github: ${path} does not match the repository listing`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`github: ${path} is not a UTF-8 text file`);
  }
}

/** Downloads the listed files at the snapshot's pinned commit, each verified against its git blob hash. */
export async function downloadGithubSnapshot(
  location: GithubLocation,
  tree: GithubTreeSnapshot,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubSourceSnapshot> {
  assertLocation(location);
  const paths = Object.keys(tree.blobs);
  const contents = await Promise.all(paths.map((path) => fetchBlobText(location, tree.commitSha, path, tree.blobs[path], fetchImpl)));
  const files: Record<string, string> = {};
  paths.forEach((path, index) => {
    Object.defineProperty(files, path, { value: contents[index], enumerable: true, configurable: true, writable: true });
  });
  return { ...tree, location, files };
}

/** Link -> verified source snapshot (the install path). */
export async function fetchGithubSource(input: string, fetchImpl: typeof fetch = fetch): Promise<GithubSourceSnapshot> {
  const resolved = await resolveGithubLocation(parseGithubUrl(input), fetchImpl);
  const tree = await fetchGithubTree(resolved.location, resolved, fetchImpl);
  return downloadGithubSnapshot(resolved.location, tree, fetchImpl);
}

/**
 * Cheap change probe for an installed location: resolves the ref's current
 * commit and only lists the tree when that commit differs from `knownCommitSha`.
 * Returns null when the commit is unchanged.
 */
export async function probeGithubLocation(
  location: GithubLocation,
  knownCommitSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTreeSnapshot | null> {
  const commit = await resolveCommit(location, fetchImpl);
  if (commit.commitSha === knownCommitSha) return null;
  return fetchGithubTree(location, commit, fetchImpl);
}
