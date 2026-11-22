import * as Y from 'yjs';
import { getDappsList, generateRoomPassword, initDappDoc, getDappDoc, purgeDappLocalResources } from './docs.ts';
import { getCodeAppFile, initializeCodeAppSource } from './source.ts';
import { buildDefaultCodeAppManifestYaml, parseCodeAppManifest } from '../codeAppManifest.ts';
import { getFounder, getRole, requireRole } from './auth.ts';
import type { DappConfig, EntityDef, FieldDef, SchemaDef } from '../../types.ts';
import { getIdentity } from '../identity.ts';
import { nextTopLevelSortOrder } from './homeLayout.ts';

// ───── High-Level Dapp Operations ─────

/**
 * Replaces a dapp's entity schema from a plain SchemaDef — the one seeding path
 * shared by starter installs and signed definition-bundle imports.
 *
 * An owner device also creates the (empty, compact) record container of every
 * declared entity that has none yet. Containers are last-writer-wins values of
 * the `data` map: when two members wrote the first record of a collection
 * concurrently, each created one and one of them lost (review item 5.9 — the
 * loser's records are put back by recordContainerMerge.ts, but only when their
 * author's device is around to do it). Created once, here, the container every
 * member writes into already exists. Only on a document that has content (its
 * `config.meta` — written at creation, or loaded/synced): an empty container
 * written into a document whose stored state has not arrived yet would compete
 * with the real one.
 */
export function seedDappSchema(dappId: string, schema: SchemaDef, doc: Y.Doc = getDappDoc(dappId)): void {
  const self = getIdentity()?.publicKey;
  const createContainers = doc.getMap('config').get('meta') instanceof Y.Map
    && self !== undefined && getRole(dappId, self) === 'owner';
  doc.transact(() => {
    const config = doc.getMap('config');
    const schemaMap = config.get('schema') as Y.Map<unknown>;
    const entitiesMap = schemaMap.get('entities') as Y.Map<Y.Map<unknown>>;
    entitiesMap.clear();
    for (const entity of schema.entities) {
      const entityMap = new Y.Map<unknown>();
      entityMap.set('id', entity.id);
      entityMap.set('name', entity.name);
      if (entity.icon) entityMap.set('icon', entity.icon);
      if (entity.color) entityMap.set('color', entity.color);
      const fields = new Y.Array<Y.Map<unknown>>();
      fields.push(entity.fields.map((entry) => {
        const fieldMap = new Y.Map<unknown>();
        for (const [key, value] of Object.entries(entry)) {
          fieldMap.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
        }
        return fieldMap;
      }));
      entityMap.set('fields', fields);
      entitiesMap.set(entity.id, entityMap);
    }
    if (createContainers) {
      const data = doc.getMap('data');
      for (const entity of schema.entities) {
        if (!data.has(entity.id)) data.set(entity.id, new Y.Map<Record<string, unknown>>());
      }
    }
  }, 'seed-dapp-schema');
}

/**
 * Re-seeds `config.schema` from the manifest's `entities` section — the
 * authoritative schema source. Called after installs and manifest saves.
 * Returns false (and leaves the current schema untouched) when the manifest is
 * absent, unparsable, or declares no entities.
 */
export function syncManifestEntities(dappId: string): boolean {
  const result = parseCodeAppManifest(getCodeAppFile(dappId, 'manifest.yaml'));
  if (result.error || !result.manifest.entities || result.manifest.entities.length === 0) return false;
  seedDappSchema(dappId, { entities: result.manifest.entities });
  return true;
}

/**
 * Copies the manifest's display identity (`name`, `icon`, `color`) into the
 * dapp doc's `config.meta` and this device's catalog entry. The manifest is
 * the one editable home for these — there is no separate rename/icon UI.
 * Called after installs and manifest saves; other members receive the meta
 * through the shared dapp doc and their catalog follows via the meta observer
 * in docs.ts. Returns false (touching nothing) when the manifest is absent,
 * unparsable, or declares none of the three.
 */
