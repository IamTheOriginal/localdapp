import { parseCodeAppManifest } from '../codeAppManifest.ts';
import { createDapp, removeDappCatalogEntry, syncManifestEntities, syncManifestMeta } from './config.ts';
import { persistNewDapp, purgeDappLocalResources } from './docs.ts';
import { MAX_CODE_APP_FILES, normalizeCodeAppFilePath, replaceCodeAppFiles, validateCodeAppFiles } from './source.ts';

/**
 * Code App starters are content, not code: static template bundles served from
 * `/starters/` (see `public/starters/`) and loaded at runtime. The core ships
 * no starter-specific logic — this module only knows how to fetch a catalog,
 * fetch one starter's files, validate them, and install them as a new dapp.
 *
 * Catalog format (`/starters/index.json`):
 *   { "schemaVersion": 1, "starters": [{ id, name, icon, color, pitch, files? }] }
 * Each starter's files live under `/starters/<id>/`: `index.html` and
 * `manifest.yaml` (whose `entities` section carries the schema) are always
 * fetched; `files` lists any additional source files (scripts, stylesheets,
 * vendored libraries, SVGs — relative paths, subdirectories allowed) that
 * `index.html` links to. The runtime inlines linked local resources at boot,
 * so a starter can be split into readable modules instead of one big HTML file.
 * Content is validated at install time exactly like any other Code App source
 * (`validateCodeAppFiles` + manifest parsing), so a malformed or tampered
 * bundle fails closed instead of installing.
 */

const STARTER_CATALOG_SCHEMA_VERSION = 1;
const STARTERS_BASE_PATH = '/starters';
const STARTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Every starter ships these two; the catalog's `files` list adds the rest. */
const STARTER_REQUIRED_FILES: readonly string[] = ['index.html', 'manifest.yaml'];

export interface CodeAppStarterSummary {
  id: string;
  name: string;
  icon: string;
  color: string;
  pitch: string;
  /** Complete source file list, canonical paths, required files first. */
  files: string[];
}

export interface CodeAppStarterDefinition extends CodeAppStarterSummary {
  /** Source snapshot keyed by canonical Code App path — installed verbatim. */
  source: Record<string, string>;
}

function asString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`starter catalog: ${label} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`starter catalog: ${label} exceeds ${maxLength} characters`);
  return value;
}

/** Validates a catalog `files` entry: the additional files beyond the required two. */
function asFileList(value: unknown, id: string): string[] {
  const files = [...STARTER_REQUIRED_FILES];
  if (value === undefined) return files;
  if (!Array.isArray(value)) throw new Error(`starter catalog: files of ${id} must be a list`);
  for (const entry of value) {
    const raw = asString(entry, `file path of ${id}`, 1_024);
    let path: string;
    try {
      path = normalizeCodeAppFilePath(raw);
    } catch (error) {
      throw new Error(`starter catalog: invalid file path "${raw}" in ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (path !== raw) throw new Error(`starter catalog: non-canonical file path "${raw}" in ${id}`);
    if (files.includes(path)) throw new Error(`starter catalog: duplicate file path "${path}" in ${id}`);
    files.push(path);
  }
  if (files.length > MAX_CODE_APP_FILES) throw new Error(`starter catalog: ${id} exceeds ${MAX_CODE_APP_FILES} files`);
  return files;
}

/** Parses and validates a fetched `/starters/index.json` payload. Pure — testable without fetch. */
export function parseStarterCatalog(payload: unknown): CodeAppStarterSummary[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('starter catalog: Malformed catalog document');
  const { schemaVersion, starters } = payload as { schemaVersion?: unknown; starters?: unknown };
  if (schemaVersion !== STARTER_CATALOG_SCHEMA_VERSION) throw new Error('starter catalog: Unsupported catalog schema version');
  if (!Array.isArray(starters)) throw new Error('starter catalog: Missing starters list');
  const seen = new Set<string>();
  return starters.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('starter catalog: Malformed starter entry');
    const raw = entry as Record<string, unknown>;
    const id = asString(raw.id, 'starter id', 64);
    if (!STARTER_ID_PATTERN.test(id)) throw new Error(`starter catalog: Invalid starter id "${id}"`);
    if (seen.has(id)) throw new Error(`starter catalog: Duplicate starter id "${id}"`);
    seen.add(id);
    return {
      id,
      name: asString(raw.name, `name of ${id}`, 120),
      icon: asString(raw.icon, `icon of ${id}`, 16),
      color: asString(raw.color, `color of ${id}`, 32),
      pitch: asString(raw.pitch, `pitch of ${id}`, 400),
      files: asFileList(raw.files, id),
    };
  });
}

