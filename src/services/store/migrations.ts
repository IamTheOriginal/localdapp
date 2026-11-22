import * as Y from 'yjs';

/**
 * Dapp document versioning + migration hook.
 *
 * Every peer runs migrations independently against the shared CRDT — there is
 * no coordinator. A migration therefore MUST be:
 *  - **idempotent**: running it twice (or on an already-migrated doc) is a no-op;
 *  - **convergent**: two peers running it concurrently must produce state that
 *    merges to the same result (prefer "set missing key to constant" shapes,
 *    avoid read-modify-write of values other peers mutate);
 *  - **backward tolerant**: peers still on the previous app version keep
 *    writing pre-migration shapes until they upgrade — readers must accept both.
 *
 * `docVersion` lives in the dapp doc's `config` map. Docs created before
 * versioning have no field and count as version 0 — structurally identical to
 * version 1 (the version introduction). A doc with a HIGHER version than this
 * build understands is left untouched (never write to state shaped by a newer
 * app).
 */

export const CURRENT_DAPP_DOC_VERSION = 1;

interface DappDocMigration {
  /** The version this migration upgrades the doc TO (from `toVersion - 1`). */
  toVersion: number;
  migrate(doc: Y.Doc): void;
}

/** Ordered registry. Version 0 → 1 introduced the field itself; no structural change. */
export const DAPP_DOC_MIGRATIONS: DappDocMigration[] = [];

export function getDappDocVersion(doc: Y.Doc): number {
  const version = doc.getMap('config').get('docVersion');
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 0;
}


/**
 * Bring a dapp doc up to CURRENT_DAPP_DOC_VERSION. Returns the number of
 * migrations applied (0 when already current), or -1 when the doc is from a
 * newer app and was deliberately left untouched.
 */
export function runDappDocMigrations(doc: Y.Doc): number {
  const version = getDappDocVersion(doc);
  if (version > CURRENT_DAPP_DOC_VERSION) {
    console.warn(
      `migrations: dapp doc is version ${version} but this app understands ${CURRENT_DAPP_DOC_VERSION} — update the app; leaving the doc untouched`,
    );
    return -1;
  }
  if (version === CURRENT_DAPP_DOC_VERSION) return 0;

  const pending = DAPP_DOC_MIGRATIONS
    .filter((migration) => migration.toVersion > version && migration.toVersion <= CURRENT_DAPP_DOC_VERSION)
    .sort((a, b) => a.toVersion - b.toVersion);

  doc.transact(() => {
    for (const migration of pending) migration.migrate(doc);
    doc.getMap('config').set('docVersion', CURRENT_DAPP_DOC_VERSION);
  });
  return pending.length;
}
