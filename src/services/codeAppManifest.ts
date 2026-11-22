import type {
  CodeAppBindingDeclaration,
  CodeAppBindingField,
  CodeAppBindingFieldType,
  CodeAppDisplay,
  CodeAppDbConfig,
  CodeAppDevicePermissions,
  CodeAppHostPermissions,
  CodeAppManifest,
  CodeAppManifestBindings,
  CodeAppManifestChannels,
  CodeAppManifestRoute,
  CodeAppManifestShare,
  CodeAppManifestShareRoute,
  CodeAppNetworkPermissions,
  CodeAppShareTarget,
  CodeAppShareTargetAccept,
  CodeAppPermissions,
  CodeAppRoleDeclaration,
  CodeAppStorageConfig,
  EntityDef,
  FieldDef,
  FieldType,
} from '@/types';
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { suggestFieldMap, validateFieldMap } from './bindingPayload.ts';

const MAX_ROUTES = 32;
const MAX_LABEL_LENGTH = 48;
/** Max length of the manifest `name` — the dapp's display name everywhere. */
export const MAX_CODE_APP_NAME_LENGTH = 80;
const MAX_ICON_LENGTH = 16;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const MAX_NETWORK_ORIGINS = 32;
const MAX_CODE_APP_BINDINGS_PER_KIND = 32;
const MAX_BINDING_ID_LENGTH = 64;
const MAX_BINDING_LABEL_LENGTH = 64;
const MAX_BINDING_DESCRIPTION_LENGTH = 256;
const MAX_BINDING_PAYLOAD_FIELDS = 32;
const MAX_BINDING_FIELD_NAME_LENGTH = 48;
const MAX_ROLES = 16;
const MAX_SHARES = 16;
const MAX_SHARE_PARTICIPANTS = 32;
const STABLE_BINDING_ID = /^[a-z][a-z0-9._-]*$/;
const SAFE_ROUTE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;
const BINDING_FIELD_NAME = /^[a-z][a-zA-Z0-9_]*$/;
const CODE_APP_BINDING_FIELD_TYPES: readonly CodeAppBindingFieldType[] = [
  'string', 'number', 'boolean', 'string[]', 'number[]', 'boolean[]', 'json',
];
const RESERVED_ROLE_IDS = new Set(['owner', 'editor', 'viewer']);

export const LEGACY_CODE_APP_MANIFEST: CodeAppManifest = Object.freeze({
  routes: [Object.freeze({ path: '/', label: 'Code App', icon: 'code' })],
});

/** Display identity a brand-new Code App starts with. */
const DEFAULT_CODE_APP_META = Object.freeze({ name: 'My Code App', icon: '🧩', color: '#f97316' });

export const DEFAULT_CODE_APP_MANIFEST: CodeAppManifest = Object.freeze({
  ...DEFAULT_CODE_APP_META,
  routes: [
    Object.freeze({ path: '/', label: 'Overview', icon: 'home' }),
    Object.freeze({ path: '/counter', label: 'Shared counter', icon: 'dashboard' }),
  ],
});

interface CodeAppManifestResult {
  manifest: CodeAppManifest;
  error: string | null;
}

/** Narrows a manifest node to a plain object, throwing `message` otherwise. */
function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(candidate: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknownKey = Object.keys(candidate).find((key) => !allowed.includes(key));
  if (unknownKey) throw new Error(`Unknown ${label} "${unknownKey}".`);
}

function parseStableId(value: unknown, prefix: string): string {
  if (typeof value !== 'string') throw new Error(`${prefix} requires an id.`);
  const id = value.trim();
  if (!id || id.length > MAX_BINDING_ID_LENGTH || !STABLE_BINDING_ID.test(id)) {
    throw new Error(`${prefix} id must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, or hyphens (max ${MAX_BINDING_ID_LENGTH}).`);
  }
  return id;
}

function parseRequiredLabel(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${prefix} requires a label.`);
  const label = value.trim();
  if (label.length > MAX_BINDING_LABEL_LENGTH) throw new Error(`${prefix} label is too long.`);
  return label;
}

/** Optional trimmed text field; '' when absent. */
function parseOptionalText(value: unknown, prefix: string, field: 'label' | 'description', maxLength: number): string {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${prefix} ${field} must be a string.`);
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > maxLength) throw new Error(`${prefix} ${field} is too long.`);
  return text;
}

