import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Two peers of the same dapp that learn of the same two facts — "owner B added member X" and
 * "owner A removed B" — in opposite orders (review item 1.6).
 *
 * Before, each peer judged a signature by whether the signer was an owner *in its own current
 * view*: the peer that had not received B's removal yet kept X, every other peer deleted it,
 * the first restored it, and the two fought over the entry a few times a second for as long as
 * the dapp was open. What both sides must reach instead is the SAME verdict, whatever order
 * the two facts arrived in.
 *
 * The two "peers" are two dapp ids with their own documents; updates are relayed by hand, so
 * the test controls exactly what each side knows at each point.
 */

const docs = new Map<string, Y.Doc>();
const selfPublicKey = 'aa'.repeat(32);

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
  ...await importOriginal<typeof import('../services/identity.ts')>(),
  getIdentity: () => ({ displayName: 'Self', publicKey: selfPublicKey, privateKey: '', deviceId: 'self' }),
}));

const { setupAuthObserver, teardownAuthObserver, whenAuthObserversIdle } = await import('../services/store/auth.ts');
const { getDappDoc } = await import('../services/store/docs.ts');
const { stableStringify, yMapFromObject } = await import('../services/store/protocolCore.ts');
const { clearMemberBaseline } = await import('../services/store/memberBaseline.ts');

async function createSigner() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const sign = async (record: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { _signature, _signedBy, ...data } = record;
    void _signature; void _signedBy;
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(stableStringify(data)));
    return { ...data, _signedBy: publicKey, _signature: bufferToHex(signature) };
  };
  return { publicKey, sign };
}

type Signer = Awaited<ReturnType<typeof createSigner>>;

const PEERS = ['peer-p', 'peer-q'] as const;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 18, 10, minute)).toISOString();

/** What `protocolCore.writeSignedMemberRemoval` does: tombstone and deletion in ONE transaction. */
function removeMember(dappId: string, publicKey: string, tombstone: Record<string, unknown>): void {
  const doc = getDappDoc(dappId);
  doc.transact(() => {
    doc.getMap('memberTombstones').set(publicKey, yMapFromObject(tombstone));
    doc.getMap('members').delete(publicKey);
  });
}

function membersOf(dappId: string): string[] {
  return [...getDappDoc(dappId).getMap('members').keys()].sort();
}

/** Both peers exchange everything they know, then both scans run to completion. */
async function syncAndSettle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const [p, q] = PEERS.map((dappId) => getDappDoc(dappId));
    Y.applyUpdate(q, Y.encodeStateAsUpdate(p, Y.encodeStateVector(q)));
    Y.applyUpdate(p, Y.encodeStateAsUpdate(q, Y.encodeStateVector(p)));
    await whenAuthObserversIdle();
  }
}

/** How often each peer changed its members map — a war shows up as a count that keeps climbing. */
function countMemberWrites(): { stop: () => number[] } {
  const counts = PEERS.map(() => 0);
  const handlers = PEERS.map((dappId, index) => {
    const handler = () => { counts[index] += 1; };
    getDappDoc(dappId).getMap('members').observeDeep(handler);
    return handler;
  });
  return {
    stop: () => {
      PEERS.forEach((dappId, index) => { getDappDoc(dappId).getMap('members').unobserveDeep(handlers[index]); });
      return counts;
    },
  };
}

async function seedDapp(dappId: string, founder: Signer, ownerB: Signer): Promise<void> {
  const doc = getDappDoc(dappId);
  const members = doc.getMap('members');
  doc.transact(() => {
    members.set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, role: 'owner', name: 'Founder', memberUpdatedAt: at(0) }));
    const meta = new Y.Map<unknown>();
    meta.set('createdBy', founder.publicKey);
    doc.getMap('config').set('meta', meta);
  });
  // B is an owner because the founder signed it in.
  members.set(ownerB.publicKey, yMapFromObject(await founder.sign({ publicKey: ownerB.publicKey, role: 'owner', name: 'Owner B', memberUpdatedAt: at(1) })));
}

let founder: Signer;
let ownerB: Signer;
let newcomer: Signer;

