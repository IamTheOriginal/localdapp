// ───── Field Types ─────
export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'relation'
  | 'computed'
  | 'script';

export interface SelectOption {
  label: string;
  value: string;
  color?: string;
}

export interface FieldDef {
  id: string;
  name: string;
  type: FieldType;
  required?: boolean;
  options?: SelectOption[];
  targetEntityId?: string; // used when type === 'relation'
  targetDisplayFieldId?: string; // used when type === 'relation' to specify which field to show
  defaultValue?: unknown;
  formula?: string; // used when type === 'computed'
  code?: string; // used when type === 'script'
}

export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface EntityDef {
  id: string;
  name: string;
  fields: FieldDef[];
  icon?: string;
  color?: string;
}

export interface SchemaDef {
  entities: EntityDef[];
}

export interface CodeAppManifestRoute {
  path: string;
  label: string;
  icon?: string;
  /** Presentation only — never access control. The route stays directly navigable by URL and by $router.navigate. */
  hidden?: boolean;
}

export type CodeAppChromeMode = 'standard' | 'fullscreen';

export interface CodeAppDisplay {
  chrome?: CodeAppChromeMode;
  /** `false` hides the host-rendered "Show app framework" corner button in fullscreen chrome. Defaults to visible. */
  frameButton?: boolean;
}

export interface CodeAppNetworkPermissions {
  connect?: string[];
  images?: string[];
}

/** Device capabilities exposed through the host bridge to sandboxed Code Apps. */
export interface CodeAppDevicePermissions {
  /** Grants $camera.start/frame/stop; capture runs in the host, frames stay device-local. */
  camera?: boolean;
}

/** Which host-owned UI surfaces (framework modals) a Code App may ask to open via $ui.*. */
export type CodeAppHostSurface = 'codeEditor' | 'settings';

export interface CodeAppHostPermissions {
  codeEditor?: boolean;
  settings?: boolean;
  /** Reserved for Phase 5 ($contacts). Parsed now for manifest forward-compatibility; not yet consumed by any runtime global. */
  contacts?: boolean;
  /** Reserved for Phase 5 ($ui.openSharing). Parsed now for manifest forward-compatibility; not yet consumed by any runtime global. */
  sharing?: boolean;
  /** Grants the $files bridge (dapp file index + local blob store access). */
  files?: boolean;
}

export interface CodeAppPermissions {
  network?: CodeAppNetworkPermissions;
  device?: CodeAppDevicePermissions;
  host?: CodeAppHostPermissions;
}

export type CodeAppBindingFieldType =
  | 'string' | 'number' | 'boolean'
  | 'string[]' | 'number[]' | 'boolean[]'
  | 'json';

export interface CodeAppBindingField {
  name: string;
  type: CodeAppBindingFieldType;
  required?: boolean;
  label?: string;
  description?: string;
}

export interface CodeAppBindingDeclaration {
  id: string;
  label: string;
  description?: string;
  payload?: CodeAppBindingField[];
}

export interface CodeAppManifestBindings {
  events?: CodeAppBindingDeclaration[];
  actions?: CodeAppBindingDeclaration[];
}

export interface CodeAppRoleDeclaration {
  id: string;
  label: string;
  description?: string;
  /** The framework role that caps this app role's actual write capability; the app role itself is a label, never a grant. */
  extends: MemberRole;
}

export interface CodeAppManifestShareRoute {
  eventId: string;
  actionId: string;
  /** Destination field name -> source field name. Omitted when payload shapes already match. */
  fieldMap?: Record<string, string>;
}

export interface CodeAppManifestShare {
  id: string;
  label: string;
  events: string[];
  actions: string[];
  routes: CodeAppManifestShareRoute[];
  maxParticipants?: number;
}

export interface CodeAppManifestChannels {
  shares?: CodeAppManifestShare[];
}

/** One `$db` read-model index declaration: a queryable field of a collection. */
export interface CodeAppDbIndex {
  collection: string;
  field: string;
}

export interface CodeAppDbConfig {
  indexes: CodeAppDbIndex[];
}

export type CodeAppShareTargetAccept = 'text' | 'url' | 'files';