export function normalizeCodeAppRoutePath(value: string): string {
  const trimmed = value.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const normalized = withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
  if (!SAFE_ROUTE_PATH.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Invalid path "${value}". Use paths such as / or /tasks.`);
  }
  return normalized;
}

function parseRoute(value: unknown, index: number): CodeAppManifestRoute {
  const candidate = asRecord(value, `Route ${index + 1} must be an object.`);
  if (typeof candidate.path !== 'string') throw new Error(`Route ${index + 1} requires a path.`);
  if (typeof candidate.label !== 'string' || !candidate.label.trim()) {
    throw new Error(`Route ${index + 1} requires a label.`);
  }
  const label = candidate.label.trim();
  if (label.length > MAX_LABEL_LENGTH) throw new Error(`Route ${index + 1} label is too long.`);
  if (candidate.icon !== undefined && typeof candidate.icon !== 'string') {
    throw new Error(`Route ${index + 1} icon must be a string.`);
  }
  if (candidate.hidden !== undefined && typeof candidate.hidden !== 'boolean') {
    throw new Error(`Route ${index + 1} hidden must be a boolean.`);
  }

  return {
    path: normalizeCodeAppRoutePath(candidate.path),
    label,
    ...(typeof candidate.icon === 'string' && candidate.icon.trim() ? { icon: candidate.icon.trim().toLowerCase() } : {}),
    ...(candidate.hidden === true ? { hidden: true } : {}),
  };
}

function parseExactHttpsOrigin(value: unknown, permission: string, index: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${permission} origin ${index + 1} must be a string.`);
  }

  const source = value.trim();
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${permission} origin ${index + 1} must be an exact HTTPS origin.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${permission} origin ${index + 1} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${permission} origin ${index + 1} must not contain credentials.`);
  if (url.pathname !== '/') throw new Error(`${permission} origin ${index + 1} must not contain a path.`);
  if (url.search) throw new Error(`${permission} origin ${index + 1} must not contain a query string.`);
  if (url.hash) throw new Error(`${permission} origin ${index + 1} must not contain a fragment.`);
  if (!url.hostname || url.hostname.includes('*')) {
    throw new Error(`${permission} origin ${index + 1} must be an exact HTTPS origin.`);
  }
  // URL parsing intentionally normalizes several syntactically non-origin
  // inputs. Reject those authored forms, not only the normalized URL fields.
  const exactOriginPattern = /^https:\/\/[^/?#\\]+\/?$/i;
  const authority = source.match(/^https:\/\/([^/?#\\]+)/i)?.[1] || '';
  if (!exactOriginPattern.test(source) || authority.includes('@') || authority.endsWith(':')) {
    throw new Error(`${permission} origin ${index + 1} must be an exact HTTPS origin.`);
  }
  return url.origin;
}

function parseOriginList(value: unknown, permission: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${permission} permissions must be an array.`);
  if (value.length > MAX_NETWORK_ORIGINS) {
    throw new Error(`${permission} permissions are limited to ${MAX_NETWORK_ORIGINS} origins.`);
  }
  const origins = value.map((origin, index) => parseExactHttpsOrigin(origin, permission, index));
  if (new Set(origins).size !== origins.length) throw new Error(`${permission} permissions contain a duplicate origin.`);
  return origins.length > 0 ? origins : undefined;
}

function parseNetworkPermissions(value: unknown): CodeAppNetworkPermissions | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest network permissions must be an object.');
  rejectUnknownKeys(candidate, ['connect', 'images'], 'network permission');
  const connect = parseOriginList(candidate.connect, 'Connect');
  const images = parseOriginList(candidate.images, 'Image');
  const network: CodeAppNetworkPermissions = {
    ...(connect ? { connect } : {}),
    ...(images ? { images } : {}),
  };
  return connect || images ? network : undefined;
}

const HOST_PERMISSION_KEYS = ['codeEditor', 'settings', 'contacts', 'sharing', 'files'] as const;
const DEVICE_PERMISSION_KEYS = ['camera'] as const;

const MAX_DB_INDEXES = 32;
const DB_COLLECTION_NAME = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const DB_FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/;

function parseDb(value: unknown): CodeAppDbConfig | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest db config must be an object.');
  rejectUnknownKeys(candidate, ['indexes'], 'manifest db key');
  if (!Array.isArray(candidate.indexes)) throw new Error('Manifest db.indexes must be an array.');
  if (candidate.indexes.length > MAX_DB_INDEXES) throw new Error(`db.indexes is limited to ${MAX_DB_INDEXES} entries.`);
  const seen = new Set<string>();
  const indexes = candidate.indexes.map((entry, index) => {
    const { collection, field, ...rest } = asRecord(entry, `db index ${index + 1} must be an object.`);
    const extra = Object.keys(rest)[0];
    if (extra) throw new Error(`db index ${index + 1} has an unknown key "${extra}".`);
    if (typeof collection !== 'string' || !DB_COLLECTION_NAME.test(collection)) {
      throw new Error(`db index ${index + 1} collection name is invalid.`);
    }
    if (typeof field !== 'string' || !DB_FIELD_NAME.test(field)) {
      throw new Error(`db index ${index + 1} field name is invalid.`);
    }
    const key = `${collection}.${field}`;
    if (seen.has(key)) throw new Error(`db index ${index + 1} duplicates "${key}".`);
    seen.add(key);
    return { collection, field };
  });
  return indexes.length > 0 ? { indexes } : undefined;
}

