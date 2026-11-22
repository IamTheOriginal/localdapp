import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

const docs = new Map<string, Y.Doc>();

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    let doc = docs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(dappId, doc);
    }
    return doc;
  },
  getDappSourceDoc: vi.fn(() => new Y.Doc()),
}));

let currentSigner: { publicKey: string; privateHex: string };

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({
      displayName: 'Owner',
      publicKey: currentSigner.publicKey,
      deviceId: 'device',
    }),
    getSigningIdentity: () => Promise.resolve({
      publicKey: currentSigner.publicKey,
      privateKey: currentSigner.privateHex,
    }),
  };
});

const { setupAuthObserver } = await import('../services/store/auth.ts');
const { addRecord, deleteRecord } = await import('../services/store/data.ts');
const { ReadModel, sanitizeQueryOptions, sanitizeCollectionName } = await import('../services/store/readModel.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function createSigner() {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
    privateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
}

function addMember(doc: Y.Doc, publicKey: string, role: string) {
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', role);
  doc.getMap('members').set(publicKey, member);
}

async function waitFor(assertion: () => Promise<void> | void, timeout = 3000): Promise<void> {
  await vi.waitFor(assertion, { timeout, interval: 25 });
}

let dappId: string;

beforeEach(async () => {
  docs.clear();
  currentSigner = await createSigner();
  dappId = `rm-${crypto.randomUUID()}`;
  addMember(getDappDoc(dappId), currentSigner.publicKey, 'owner');
  setupAuthObserver(dappId, { scanDebounceMs: 0 });
});

const RECIPE_INDEXES = [
  { collection: 'recipes', field: 'category' },
  { collection: 'recipes', field: 'calories' },
];

describe('$db input sanitizing', () => {
  it('whitelists query options and rejects bad collection names', () => {
    expect(sanitizeQueryOptions({
      index: 'calories', range: { lte: 400, junk: 9 }, direction: 'desc', limit: 10,
      match: [{ field: 'title', op: 'contains', value: 'soup' }, { field: 'x', op: 'evil', value: 're' }, 'garbage'],
      __proto__: { hacked: true }, extra: () => {},
    })).toEqual({
      index: 'calories', range: { lte: 400 }, direction: 'desc', limit: 10,
      match: [{ field: 'title', op: 'contains', value: 'soup' }],
    });
    expect(sanitizeQueryOptions('nope')).toEqual({});
    expect(sanitizeCollectionName(' recipes ')).toBe('recipes');
    expect(() => sanitizeCollectionName('')).toThrow();
    expect(() => sanitizeCollectionName(42)).toThrow();
  });
});

describe('read model index', () => {
  it('projects verified records, never forged ones, and follows deletions', async () => {
    const model = new ReadModel(dappId, RECIPE_INDEXES);
    const doc = getDappDoc(dappId);

    await addRecord(dappId, 'recipes', { id: 'good-1', title: 'Soup', category: 'Suppen', calories: 200 });
    // Forged record injected directly into the (compact) collection.
    (doc.getMap('data').get('recipes') as Y.Map<Record<string, unknown>>).set('forged-1', {
      id: 'forged-1', title: 'Fake', category: 'Suppen', _signedBy: currentSigner.publicKey, _signature: 'ff'.repeat(64),
    });

    await waitFor(() => {
      expect(model.get('recipes', 'good-1')).not.toBeNull();
    });
    // Forged record must never surface, before or after the revert lands.
    expect(model.get('recipes', 'forged-1')).toBeNull();
    await waitFor(() => {
      const { rows } = model.query('recipes', {});
      expect(rows.map((row) => row.id)).toEqual(['good-1']);
    });

    await deleteRecord(dappId, 'recipes', 'good-1');
    await waitFor(() => {
      expect(model.get('recipes', 'good-1')).toBeNull();
    });
    model.close();
  });

  it('supports indexed ranges, sorting, pagination with duplicate keys, and match filters', async () => {
    const model = new ReadModel(dappId, RECIPE_INDEXES);
    for (let index = 0; index < 12; index++) {
      await addRecord(dappId, 'recipes', {
        id: `r-${String(index).padStart(2, '0')}`,
        title: index % 2 === 0 ? `Tomaten ${index}` : `Kartoffel ${index}`,
        category: index < 6 ? 'Suppen' : 'Salate',
        calories: 100 + (index % 3) * 100, // duplicate index keys on purpose
      });
    }
    await waitFor(() => {
      expect(model.count('recipes')).toBe(12);
    });

    const soups = model.query('recipes', { index: 'category', range: { eq: 'Suppen' } });
    expect(soups.rows).toHaveLength(6);
    expect(soups.rows.every((row) => row.category === 'Suppen')).toBe(true);

    const light = model.query('recipes', { index: 'calories', range: { lte: 200 } });
    expect(light.rows.every((row) => Number(row.calories) <= 200)).toBe(true);

    // Paginate through duplicate calorie keys, both directions, no dupes/gaps.
    for (const direction of ['asc', 'desc'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = model.query('recipes', { index: 'calories', direction, limit: 5, ...(cursor ? { cursor } : {}) });
        seen.push(...page.rows.map((row) => String(row.id)));
        if (!page.cursor) break;
        cursor = page.cursor;
      }
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    }

    const search = model.query('recipes', { match: [{ field: 'title', op: 'contains', value: 'tomaten' }] });
    expect(search.rows).toHaveLength(6);

    expect(model.count('recipes', { index: 'category', range: { eq: 'Salate' } })).toBe(6);
    expect(() => model.query('recipes', { index: 'undeclared' })).toThrow(/not declared/);

    // Rows without a sortable value for the index are absent from that index, as in IndexedDB.
    await addRecord(dappId, 'recipes', { id: 'r-nocal', title: 'Ohne', category: 'Salate' });
    await waitFor(() => {
      expect(model.count('recipes')).toBe(13);
    });
    expect(model.count('recipes', { index: 'calories' })).toBe(12);
    const numbersFirst = model.query('recipes', { index: 'calories', range: { gt: 250 }, limit: 200 });
    expect(numbersFirst.rows.every((row) => Number(row.calories) > 250)).toBe(true);
    model.close();
  });

  it('serves the verified snapshot immediately when created after the first scan', async () => {
    await addRecord(dappId, 'recipes', { id: 'early', title: 'Früh', category: 'Suppen' });
    const probe = new ReadModel(dappId, RECIPE_INDEXES);
    await waitFor(() => {
      expect(probe.count('recipes')).toBe(1);
    });
    probe.close();

    const late = new ReadModel(dappId, RECIPE_INDEXES);
    expect(late.get('recipes', 'early')).not.toBeNull();
    expect(late.count('recipes', { index: 'category', range: { eq: 'Suppen' } })).toBe(1);
    late.close();
    // A closed model no longer follows the feed.
    await addRecord(dappId, 'recipes', { id: 'after-close', title: 'Spät', category: 'Suppen' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(late.get('recipes', 'after-close')).toBeNull();
  });
});