/**
 * Opt-in to receiving OS-level Web Share Target shares. A dapp declaring
 * `shareTarget` appears in the host's /share-target picker when an incoming
 * share matches one of its accepted kinds; the share lands in the `$data`
 * inbox (see store/codeData.ts INCOMING_SHARES_KEY). `files` additionally
 * requires `permissions.host.files` — shared files are stored in the dapp's
 * file store and referenced from the inbox entry by file id.
 */
export interface CodeAppShareTarget {
  accepts: CodeAppShareTargetAccept[];
}

export interface CodeAppManifest {
  /**
   * Display identity of the dapp. The manifest is the one editable home for
   * these; the dapp doc's `config.meta` (and from there the catalog, sidebar
   * and settings header) is a derived copy re-synced on install and on every
   * manifest save.
   */
  name?: string;
  icon?: string;
  color?: string;
  routes: CodeAppManifestRoute[];
  permissions?: CodeAppPermissions;
  bindings?: CodeAppManifestBindings;
  roles?: CodeAppRoleDeclaration[];
  display?: CodeAppDisplay;
  channels?: CodeAppManifestChannels;
  db?: CodeAppDbConfig;
  /**
   * The dapp's entity schema. The manifest is the authoritative, editable home
   * for it (schema.json is retired); `config.schema` in the dapp doc is a
   * derived copy re-seeded on install and on manifest save. Advisory for
   * `$store` (schema-less app-owned collections stay allowed) but load-bearing
   * for sharing projections and settings UI.
   */
  entities?: EntityDef[];
  storage?: CodeAppStorageConfig;
  shareTarget?: CodeAppShareTarget;
}

/**
 * How the host stores this dapp's records inside the shared Yjs document.
 * 'fields' (default): one Y.Map per record with one CRDT entry per field.
 * 'compact': one immutable plain-JSON value per record in a Y.Map keyed by
 * record id — far less CRDT metadata for large collections, with whole-record
 * last-writer-wins on concurrent edits (which signed records effectively have
 * anyway, since any field change must re-sign the whole record). Applies to
 * collections created after the flag is set; existing collections keep the
 * representation they were born with.
 */
export interface CodeAppStorageConfig {
  recordFormat: 'fields' | 'compact';
}

export interface CodeAppDefinitionBundle {
  protocol: 'code-app-definition';
  schemaVersion: 1;
  name: string;
  icon: string;
  color: string;
  files: Record<string, string>;
  /** FNV-1a over the canonical source-file snapshot; integrity comes from signature. */
  manifestVersion: string;
  createdAt: string;
  authorPublicKey: string;
  signature: string;
}

/** A device-local, capability-based source transfer hosted in a disposable WebRTC room. */
export interface SourceShare {
  id: string;
  dappId: string;
  roomId: string;
  roomPassword: string;
  createdAt: string;
  expiresAt: string;
}

export interface DappMeta {
  name: string;
  icon: string;
  color: string;
  createdAt: string;
  createdBy: string;
}

export interface DappTheme {
  primary: string;
  radius?: string;
  customCss?: string;
}

export interface DappConfig {
  meta: DappMeta;
  schema: SchemaDef;
  theme?: DappTheme;
}

export interface InviteDef {
  id: string;
  lobbyId: string;
  lobbyPassword: string;
  maxUses?: number;
  uses?: number;
  usesLeft?: number;
  createdAt: string;
  name?: string;
  /** '1-step' invite: lobby devices are auto-approved by an online owner (stored as the string 'true'). */
  autoApprove?: string;
  /** Role granted on auto-approval ('editor' | 'viewer'). */
  autoRole?: string;
}

// ───── Blob store / file sync ─────

/** Content-addressed description of a stored blob; everything needed to fetch and verify it. */
export interface BlobDescriptor {
  /** SHA-256 (hex) of the complete content. */
  sha256: string;
  size: number;
  /** Chunk size in bytes used when the blob was chunked (256 KiB in v1). */
  chunkSize: number;
  /** SHA-256 (hex) per chunk, in order. */
  chunkHashes: string[];
}