const MAX_MANIFEST_ENTITIES = 64;
const MAX_ENTITY_FIELDS = 256;
const MAX_ENTITY_TEXT_LENGTH = 128;
const ENTITY_FIELD_TYPES: readonly FieldType[] = [
  'text', 'number', 'boolean', 'date', 'datetime', 'select', 'relation', 'computed', 'script',
];

/**
 * Characters a collection / entity id may not contain. The auth observer
 * (`store/auth.ts`) and the `$db` read model (`store/readModel.ts`) key every
 * record as `${entityId}:${recordId}` and split on the FIRST `:` — an id with
 * a `:` in it would be read back as a different entity, so deletes get
 * reverted and `$db` indexes rows under the wrong collection. Rejected at
 * every boundary that names a collection (manifest parser, `$store` bridge).
 */
export const COLLECTION_ID_FORBIDDEN_CHARACTERS = [':'] as const;

/** Why `id` cannot be used as a collection / entity id, or null when it can. */
export function collectionIdProblem(id: string): string | null {
  const bad = COLLECTION_ID_FORBIDDEN_CHARACTERS.find((character) => id.includes(character));
  return bad ? `cannot contain "${bad}"` : null;
}

function parseEntityText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ENTITY_TEXT_LENGTH) {
    throw new Error(`Manifest ${label} must be a non-empty string of at most ${MAX_ENTITY_TEXT_LENGTH} characters.`);
  }
  return value;
}

/**
 * The manifest is the authoritative home of the entity schema (schema.json is
 * retired): edited in the Code App editor, versioned and signed with the other
 * source files, and re-seeded into the dapp doc's `config.schema` on install
 * and on manifest save.
 */
function parseEntities(value: unknown): EntityDef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error('Manifest entities must be a non-empty array.');
  if (value.length > MAX_MANIFEST_ENTITIES) throw new Error(`Manifest is limited to ${MAX_MANIFEST_ENTITIES} entities.`);
  const entityIds = new Set<string>();
  return value.map((rawEntity, entityIndex) => {
    const candidate = asRecord(rawEntity, `Entity ${entityIndex + 1} must be an object.`);
    const id = parseEntityText(candidate.id, `entity ${entityIndex + 1} id`);
    const idProblem = collectionIdProblem(id);
    if (idProblem) throw new Error(`Manifest entity ${entityIndex + 1} id "${id}" ${idProblem}.`);
    const name = parseEntityText(candidate.name, `entity ${entityIndex + 1} name`);
    if (entityIds.has(id)) throw new Error(`Manifest entities contain a duplicate id "${id}".`);
    entityIds.add(id);
    if (!Array.isArray(candidate.fields) || candidate.fields.length === 0) {
      throw new Error(`Entity "${id}" must declare a non-empty fields array.`);
    }
    if (candidate.fields.length > MAX_ENTITY_FIELDS) {
      throw new Error(`Entity "${id}" is limited to ${MAX_ENTITY_FIELDS} fields.`);
    }
    const fieldIds = new Set<string>();
    const fields = candidate.fields.map((rawField, fieldIndex) => {
      const fieldCandidate = asRecord(rawField, `Entity "${id}" field ${fieldIndex + 1} must be an object.`);
      const fieldId = parseEntityText(fieldCandidate.id, `entity "${id}" field ${fieldIndex + 1} id`);
      parseEntityText(fieldCandidate.name, `entity "${id}" field ${fieldIndex + 1} name`);
      if (!ENTITY_FIELD_TYPES.includes(fieldCandidate.type as FieldType)) {
        throw new Error(`Entity "${id}" field "${fieldId}" has an unsupported type.`);
      }
      if (fieldCandidate.required !== undefined && typeof fieldCandidate.required !== 'boolean') {
        throw new Error(`Entity "${id}" field "${fieldId}" required flag must be a boolean.`);
      }
      if (fieldIds.has(fieldId)) throw new Error(`Entity "${id}" contains a duplicate field id "${fieldId}".`);
      fieldIds.add(fieldId);
      // Beyond the validated core, FieldDef extras (options, relation targets,
      // defaults) pass through as authored — the schema is advisory metadata.
      return JSON.parse(JSON.stringify(fieldCandidate)) as FieldDef;
    });
    return {
      id,
      name,
      ...(typeof candidate.icon === 'string' ? { icon: candidate.icon.slice(0, 32) } : {}),
      ...(typeof candidate.color === 'string' ? { color: candidate.color.slice(0, 64) } : {}),
      fields,
    };
  });
}