export function syncManifestMeta(dappId: string): boolean {
  const result = parseCodeAppManifest(getCodeAppFile(dappId, 'manifest.yaml'));
  if (result.error) return false;
  const { name, icon, color } = result.manifest;
  if (!name && !icon && !color) return false;
  const doc = getDappDoc(dappId);
  doc.transact(() => {
    const meta = doc.getMap('config').get('meta');
    if (meta instanceof Y.Map) {
      if (name) meta.set('name', name);
      if (icon) meta.set('icon', icon);
      if (color) meta.set('color', color);
    }
  }, 'sync-manifest-meta');
  const item = getCatalogItem(dappId);
  if (item) {
    if (name) item.set('name', name);
    if (icon) item.set('icon', icon);
    if (color) item.set('color', color);
  }
  return true;
}

/** Adds an entry to the root dapps catalog at the end of the Home layout (after every top-level dapp and folder). */
function addCatalogEntry(fields: Record<string, string>): Y.Map<string> {
  const list = getDappsList();
  const dappInfo = new Y.Map<string>();
  Object.entries(fields).forEach(([key, value]) => dappInfo.set(key, value));
  dappInfo.set('sortOrder', nextTopLevelSortOrder(list.doc ?? undefined)); // the doc that owns the catalog
  list.push([dappInfo]);
  return dappInfo;
}

export function createDapp(name: string, icon: string, color: string): string {
  const id = crypto.randomUUID();
  const roomId = `dapp-${crypto.randomUUID()}`;
  const roomPassword = generateRoomPassword();

  const identity = getIdentity();
  if (!identity) throw new Error("Identity not initialized");

  // Update root catalog
  addCatalogEntry({
    id,
    name,
    icon,
    color,
    createdAt: new Date().toISOString(),
    roomId,
    roomPassword,
  });

  try {
    // Initialize the specific dapp doc and its Code App source document. Every dapp is a Code App.
    initDappDoc(id, name, icon, color, identity.publicKey, identity.encPublicKey, identity.displayName);
    // The manifest is the editable home of name/icon/color — seed it with the
    // identity chosen at creation so the two never start out disagreeing.
    initializeCodeAppSource(id, undefined, buildDefaultCodeAppManifestYaml({ name, icon, color }));
  } catch (error) {
    removeDappCatalogEntry(id);
    void purgeDappLocalResources(id).catch((cleanupError: unknown) => {
      console.error('Failed to clean up incomplete dapp creation:', cleanupError);
    });
    throw error;
  }

  return id;
}

export function joinDapp(inviteUri: string): string {
  try {
    // The one app-join format: dapp://invite/app/<lobbyId>/<lobbyPassword>.
    const url = new URL(inviteUri);
    if (url.protocol !== 'dapp:' || url.host !== 'invite') throw new Error("Unrecognized invite format");
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'app') throw new Error("Unrecognized invite format");

    const [, lobbyId, lobbyPassword] = parts;
    const id = crypto.randomUUID();

    addCatalogEntry({
      id,
      name: "Syncing...",
      icon: "🔄",
      color: "#888888",
      lobbyId,
      lobbyPassword,
      joinMethod: 'lobby',
    });
    getDappDoc(id); // Triggers lobby connection
    return id;
  } catch (error) {
    console.error("Failed to join Dapp:", error);
    throw new Error("Invalid invite string", { cause: error });
  }
}

/**
 * Direct add with already-known room credentials — the agent/tooling path
 * (headless keeper API). Deliberately NOT reachable from any invite URI: the
 * lobby handshake is what gets a device owner-signed into the members map, so
 * a credentials-only add can read but its writes are reverted by every honest
 * peer until an owner signs it in.
 */