async function fetchText(path: string, fetchImpl: typeof fetch): Promise<string> {
  // Starter files are copied into a dapp at install time: always revalidate
  // instead of trusting heuristic HTTP-cache freshness (a stale cached starter
  // would otherwise be installed right after a deploy).
  const response = await fetchImpl(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`starter catalog: Failed to load ${path} (${response.status})`);
  return response.text();
}

/** Loads the starter catalog from the deployment's static content. */
export async function fetchStarterCatalog(fetchImpl: typeof fetch = fetch): Promise<CodeAppStarterSummary[]> {
  const text = await fetchText(`${STARTERS_BASE_PATH}/index.json`, fetchImpl);
  return parseStarterCatalog(JSON.parse(text));
}

/** Loads one starter's full definition from static content (the manifest carries the schema). */
export async function fetchStarterDefinition(
  summary: CodeAppStarterSummary,
  fetchImpl: typeof fetch = fetch,
): Promise<CodeAppStarterDefinition> {
  if (!STARTER_ID_PATTERN.test(summary.id)) throw new Error(`starter catalog: Invalid starter id "${summary.id}"`);
  const base = `${STARTERS_BASE_PATH}/${summary.id}`;
  // Re-validate the list: a summary may arrive from outside parseStarterCatalog.
  const files = asFileList(summary.files.filter((path) => !STARTER_REQUIRED_FILES.includes(path)), summary.id);
  const contents = await Promise.all(files.map((path) => fetchText(`${base}/${path}`, fetchImpl)));
  const source: Record<string, string> = {};
  files.forEach((path, index) => { source[path] = contents[index]; });
  const definition: CodeAppStarterDefinition = { ...summary, files, source };
  validateStarterDefinition(definition);
  return definition;
}

/** Full structural validation of a starter definition; throws on any defect. */
export function validateStarterDefinition(definition: CodeAppStarterDefinition): void {
  const parsed = parseCodeAppManifest(definition.source['manifest.yaml'] ?? '');
  if (parsed.error) throw new Error(`Invalid starter manifest for ${definition.id}: ${parsed.error}`);
  const listed = new Set(definition.files);
  const present = Object.keys(definition.source);
  if (listed.size !== definition.files.length || present.length !== listed.size || present.some((path) => !listed.has(path))) {
    throw new Error(`Starter ${definition.id} source does not match its file list`);
  }
  validateCodeAppFiles(definition.source);
  // The manifest carries the schema when one exists (parseEntities enforces its
  // structure, incl. rejecting a present-but-empty array). A manifest with no
  // entities section is a valid runtime-managed-schema app ($store collections
  // are created lazily), so its absence is not a defect.
}

/** Installs a validated starter definition as a new dapp; rolls back on failure. */
export async function createStarterDapp(definition: CodeAppStarterDefinition): Promise<string> {
  validateStarterDefinition(definition);
  const dappId = createDapp(definition.name, definition.icon, definition.color);
  try {
    replaceCodeAppFiles(dappId, definition.source);
    const declaresEntities = (parseCodeAppManifest(definition.source['manifest.yaml']).manifest.entities?.length ?? 0) > 0;
    if (declaresEntities && !syncManifestEntities(dappId)) {
      throw new Error(`Starter ${definition.id} did not seed its entity schema`);
    }
    syncManifestMeta(dappId);
  } catch (error) {
    removeDappCatalogEntry(dappId);
    try {
      await purgeDappLocalResources(dappId);
    } catch (cleanupError) {
      console.error('Failed to clean up incomplete starter dapp:', cleanupError);
    }
    throw error;
  }
  // Stored before it is reported as created: a reload right after must not lose the document.
  await persistNewDapp(dappId);
  return dappId;
}