/** Accepted for compatibility only: every new collection is compact regardless of this setting. */
function parseStorage(value: unknown): CodeAppStorageConfig | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest storage config must be an object.');
  rejectUnknownKeys(candidate, ['recordFormat'], 'manifest storage key');
  if (candidate.recordFormat !== 'fields' && candidate.recordFormat !== 'compact') {
    throw new Error('Manifest storage.recordFormat must be "fields" or "compact".');
  }
  return { recordFormat: candidate.recordFormat };
}

function parseHostPermissions(value: unknown): CodeAppHostPermissions | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest host permissions must be an object.');
  rejectUnknownKeys(candidate, HOST_PERMISSION_KEYS, 'host permission');
  const host: CodeAppHostPermissions = {};
  for (const key of HOST_PERMISSION_KEYS) {
    if (candidate[key] === undefined) continue;
    if (typeof candidate[key] !== 'boolean') throw new Error(`Host permission "${key}" must be a boolean.`);
    if (candidate[key] === true) host[key] = true;
  }
  return Object.keys(host).length > 0 ? host : undefined;
}

function parseDevicePermissions(value: unknown): CodeAppDevicePermissions | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest device permissions must be an object.');
  rejectUnknownKeys(candidate, DEVICE_PERMISSION_KEYS, 'device permission');
  const device: CodeAppDevicePermissions = {};
  for (const key of DEVICE_PERMISSION_KEYS) {
    if (candidate[key] === undefined) continue;
    if (typeof candidate[key] !== 'boolean') throw new Error(`Device permission "${key}" must be a boolean.`);
    if (candidate[key] === true) device[key] = true;
  }
  return Object.keys(device).length > 0 ? device : undefined;
}

function parsePermissions(value: unknown): CodeAppPermissions | undefined {
  if (value === undefined) return undefined;
  const permissions = asRecord(value, 'Manifest permissions must be an object.');
  rejectUnknownKeys(permissions, ['network', 'device', 'host'], 'manifest permission');
  const network = parseNetworkPermissions(permissions.network);
  const device = parseDevicePermissions(permissions.device);
  const host = parseHostPermissions(permissions.host);
  return network || device || host ? {
    ...(network ? { network } : {}),
    ...(device ? { device } : {}),
    ...(host ? { host } : {}),
  } : undefined;
}

function parseBindingFieldType(value: unknown, prefix: string): CodeAppBindingFieldType {
  if (typeof value !== 'string' || !CODE_APP_BINDING_FIELD_TYPES.includes(value as CodeAppBindingFieldType)) {
    throw new Error(`${prefix} type must be one of ${CODE_APP_BINDING_FIELD_TYPES.join(', ')}.`);
  }
  return value as CodeAppBindingFieldType;
}

function parseBindingField(value: unknown, kind: 'event' | 'action', bindingIndex: number, fieldIndex: number): CodeAppBindingField {
  const prefix = `${kind === 'event' ? 'Event' : 'Action'} ${bindingIndex + 1} payload field ${fieldIndex + 1}`;
  const candidate = asRecord(value, `${prefix} must be an object.`);
  rejectUnknownKeys(candidate, ['name', 'type', 'required', 'label', 'description'], `${prefix.toLowerCase()} key`);
  if (typeof candidate.name !== 'string') throw new Error(`${prefix} requires a name.`);
  const name = candidate.name.trim();
  if (!name || name.length > MAX_BINDING_FIELD_NAME_LENGTH || !BINDING_FIELD_NAME.test(name)) {
    throw new Error(`${prefix} name must start with a lowercase letter and contain only letters, numbers, or underscores (max ${MAX_BINDING_FIELD_NAME_LENGTH}).`);
  }
  const type = parseBindingFieldType(candidate.type, prefix);
  if (candidate.required !== undefined && typeof candidate.required !== 'boolean') throw new Error(`${prefix} required must be a boolean.`);
  const required = candidate.required === true;
  const label = parseOptionalText(candidate.label, prefix, 'label', MAX_BINDING_LABEL_LENGTH);
  const description = parseOptionalText(candidate.description, prefix, 'description', MAX_BINDING_DESCRIPTION_LENGTH);
  return {
    name,
    type,
    ...(required ? { required } : {}),
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
  };
}