beforeEach(async () => {
  PEERS.forEach((dappId) => {
    teardownAuthObserver(dappId);
    // Each case builds a brand-new dapp (new founder, new owners) under the same two ids, so
    // the baseline the previous case verified for those ids has to go with its document —
    // in production that is what purging a dapp from the device does.
    clearMemberBaseline(dappId);
  });
  docs.clear();
  founder = await createSigner();
  ownerB = await createSigner();
  newcomer = await createSigner();
  // Seeded ONCE and copied: both peers hold the same Yjs items, as two devices of one dapp do.
  // Seeding each peer by itself made the first merge a conflict between two unrelated writes
  // of every key, and which one won — and how many rounds settling took — hung on random client ids.
  await seedDapp(PEERS[0], founder, ownerB);
  Y.applyUpdate(getDappDoc(PEERS[1]), Y.encodeStateAsUpdate(getDappDoc(PEERS[0])));
  for (const dappId of PEERS) setupAuthObserver(dappId, { scanDebounceMs: 5 });
  await whenAuthObserversIdle();
});

describe('two peers that learn of a removal and an addition in opposite orders', () => {
  it('keeps a member the removed owner added BEFORE it was removed — on both peers, without fighting over it', async () => {
    // P sees only the addition, Q sees only the removal.
    getDappDoc('peer-p').getMap('members').set(newcomer.publicKey, yMapFromObject(
      await ownerB.sign({ publicKey: newcomer.publicKey, role: 'editor', name: 'Newcomer', memberUpdatedAt: at(2) }),
    ));
    const tombstone = await founder.sign({
      publicKey: ownerB.publicKey, removed: true, removedAt: at(3), formerRole: 'owner',
    });
    removeMember('peer-q', ownerB.publicKey, tombstone);
    await whenAuthObserversIdle();

    const writes = countMemberWrites();
    await syncAndSettle();
    const duringConvergence = writes.stop();

    // Same verdict on both: B is gone, the member it added while it was an owner stays.
    for (const dappId of PEERS) {
      expect(membersOf(dappId)).toEqual([founder.publicKey, newcomer.publicKey].sort());
    }
    // And it is settled — no peer keeps writing.
    const idle = countMemberWrites();
    await syncAndSettle();
    expect(idle.stop()).toEqual([0, 0]);
    expect(duringConvergence.every((count) => count < 10)).toBe(true);
  }, 30_000);

  it('drops a member the removed owner minted AFTER its removal — including on the peer that had accepted it', async () => {
    // P accepts the entry because it has not seen the removal yet…
    getDappDoc('peer-p').getMap('members').set(newcomer.publicKey, yMapFromObject(
      await ownerB.sign({ publicKey: newcomer.publicKey, role: 'editor', name: 'Minted', memberUpdatedAt: at(9) }),
    ));
    await whenAuthObserversIdle();
    expect(membersOf('peer-p')).toContain(newcomer.publicKey);

    // …while Q only learns that B was removed at 10:03.
    removeMember('peer-q', ownerB.publicKey, await founder.sign({
      publicKey: ownerB.publicKey, removed: true, removedAt: at(3), formerRole: 'owner',
    }));
    await whenAuthObserversIdle();

    await syncAndSettle();

    // Both peers end up without the minted member — P changes its mind when the tombstone arrives.
    for (const dappId of PEERS) {
      expect(membersOf(dappId)).toEqual([founder.publicKey]);
    }
    const idle = countMemberWrites();
    await syncAndSettle();
    expect(idle.stop()).toEqual([0, 0]);
  }, 30_000);

  it('accepts a whole chain that arrives in one batch, whatever order the entries sit in', async () => {
    // The founder makes C an owner and C adds D — both in the same update.
    const ownerC = await createSigner();
    const memberD = await createSigner();
    const doc = getDappDoc('peer-p');
    const cEntry = await founder.sign({ publicKey: ownerC.publicKey, role: 'owner', name: 'Owner C', memberUpdatedAt: at(4) });
    const dEntry = await ownerC.sign({ publicKey: memberD.publicKey, role: 'editor', name: 'Member D', memberUpdatedAt: at(5) });
    doc.transact(() => {
      // D first: in map order the dependency is the wrong way round.
      doc.getMap('members').set(memberD.publicKey, yMapFromObject(dEntry));
      doc.getMap('members').set(ownerC.publicKey, yMapFromObject(cEntry));
    });
    await whenAuthObserversIdle();

    expect(membersOf('peer-p')).toEqual([founder.publicKey, ownerB.publicKey, ownerC.publicKey, memberD.publicKey].sort());
    await syncAndSettle();
    for (const dappId of PEERS) {
      expect(membersOf(dappId)).toEqual([founder.publicKey, ownerB.publicKey, ownerC.publicKey, memberD.publicKey].sort());
    }
  }, 30_000);
});