export function addDappByCredentials(roomId: string, roomPassword: string): string {
  const id = crypto.randomUUID();
  addCatalogEntry({
    id,
    name: "Syncing...",
    icon: "🔄",
    color: "#888888",
    roomId,
    roomPassword,
    joinMethod: 'direct',
  });
  getDappDoc(id);
  return id;
}

export function removeDappCatalogEntry(id: string): boolean {
  const list = getDappsList();
  for (let i = 0; i < list.length; i++) {
    if (list.get(i).get('id') === id) {
      list.delete(i, 1);
      return true;
    }
  }
  return false;
}

function getCatalogItem(dappId: string): Y.Map<string> | null {
  const list = getDappsList();
  for (let i = 0; i < list.length; i++) {
    if (list.get(i).get('id') === dappId) return list.get(i);
  }
  return null;
}

export function getDappConfig(dappId: string): DappConfig | null {
  const doc = getDappDoc(dappId);
  const config = doc.getMap('config');
  
  if (!config.get('meta') || !config.get('schema')) {
    return null;
  }

  const metaMap = config.get('meta') as Y.Map<string>;
  const schemaMap = config.get('schema') as Y.Map<unknown>;

  // Parse Entities
  const entitiesMap = schemaMap.get('entities') as Y.Map<unknown>;
  const entities: EntityDef[] = [];
  entitiesMap.forEach((eMapRaw: unknown) => {
    const eMap = eMapRaw as Y.Map<unknown>;
    const fieldsArr = eMap.get('fields') as Y.Array<Y.Map<unknown>>;
    const fields = fieldsArr.map(fMap => {
      const field: Record<string, unknown> = {};
      fMap.forEach((val, key) => {
        try {
          field[key] = typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))
            ? JSON.parse(val)
            : val;
        } catch {
          field[key] = val;
        }
      });
      // Field maps carry exactly the FieldDef keys the visual editor wrote.
      return field as unknown as FieldDef;
    });

    entities.push({
      id: eMap.get('id') as string,
      name: eMap.get('name') as string,
      icon: eMap.get('icon') as string | undefined,
      color: eMap.get('color') as string | undefined,
      fields,
    });
  });

  return {
    meta: {
      name: metaMap.get('name') ?? '',
      icon: metaMap.get('icon') ?? '',
      color: metaMap.get('color') ?? '',
      createdAt: metaMap.get('createdAt') ?? '',
      // The founder this device pinned (auth.ts) — the raw field is writable by every member.
      createdBy: getFounder(dappId, doc) ?? ''
    },
    schema: { entities },
    theme: getTheme(config)
  };
}

function getTheme(config: Y.Map<unknown>): { primary: string; radius: string } | undefined {
  const themeMap = config.get('theme') as Y.Map<string> | undefined;
  if (!themeMap) return undefined;
  return {
    primary: themeMap.get('primary') || '#f97316',
    radius: themeMap.get('radius') || '0.5rem',
  };
}

const THEME_VALUE_PATTERNS: Record<string, RegExp> = {
  primary: /^#[0-9a-f]{6}$/i,
  radius: /^\d{1,2}(\.\d{1,4})?rem$/,
};

/**
 * Every connected device applies these values as CSS variables, so only
 * complete, well-formed values are written — a half-typed colour used to break
 * the primary colour everywhere at once.
 */
export function updateDappTheme(dappId: string, updates: Record<string, string>): void {
  requireRole(dappId, 'owner');
  for (const [key, value] of Object.entries(updates)) {
    const pattern = THEME_VALUE_PATTERNS[key];
    if (!pattern || typeof value !== 'string' || !pattern.test(value)) {
      throw new Error(`theme: "${String(value)}" is not a valid value for ${key}`);
    }
  }
  const doc = getDappDoc(dappId);
  const config = doc.getMap('config');
  let theme = config.get('theme') as Y.Map<string> | undefined;
  if (!theme) {
    theme = new Y.Map<string>();
    config.set('theme', theme);
  }
  Object.entries(updates).forEach(([key, value]) => {
    theme.set(key, value);
  });
}