function parseBindingPayload(value: unknown, kind: 'event' | 'action', bindingIndex: number): CodeAppBindingField[] | undefined {
  if (value === undefined) return undefined;
  const label = kind === 'event' ? 'Event' : 'Action';
  if (!Array.isArray(value)) throw new Error(`${label} ${bindingIndex + 1} payload must be an array.`);
  if (value.length > MAX_BINDING_PAYLOAD_FIELDS) throw new Error(`${label} ${bindingIndex + 1} payload is limited to ${MAX_BINDING_PAYLOAD_FIELDS} fields.`);
  const fields = value.map((item, fieldIndex) => parseBindingField(item, kind, bindingIndex, fieldIndex));
  if (new Set(fields.map(({ name }) => name)).size !== fields.length) {
    throw new Error(`${label} ${bindingIndex + 1} payload contains a duplicate field name.`);
  }
  return fields.length ? fields : undefined;
}

function parseBindingDeclaration(value: unknown, kind: 'event' | 'action', index: number): CodeAppBindingDeclaration {
  const prefix = `${kind === 'event' ? 'Event' : 'Action'} ${index + 1}`;
  const candidate = asRecord(value, `${prefix} must be an object.`);
  rejectUnknownKeys(candidate, ['id', 'label', 'description', 'payload'], `${kind} declaration key`);
  const id = parseStableId(candidate.id, prefix);
  const label = parseRequiredLabel(candidate.label, prefix);
  const description = parseOptionalText(candidate.description, prefix, 'description', MAX_BINDING_DESCRIPTION_LENGTH);
  const payload = parseBindingPayload(candidate.payload, kind, index);
  return { id, label, ...(description ? { description } : {}), ...(payload ? { payload } : {}) };
}