/**
 * Signed file metadata record in the dapp doc's `files` map. Binary content
 * never enters Yjs — it lives in the local blob store and is transferred over
 * the blob exchange channel, addressed by `sha256`.
 */
export interface FileRecord extends BlobDescriptor {
  id: string;
  name: string;
  mime: string;
  /** Optional inline preview (data URL), ≤ 32 KB — the only inline binary allowed. */
  thumbnail?: string;
  createdAt: string;
  createdBy: string;
  _signedBy?: string;
  _signature?: string;
}

export interface DappListItem {
  id: string;
  name: string;
  icon: string;
  color: string;
  roomId: string;
  roomPassword: string;
  lobbyId?: string;
  lobbyPassword?: string;
  joinMethod?: 'direct' | 'lobby' | 'owner' | 'template';
  role: MemberRole;
  sortOrder: number;
  createdAt: string;
  /** Set when the user left this dapp — the entry is a disconnected read-only archive. */
  archivedAt?: string;
  /** Home-screen folder this dapp sits in (device-local layout, see store/homeLayout.ts). */
  folderId?: string;
}

/** A home-screen folder (root doc map `dappFolders`). Shares the top-level `sortOrder` space with dapps. */
export interface DappFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

/** One top-level entry of the Home grid: a dapp, or a folder with its (two or more) dapps in order. */
export type HomeNode =
  | { kind: 'dapp'; dapp: DappListItem }
  | { kind: 'folder'; folder: DappFolder; dapps: DappListItem[] };

export interface DeviceIdentity {
  displayName: string;
  publicKey: string;
  /** Legacy plaintext Ed25519 key (pkcs8 hex). Absent once migrated to non-extractable IndexedDB keys. */
  privateKey?: string;
  encPublicKey?: string;
  /** Legacy plaintext RSA-OAEP key (JWK). Absent once migrated to non-extractable IndexedDB keys. */
  encPrivateKey?: string;
  deviceId: string;
}

