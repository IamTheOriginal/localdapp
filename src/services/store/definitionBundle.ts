import type { CanonicalJson, CodeAppDefinitionBundle } from '../../types.ts';
import { getSigningIdentity } from '../identity.ts';
import { parseCodeAppManifest } from '../codeAppManifest.ts';
import { canonicalizeJson } from '../relationshipStream.ts';
import { signRelationshipControl, verifyRelationshipControl } from '../relationshipProtocol.ts';
import { createDapp, getDappConfig, syncManifestEntities, syncManifestMeta } from './config.ts';
import { getDappDoc, getDappPersistence, getDappSourceDoc, getDappSourcePersistence, persistNewDapp } from './docs.ts';
import { containerRecords } from './recordContainers.ts';
import { requireRole } from './auth.ts';
import { requireLocalCopyLoaded } from './storageHealth.ts';
import { getCodeAppFiles, replaceCodeAppFiles, validateCodeAppFiles } from './source.ts';
import { sealSourceNow } from './sourceSeal.ts';
import { disconnectGithubOrigin, getGithubOrigin } from './githubOrigin.ts';

const BUNDLE_KEYS = [
  'protocol', 'schemaVersion', 'name', 'icon', 'color', 'files',
  'manifestVersion', 'createdAt', 'authorPublicKey', 'signature',
] as const;
const FORBIDDEN_INSTANCE_KEYS = new Set([
  'data', 'appData', 'members', 'roomId', 'roomPassword', 'lobbyId', 'lobbyPassword',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertText(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Code App definition has invalid ${label}`);
  }
}

function definitionSigningValue(bundle: Omit<CodeAppDefinitionBundle, 'signature'>): CanonicalJson {
  return {
    protocol: bundle.protocol,
    schemaVersion: bundle.schemaVersion,
    name: bundle.name,
    icon: bundle.icon,
    color: bundle.color,
    files: bundle.files,
    manifestVersion: bundle.manifestVersion,
    createdAt: bundle.createdAt,
    authorPublicKey: bundle.authorPublicKey,
  };
}

export function computeDefinitionManifestVersion(files: Record<string, string>): string {
  const bytes = new TextEncoder().encode(canonicalizeJson(files));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Structural privacy assertion. Source-file strings are intentionally opaque. */
export function assertDefinitionOnlyBundle(value: unknown): asserts value is CodeAppDefinitionBundle {
  if (!isPlainRecord(value)) throw new Error('Code App definition must be an object');
  const required = new Set<string>(BUNDLE_KEYS);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (FORBIDDEN_INSTANCE_KEYS.has(key)) {
      throw new Error(`Code App definition must not contain instance-specific field ${key}`);
    }
    if (!required.has(key)) {
      throw new Error('Code App definition contains unsupported or instance-specific fields');
    }
  }
  for (const key of required) {
    if (!keys.includes(key)) throw new Error('Code App definition contains unsupported or instance-specific fields');
  }
}

export async function verifyDefinitionBundle(value: unknown): Promise<CodeAppDefinitionBundle> {
  assertDefinitionOnlyBundle(value);
  if (value.protocol !== 'code-app-definition' || value.schemaVersion !== 1) {
    throw new Error('Unsupported Code App definition protocol');
  }
  assertText(value.name, 'name', 120);
  assertText(value.icon, 'icon', 32);
  assertText(value.color, 'color', 64);
  assertText(value.createdAt, 'createdAt', 64);
  if (!Number.isFinite(Date.parse(value.createdAt))) throw new Error('Code App definition has invalid createdAt');
  if (!/^[a-f0-9]{64}$/.test(value.authorPublicKey)) throw new Error('Code App definition has invalid author key');
  if (!/^[a-f0-9]{128}$/.test(value.signature)) throw new Error('Code App definition has invalid signature');
  if (!/^[a-f0-9]{8}$/.test(value.manifestVersion)) throw new Error('Code App definition has invalid manifest version');
  if (!isPlainRecord(value.files)) throw new Error('Code App definition files must be an object');

  const rawFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(value.files)) {
    if (typeof content !== 'string') throw new Error('Code App definition file contents must be strings');
    Object.defineProperty(rawFiles, path, {
      value: content, enumerable: true, configurable: true, writable: true,
    });
  }
  const files = validateCodeAppFiles(rawFiles);
  const manifestVersion = computeDefinitionManifestVersion(files);
  if (manifestVersion !== value.manifestVersion) throw new Error('Code App definition source fingerprint does not match');

  const unsigned: Omit<CodeAppDefinitionBundle, 'signature'> = {
    protocol: 'code-app-definition', schemaVersion: 1,
    name: value.name, icon: value.icon, color: value.color, files,
    manifestVersion, createdAt: value.createdAt, authorPublicKey: value.authorPublicKey,
  };
  if (!await verifyRelationshipControl(definitionSigningValue(unsigned), value.signature, value.authorPublicKey)) {
    throw new Error('Code App definition signature is invalid');
  }

  const parsedManifest = parseCodeAppManifest(files['manifest.yaml']);
  if (parsedManifest.error) throw new Error(`Invalid Code App manifest: ${parsedManifest.error}`);
  return { ...unsigned, signature: value.signature };
}

export async function exportDefinitionBundle(
  dappId: string,
  signingIdentity?: { publicKey: string; privateKey: string | CryptoKey },
): Promise<CodeAppDefinitionBundle> {
  // Open both documents first so their IndexedDB providers exist, then authorize against
  // restored membership state and snapshot restored source state.
  getDappDoc(dappId);
  getDappSourceDoc(dappId);
  await Promise.all([
    requireLocalCopyLoaded(getDappPersistence(dappId)),
    requireLocalCopyLoaded(getDappSourcePersistence(dappId)),
  ]);
  requireRole(dappId, 'owner');
  const identity = signingIdentity ?? await getSigningIdentity();

  const config = getDappConfig(dappId);
  if (!config) throw new Error('Dapp configuration is unavailable');
  // The manifest's `entities` section inside the signed files is the schema's
  // one and only carrier.
  const files = validateCodeAppFiles(getCodeAppFiles(dappId));
  const unsigned: Omit<CodeAppDefinitionBundle, 'signature'> = {
    protocol: 'code-app-definition', schemaVersion: 1,
    name: config.meta.name, icon: config.meta.icon, color: config.meta.color,
    files,
    manifestVersion: computeDefinitionManifestVersion(files),
    createdAt: new Date().toISOString(), authorPublicKey: identity.publicKey,
  };
  const bundle = {
    ...unsigned,
    signature: await signRelationshipControl(definitionSigningValue(unsigned), identity.privateKey),
  };
  assertDefinitionOnlyBundle(bundle);
  return bundle;
}

export async function importDefinitionBundle(value: unknown): Promise<string> {
  const bundle = await verifyDefinitionBundle(value);
  const dappId = createDapp(bundle.name, bundle.icon, bundle.color);
  replaceCodeAppFiles(dappId, bundle.files);
  syncManifestEntities(dappId);
  syncManifestMeta(dappId);

  const doc = getDappDoc(dappId);
  // Declared collections get their (empty) container at seeding time (config.ts::seedDappSchema) —
  // a record is instance data, an empty container is not.
  const hasRecords = [...doc.getMap('data').values()].some((container) => containerRecords(container).length > 0);
  if (hasRecords || doc.getMap('appData').size !== 0 || doc.getMap('recordTombstones').size !== 0) {
    throw new Error('Imported Code App definition unexpectedly created instance data');
  }
  // Stored before it is reported as created: a reload right after must not lose the document.
  await persistNewDapp(dappId);
  return dappId;
}

/**
 * Replace only an existing dapp's Code App definition. Its records, app data,
 * members, credentials and file store stay in place; the new manifest merely
 * re-seeds the derived display metadata and schema. Owner-only by design.
 */
export async function replaceDefinitionBundle(dappId: string, value: unknown): Promise<void> {
  const bundle = await verifyDefinitionBundle(value);
  getDappDoc(dappId);
  getDappSourceDoc(dappId);
  await Promise.all([
    requireLocalCopyLoaded(getDappPersistence(dappId)),
    requireLocalCopyLoaded(getDappSourcePersistence(dappId)),
  ]);
  requireRole(dappId, 'owner');
  replaceCodeAppFiles(dappId, bundle.files);
  // `replaceCodeAppFiles` schedules a seal for ordinary editor saves. A source
  // replacement is an explicit import boundary, so do not report it complete
  // before the owner sealed exactly the reviewed definition.
  if (!await sealSourceNow(dappId, bundle.files)) throw new Error('The replacement source could not be owner-sealed.');
  // A definition bundle carries source, not repository provenance. Leaving the
  // old origin attached would offer future updates from a repository that no
  // longer describes the installed source.
  if (getGithubOrigin(dappId)) disconnectGithubOrigin(dappId);
  syncManifestEntities(dappId);
  syncManifestMeta(dappId);
}