function parseBindingList(value: unknown, kind: 'event' | 'action'): CodeAppBindingDeclaration[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Manifest binding ${kind}s must be an array.`);
  if (value.length > MAX_CODE_APP_BINDINGS_PER_KIND) throw new Error(`Manifest binding ${kind}s are limited to ${MAX_CODE_APP_BINDINGS_PER_KIND}.`);
  const declarations = value.map((item, index) => parseBindingDeclaration(item, kind, index));
  if (new Set(declarations.map(({ id }) => id)).size !== declarations.length) throw new Error(`Manifest contains a duplicate binding ${kind} id.`);
  return declarations.length ? declarations : undefined;
}

function parseBindings(value: unknown): CodeAppManifestBindings | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest bindings must be an object.');
  rejectUnknownKeys(candidate, ['events', 'actions'], 'manifest bindings key');
  const events = parseBindingList(candidate.events, 'event');
  const actions = parseBindingList(candidate.actions, 'action');
  return events || actions ? { ...(events ? { events } : {}), ...(actions ? { actions } : {}) } : undefined;
}

function parseRoleDeclaration(value: unknown, index: number): CodeAppRoleDeclaration {
  const prefix = `Role ${index + 1}`;
  const candidate = asRecord(value, `${prefix} must be an object.`);
  rejectUnknownKeys(candidate, ['id', 'label', 'description', 'extends'], 'role key');
  const id = parseStableId(candidate.id, prefix);
  if (RESERVED_ROLE_IDS.has(id)) throw new Error(`${prefix} id "${id}" collides with a built-in framework role.`);
  const label = parseRequiredLabel(candidate.label, prefix);
  const description = parseOptionalText(candidate.description, prefix, 'description', MAX_BINDING_DESCRIPTION_LENGTH);
  if (candidate.extends !== 'owner' && candidate.extends !== 'editor' && candidate.extends !== 'viewer') {
    throw new Error(`${prefix} extends is required and must be one of owner, editor, viewer.`);
  }
  return { id, label, extends: candidate.extends, ...(description ? { description } : {}) };
}

function parseRoles(value: unknown): CodeAppRoleDeclaration[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Manifest roles must be an array.');
  if (value.length > MAX_ROLES) throw new Error(`Manifest is limited to ${MAX_ROLES} roles.`);
  const roles = value.map(parseRoleDeclaration);
  if (new Set(roles.map(({ id }) => id)).size !== roles.length) throw new Error('Manifest contains a duplicate role id.');
  return roles.length ? roles : undefined;
}

function parseDisplay(value: unknown): CodeAppDisplay | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest display must be an object.');
  rejectUnknownKeys(candidate, ['chrome', 'frameButton'], 'manifest display key');
  if (candidate.chrome !== undefined && candidate.chrome !== 'standard' && candidate.chrome !== 'fullscreen') {
    throw new Error('Manifest display.chrome must be "standard" or "fullscreen".');
  }
  if (candidate.frameButton !== undefined && typeof candidate.frameButton !== 'boolean') {
    throw new Error('Manifest display.frameButton must be true or false.');
  }
  const display: CodeAppDisplay = {
    ...(candidate.chrome !== undefined ? { chrome: candidate.chrome } : {}),
    ...(candidate.frameButton !== undefined ? { frameButton: candidate.frameButton } : {}),
  };
  return Object.keys(display).length ? display : undefined;
}

function parseShareIdList(value: unknown, key: 'events' | 'actions', shareIndex: number, declaredIds: Set<string>): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Share ${shareIndex + 1} requires at least one ${key.slice(0, -1)} id.`);
  const ids = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Share ${shareIndex + 1} ${key} entry ${index + 1} must be a non-empty string.`);
    return item.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error(`Share ${shareIndex + 1} contains a duplicate ${key.slice(0, -1)} id.`);
  const undeclared = ids.find((id) => !declaredIds.has(id));
  if (undeclared) throw new Error(`Share ${shareIndex + 1} references undeclared ${key.slice(0, -1)} "${undeclared}".`);
  return ids;
}

function parseShareRoute(
  value: unknown,
  shareIndex: number,
  routeIndex: number,
  events: Map<string, CodeAppBindingDeclaration>,
  actions: Map<string, CodeAppBindingDeclaration>,
): CodeAppManifestShareRoute {
  const prefix = `Share ${shareIndex + 1} route ${routeIndex + 1}`;
  const candidate = asRecord(value, `${prefix} must be an object.`);
  rejectUnknownKeys(candidate, ['eventId', 'actionId', 'fieldMap'], 'share route key');
  if (typeof candidate.eventId !== 'string' || !candidate.eventId.trim()) throw new Error(`${prefix} requires an eventId.`);
  if (typeof candidate.actionId !== 'string' || !candidate.actionId.trim()) throw new Error(`${prefix} requires an actionId.`);
  const eventId = candidate.eventId.trim();
  const actionId = candidate.actionId.trim();
  const event = events.get(eventId);
  const action = actions.get(actionId);
  if (!event) throw new Error(`${prefix} references undeclared event "${eventId}".`);
  if (!action) throw new Error(`${prefix} references undeclared action "${actionId}".`);
  let fieldMap: Record<string, string> | undefined;
  if (candidate.fieldMap !== undefined) {
    fieldMap = {};
    for (const [destination, source] of Object.entries(asRecord(candidate.fieldMap, `${prefix} fieldMap must be an object.`))) {
      if (typeof source !== 'string' || !source.trim()) throw new Error(`${prefix} fieldMap values must be non-empty strings.`);
      fieldMap[destination] = source.trim();
    }
  }
  const effectiveFieldMap = fieldMap ?? suggestFieldMap(event.payload, action.payload);
  const validation = validateFieldMap(event.payload, action.payload, effectiveFieldMap);
  if (!validation.ok) {
    throw new Error(`${prefix}${candidate.fieldMap === undefined ? ' requires a fieldMap' : ' fieldMap is invalid'}: ${validation.error}`);
  }
  const identityMap = Object.entries(effectiveFieldMap).every(([destination, source]) => destination === source);
  return {
    eventId,
    actionId,
    ...(!identityMap && Object.keys(effectiveFieldMap).length ? { fieldMap: effectiveFieldMap } : {}),
  };
}

function parseShare(
  value: unknown,
  index: number,
  declaredEvents: CodeAppBindingDeclaration[],
  declaredActions: CodeAppBindingDeclaration[],
): CodeAppManifestShare {
  const prefix = `Share ${index + 1}`;
  const candidate = asRecord(value, `${prefix} must be an object.`);
  rejectUnknownKeys(candidate, ['id', 'label', 'events', 'actions', 'routes', 'maxParticipants'], 'share key');
  const id = parseStableId(candidate.id, prefix);
  const label = parseRequiredLabel(candidate.label, prefix);
  const eventMap = new Map(declaredEvents.map((declaration) => [declaration.id, declaration]));
  const actionMap = new Map(declaredActions.map((declaration) => [declaration.id, declaration]));
  const events = parseShareIdList(candidate.events, 'events', index, new Set(eventMap.keys()));
  const actions = parseShareIdList(candidate.actions, 'actions', index, new Set(actionMap.keys()));
  if (!Array.isArray(candidate.routes) || candidate.routes.length === 0) throw new Error(`${prefix} requires at least one route.`);
  const routes = candidate.routes.map((route, routeIndex) => parseShareRoute(route, index, routeIndex, eventMap, actionMap));
  if (new Set(routes.map(({ eventId, actionId }) => `${eventId}\u0000${actionId}`)).size !== routes.length) {
    throw new Error(`${prefix} contains a duplicate route.`);
  }
  const unlistedRoute = routes.find((route) => !events.includes(route.eventId) || !actions.includes(route.actionId));
  if (unlistedRoute) throw new Error(`${prefix} routes must reference ids listed by that share.`);
  if (candidate.maxParticipants !== undefined) {
    if (typeof candidate.maxParticipants !== 'number' || !Number.isInteger(candidate.maxParticipants)
      || candidate.maxParticipants < 1 || candidate.maxParticipants > MAX_SHARE_PARTICIPANTS) {
      throw new Error(`${prefix} maxParticipants must be an integer between 1 and ${MAX_SHARE_PARTICIPANTS}.`);
    }
  }
  return {
    id, label, events, actions, routes,
    ...(candidate.maxParticipants !== undefined ? { maxParticipants: candidate.maxParticipants } : {}),
  };
}

const SHARE_TARGET_ACCEPTS: readonly CodeAppShareTargetAccept[] = ['text', 'url', 'files'];

/**
 * `shareTarget:` — opt-in to receiving OS-level Web Share Target shares.
 * Distinct from `channels.shares` (contact sharing): this only makes the dapp
 * selectable in the host's /share-target picker.
 */
function parseShareTarget(value: unknown): CodeAppShareTarget | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest shareTarget must be an object.');
  rejectUnknownKeys(candidate, ['accepts'], 'manifest shareTarget key');
  if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) {
    throw new Error('Manifest shareTarget.accepts must be a non-empty array.');
  }
  const accepts = candidate.accepts.map((item, index) => {
    if (typeof item !== 'string' || !SHARE_TARGET_ACCEPTS.includes(item as CodeAppShareTargetAccept)) {
      throw new Error(`shareTarget.accepts entry ${index + 1} must be one of ${SHARE_TARGET_ACCEPTS.join(', ')}.`);
    }
    return item as CodeAppShareTargetAccept;
  });
  if (new Set(accepts).size !== accepts.length) throw new Error('shareTarget.accepts contains a duplicate entry.');
  return { accepts };
}

function parseChannels(value: unknown, bindings: CodeAppManifestBindings | undefined): CodeAppManifestChannels | undefined {
  if (value === undefined) return undefined;
  const candidate = asRecord(value, 'Manifest channels must be an object.');
  rejectUnknownKeys(candidate, ['shares'], 'manifest channels key');
  if (candidate.shares === undefined) return undefined;
  if (!Array.isArray(candidate.shares)) throw new Error('Manifest channels.shares must be an array.');
  if (candidate.shares.length > MAX_SHARES) throw new Error(`Manifest is limited to ${MAX_SHARES} shares.`);
  const declaredEvents = bindings?.events ?? [];
  const declaredActions = bindings?.actions ?? [];
  const shares = candidate.shares.map((item, index) => parseShare(item, index, declaredEvents, declaredActions));
  if (new Set(shares.map(({ id }) => id)).size !== shares.length) throw new Error('Manifest contains a duplicate share id.');
  return shares.length ? { shares } : undefined;
}

export function parseCodeAppManifest(source: string): CodeAppManifestResult {
  if (!source.trim()) return { manifest: LEGACY_CODE_APP_MANIFEST, error: null };

  try {
    // YAML 1.2 core schema (the parser default): a strict superset of JSON, no
    // implicit yes/no/on/off booleans, alias expansion capped by the parser.
    const candidate = asRecord(parseYaml(source), 'Manifest must be a YAML mapping.');
    if (!Array.isArray(candidate.routes) || candidate.routes.length === 0) {
      throw new Error('Manifest requires at least one route.');
    }
    if (candidate.routes.length > MAX_ROUTES) throw new Error(`Manifest is limited to ${MAX_ROUTES} routes.`);
    if (candidate.name !== undefined && (typeof candidate.name !== 'string' || !candidate.name.trim())) {
      throw new Error('Manifest name must be a non-empty string.');
    }
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : undefined;
    if (name && name.length > MAX_CODE_APP_NAME_LENGTH) throw new Error('Manifest name is too long.');
    if (candidate.icon !== undefined && (typeof candidate.icon !== 'string' || !candidate.icon.trim())) {
      throw new Error('Manifest icon must be a non-empty string (an emoji).');
    }
    const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : undefined;
    if (icon && icon.length > MAX_ICON_LENGTH) throw new Error('Manifest icon is too long.');
    if (candidate.color !== undefined && (typeof candidate.color !== 'string' || !HEX_COLOR.test(candidate.color.trim()))) {
      throw new Error('Manifest color must be a hex color like #c2410c.');
    }
    const color = typeof candidate.color === 'string' ? candidate.color.trim().toLowerCase() : undefined;

    const routes = candidate.routes.map(parseRoute);
    const uniquePaths = new Set(routes.map((route) => route.path));
    if (uniquePaths.size !== routes.length) throw new Error('Manifest contains a duplicate route path.');
    const permissions = parsePermissions(candidate.permissions);
    const bindings = parseBindings(candidate.bindings);
    const roles = parseRoles(candidate.roles);
    const display = parseDisplay(candidate.display);
    const channels = parseChannels(candidate.channels, bindings);
    const db = parseDb(candidate.db);
    const entities = parseEntities(candidate.entities);
    const storage = parseStorage(candidate.storage);
    const shareTarget = parseShareTarget(candidate.shareTarget);

    return {
      manifest: {
        ...(name ? { name } : {}),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
        routes,
        ...(permissions ? { permissions } : {}),
        ...(bindings ? { bindings } : {}),
        ...(roles ? { roles } : {}),
        ...(display ? { display } : {}),
        ...(channels ? { channels } : {}),
        ...(db ? { db } : {}),
        ...(entities ? { entities } : {}),
        ...(storage ? { storage } : {}),
        ...(shareTarget ? { shareTarget } : {}),
      },
      error: null,
    };
  } catch (error) {
    const message = error instanceof YAMLParseError || error instanceof SyntaxError
      ? 'Manifest must contain valid YAML.'
      : error instanceof Error ? error.message : String(error);
    return { manifest: LEGACY_CODE_APP_MANIFEST, error: message };
  }
}

export function serializeCodeAppManifest(manifest: CodeAppManifest): string {
  return stringifyYaml(manifest, { indent: 2 });
}

/** One YAML scalar, quoted only when the value needs it (`:`, `#`, leading space…). */
function yamlScalar(value: string): string {
  return stringifyYaml(value).trimEnd();
}

