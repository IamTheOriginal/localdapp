import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

/**
 * Review item 5.9: an owner creates the (empty, compact) container of every
 * declared entity when the schema is seeded, so members never race each other
 * creating it with their first record.
 */

const docs = new Map<string, Y.Doc>();
const self = 'owner-key';

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    let doc = docs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(dappId, doc);
    }
    return doc;
  },
}));
vi.mock('../services/identity.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/identity.ts')>()),
  getIdentity: () => ({ displayName: 'Owner', publicKey: self, deviceId: 'owner-device' }),
}));

const { seedDappSchema } = await import('../services/store/config.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

const schema = {
  entities: [
    { id: 'tasks', name: 'Tasks', fields: [{ id: 'title', name: 'Title', type: 'text' }] },
    { id: 'notes', name: 'Notes', fields: [{ id: 'body', name: 'Body', type: 'text' }] },
  ],
} as unknown as Parameters<typeof seedDappSchema>[1];

function dapp(role: string | null, withMeta = true): { id: string; doc: Y.Doc } {
  const id = `declared-${crypto.randomUUID()}`;
  const doc = getDappDoc(id);
  const config = doc.getMap('config');
  const schemaMap = new Y.Map<unknown>();
  schemaMap.set('entities', new Y.Map());
  config.set('schema', schemaMap);
  if (withMeta) {
    const meta = new Y.Map<unknown>();
    meta.set('name', 'Declared');
    config.set('meta', meta);
  }
  if (role) {
    const member = new Y.Map<unknown>();
    member.set('publicKey', self);
    member.set('role', role);
    doc.getMap('members').set(self, member);
  }
  return { id, doc };
}

describe('seedDappSchema record containers', () => {
  it('creates a compact container per declared entity on an owner device, once', () => {
    const { id, doc } = dapp('owner');
    const existing = new Y.Map<Record<string, unknown>>();
    existing.set('n1', { id: 'n1' });
    doc.getMap('data').set('notes', existing);

    seedDappSchema(id, schema);
    const tasks = doc.getMap('data').get('tasks');
    expect(tasks).toBeInstanceOf(Y.Map);
    expect((tasks as Y.Map<unknown>).size).toBe(0);
    // An existing container (and its records) is never replaced.
    expect(doc.getMap('data').get('notes')).toBe(existing);

    seedDappSchema(id, schema); // a manifest save re-seeds
    expect(doc.getMap('data').get('tasks')).toBe(tasks);
  });

  it('leaves containers alone on non-owner devices and on documents without content yet', () => {
    const editor = dapp('editor');
    seedDappSchema(editor.id, schema);
    expect(editor.doc.getMap('data').size).toBe(0);

    const unloaded = dapp('owner', false);
    seedDappSchema(unloaded.id, schema);
    expect(unloaded.doc.getMap('data').size).toBe(0);
  });
});