export interface Person {
  id: string;
  schemaVersion: 1;
  displayName: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipIdentity {
  id: string;
  schemaVersion: 1;
  publicKey: string;
  privateKey: string;
  encPublicKey: string;
  encPrivateKey: string;
  createdAt: string;
}

export type RelationshipStatus = 'pending' | 'active' | 'blocked' | 'revoked';

export interface Relationship {
  id: string;
  schemaVersion: 1;
  personId: string;
  status: RelationshipStatus;
  localIdentity: RelationshipIdentity;
  peerPublicKey?: string;
  peerEncPublicKey?: string;
  pairContextId?: string;
  controlCapabilityId?: string;
  pairingTranscriptHash?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipInvite {
  protocol: 'relationship-pairing-invite';
  schemaVersion: 1;
  inviteId: string;
  pairContextId: string;
  lobbyRoomId: string;
  lobbyRoomPassword: string;
  publicKey: string;
  encPublicKey: string;
  /** Inviter's self-asserted name (signed, length-capped; NOT identity proof — the safety number is). */
  displayName: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface PairingRequest {
  protocol: 'relationship-pairing-request';
  schemaVersion: 1;
  requestId: string;
  inviteId: string;
  pairContextId: string;
  inviterPublicKey: string;
  requesterPublicKey: string;
  requesterEncPublicKey: string;
  /** Requester's self-asserted name (signed, length-capped; NOT identity proof — the safety number is). */
  displayName: string;
  createdAt: string;
  nonce: string;
  signature: string;
}

export interface HybridEncryptedEnvelope {
  schemaVersion: 1;
  keyAlgorithm: 'RSA-OAEP-256';
  contentAlgorithm: 'A256GCM';
  wrappedKey: string;
  iv: string;
  ciphertext: string;
  aadHash: string;
}

export interface RelationshipControlCapability {
  protocol: 'relationship-control-capability';
  schemaVersion: 1;
  capabilityId: string;
  pairContextId: string;
  roomId: string;
  roomPassword: string;
  createdAt: string;
}

export interface PairingResponse {
  protocol: 'relationship-pairing-response';
  schemaVersion: 1;
  responseId: string;
  inviteId: string;
  pairContextId: string;
  requestId: string;
  requestHash: string;
  inviterPublicKey: string;
  inviterEncPublicKey: string;
  requesterPublicKey: string;
  encryptedControlCapability: HybridEncryptedEnvelope;
  createdAt: string;
  signature: string;
}

export interface ChannelDescriptor {
  id: string;
  schemaVersion: 1;
  relationshipId: string;
  dappId: string;
  sensitiveShareId?: string;
  roomId: string;
  roomPassword: string;
  persistenceKey: string;
  /** Control-room message carrying this channel's encrypted room credential. */
  controlOfferMessageId?: string;
  /** Ed25519 public keys admitted to publish into this isolated channel. */
  memberDeviceKeys: string[];
  status: 'prepared' | 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

/** Signed routing envelope stored in a stable relationship control room. */
export interface RelationshipChannelControlMessage {
  protocol: 'relationship-channel-control';
  schemaVersion: 1;
  messageId: string;
  /** Signed opaque correlation tag used to route concurrent control responses before decryption. */
  correlationId?: string;
  kind: 'channel-purge-request' | 'channel-purge-ack' | 'channel-share-offer' | 'channel-share-ack' | 'channel-share-decline';
  pairContextId: string;
  senderPublicKey: string;
  recipientPublicKey: string;
  sequence: number;
  previousMessageHash: string | null;
  encryptedPayload: HybridEncryptedEnvelope;
  createdAt: string;
  signature: string;
}

/** Encrypted request to erase one isolated relationship channel on the pinned peer. */
export interface RelationshipChannelPurgeRequestPayload {
  protocol: 'relationship-channel-purge-request';
  schemaVersion: 1;
  requestId: string;
  channelId: string;
  reason: 'grant-revoked' | 'dapp-deleted';
  requestedAt: string;
}

/** Signed peer claim that the requested local channel data and capability were removed. */
export interface RelationshipChannelPurgeAckPayload {
  protocol: 'relationship-channel-purge-ack';
  schemaVersion: 1;
  requestId: string;
  channelId: string;
  requestMessageHash: string;
  purgedAt: string;
}

/**
 * An app-initiated ($share.open) channel offer. Unlike RelationshipChannelOfferPayload, this
 * deliberately DOES carry dapp/share context — the recipient must see what they're accepting
 * before any capability installs, so a channel-share-offer never auto-installs on receipt; it
 * stages a PendingShareInvite instead (see src/services/store/pendingShareInvites.ts).
 */
export interface RelationshipChannelShareOfferPayload {
  protocol: 'relationship-channel-share-offer';
  schemaVersion: 1;
  offerId: string;
  /** The SENDER's own local dapp id — a per-device random value, never resolvable on the recipient's device. Informational only; the recipient always picks their own local dapp to attach the accepted share to. */
  dappId: string;
  shareId: string;
  shareLabel: string;
  instanceId: string;
  dappMeta: { name: string; icon: string; color: string };
  events: CodeAppBindingDeclaration[];
  actions: CodeAppBindingDeclaration[];
  routes: CodeAppManifestShareRoute[];
  /** Optional owner-signed, source-only app definition. It is inert until the recipient explicitly installs it. */
  definition?: CodeAppDefinitionBundle;
  channel: {
    id: string;
    schemaVersion: 1;
    roomId: string;
    roomPassword: string;
    memberDeviceKeys: string[];
    createdAt: string;
  };
}

export interface RelationshipChannelShareAckPayload {
  protocol: 'relationship-channel-share-ack';
  schemaVersion: 1;
  offerId: string;
  channelId: string;
  offerMessageHash: string;
  acceptedAt: string;
}

/** Sent instead of an ack when the recipient declines a PendingShareInvite. */
export interface RelationshipChannelShareDeclinePayload {
  protocol: 'relationship-channel-share-decline';
  schemaVersion: 1;
  offerId: string;
  offerMessageHash: string;
  declinedAt: string;
}

/** Stable per-(dapp, relationship) handle a Code App receives for a contact — never the relationshipId, personId, or any key. */
export interface DappContactHandle {
  handle: string;
  displayName: string;
  verified: boolean;
}

/** One channel-share instance — one row per participant (relationship), all sharing the same instanceId. */
export interface ChannelShare {
  id: string;
  schemaVersion: 1;
  dappId: string;
  shareId: string;
  instanceId: string;
  relationshipId: string;
  channelId: string;
  eventIds: string[];
  actionIds: string[];
  /** Sender-side correlation for a not-yet-accepted signed offer. */
  offerId?: string;
  controlOfferMessageId?: string;
  status: 'pending' | 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

/** Staged, not-yet-installed incoming channel-share offer awaiting the user's accept/decline. */
export interface PendingShareInvite {
  id: string;
  schemaVersion: 1;
  relationshipId: string;
  /** Sender's local dapp id, carried through verbatim from the offer — display only. Accepting always attaches the share to a local dapp the recipient explicitly picks, never this value. */
  dappId: string;
  shareId: string;
  shareLabel: string;
  instanceId: string;
  offerId: string;
  dappMeta: { name: string; icon: string; color: string };
  events: CodeAppBindingDeclaration[];
  actions: CodeAppBindingDeclaration[];
  routes: CodeAppManifestShareRoute[];
  /** Verified signed definition captured from the original offer; still inert until explicit acceptance. */
  definition?: CodeAppDefinitionBundle;
  /**
   * Captured for inbox display only. Acceptance and decline re-open the original encrypted,
   * signed offer and use that re-derived payload as the security source of truth. The replay
   * chain is not consumed again during this inspection.
   */
  channel: { id: string; schemaVersion: 1; roomId: string; roomPassword: string; memberDeviceKeys: string[]; createdAt: string };
  offerMessageId: string;
  offerMessageHash: string;
  receivedAt: string;
  status: 'pending' | 'accepted' | 'declined';
}

export interface RemotePurgeIntent {
  schemaVersion: 1;
  intentId: string;
  relationshipId: string;
  channelId: string;
  controlOfferMessageId?: string;
  reason: RelationshipChannelPurgeRequestPayload['reason'];
  status: 'unprepared';
  attempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface PendingRemotePurge {
  schemaVersion: 1;
  requestId: string;
  relationshipId: string;
  channelId: string;
  controlOfferMessageId?: string;
  reason: RelationshipChannelPurgeRequestPayload['reason'];
  requestMessage: RelationshipChannelControlMessage;
  requestMessageHash: string;
  status: 'pending' | 'acknowledged';
  attempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  acknowledgedAt?: string;
}

export type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson };

// ───── Automation engine (twin runtime) ─────

/** One scheduled rule the keeper executes on its own. Event triggers wait for a headless Code App host. */
export interface AutomationRule {
  schemaVersion: 1;
  id: string;
  name: string;
  enabled: boolean;
  trigger: { kind: 'cron'; schedule: string };
  steps: AutomationStep[];
  createdAt: string;
  updatedAt: string;
  /** Bookkeeping only — set by the runner, never user-edited. */
  lastRunAt?: string;
  lastError?: string;
}

export type AutomationStep =
  | { kind: 'create-record'; dappId: string; collection: string; data: CanonicalJson }
  | { kind: 'update-record'; dappId: string; collection: string; recordIdTemplate: string; data: CanonicalJson };

/** Values a step template can reference: `{{trigger.<path>}}`, `{{now.iso}}`, `{{now.date}}`, `{{now.time}}`. */
export interface AutomationContext {
  trigger: { kind: 'cron'; firedAt: string };
}

export interface AutomationRunReport {
  ruleId: string;
  ok: boolean;
  results: Array<{ stepIndex: number; ok: boolean; error?: string }>;
}

export interface UnsignedStreamEvent {
  protocol: 'relationship-stream';
  schemaVersion: 1;
  eventId: string;
  relationshipId: string;
  channelId: string;
  streamId: string;
  sequence: number;
  previousEventHash: string | null;
  kind: 'snapshot' | 'update' | 'tombstone' | 'device-admission' | 'device-revocation' | 'action';
  signerPublicKey: string;
  createdAt: string;
  payload: CanonicalJson;
}

export interface StreamEvent extends UnsignedStreamEvent {
  signature: string;
}


export type RecordData = Record<string, unknown> & { id: string };