/**
 * The manifest a brand-new Code App starts with. Hand-written rather than
 * serialized so it carries comments — comments are the reason the manifest is
 * YAML. Must stay in sync with DEFAULT_CODE_APP_MANIFEST; a test asserts the
 * default build parses to it. `name`/`icon`/`color` are the dapp's display
 * identity (catalog card, sidebar, settings) and this file is their one home.
 */
export function buildDefaultCodeAppManifestYaml(
  meta: { name: string; icon: string; color: string } = DEFAULT_CODE_APP_META,
): string {
  return `# Your app's manifest: identity, routes, permissions, schema, and sharing all live here.
# name, icon and color are what the catalog, sidebar and settings show for this app.
name: ${yamlScalar(meta.name)}
icon: ${yamlScalar(meta.icon)}
color: ${yamlScalar(meta.color)}

# Every view the app can navigate to ($router.navigate only accepts these).
routes:
  - path: /
    label: Overview
    icon: home
  - path: /counter
    label: Shared counter
    icon: dashboard

# More you can declare here:
#   permissions: { host: { files: true } }   # enable the $files P2P file store
#   permissions: { device: { camera: true } } # allow camera access in this app
#   entities:                                # schema for $store collections
#     - id: items
#       name: Items
#       fields:
#         - { id: title, name: Title, type: text, required: true }
#   bindings / channels:                     # events, actions, contact shares
#   shareTarget: { accepts: [text, url] }    # receive OS-level shares via the host picker
`;
}

const MAX_ROUTE_SEARCH_LENGTH = 2048;

/**
 * Split a `$router.navigate` target into its declared-route path and a
 * sanitized `?query` string. The path still has to pass
 * `normalizeCodeAppRoutePath` and the manifest route check; the search part is
 * round-tripped through URLSearchParams so only well-formed key/value pairs
 * survive (fragments are dropped).
 */
export function splitCodeAppNavigationTarget(raw: string): { path: string; search: string } {
  const withoutFragment = String(raw).split('#')[0];
  const queryIndex = withoutFragment.indexOf('?');
  if (queryIndex === -1) return { path: normalizeCodeAppRoutePath(withoutFragment), search: '' };
  const path = normalizeCodeAppRoutePath(withoutFragment.slice(0, queryIndex));
  const params = new URLSearchParams(withoutFragment.slice(queryIndex + 1)).toString();
  if (params.length > MAX_ROUTE_SEARCH_LENGTH) {
    throw new Error(`Navigation query string is limited to ${MAX_ROUTE_SEARCH_LENGTH} characters.`);
  }
  return { path, search: params ? `?${params}` : '' };
}

function hostRouteUrl(dappId: string, segment: 'app' | 'full', path: string): string {
  const normalized = normalizeCodeAppRoutePath(path);
  return `/dapp/${dappId}/${segment}${normalized === '/' ? '' : normalized}`;
}

export function codeAppRouteUrl(dappId: string, path: string): string {
  return hostRouteUrl(dappId, 'app', path);
}

export function codeAppFullscreenRouteUrl(dappId: string, path: string): string {
  return hostRouteUrl(dappId, 'full', path);
}
