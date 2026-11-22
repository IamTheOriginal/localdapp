import * as Y from 'yjs';
import { getDappDoc } from './docs.ts';
import { getFounder } from './auth.ts';
import { getIdentity, getSigningIdentity } from '../identity.ts';
import { signWithIdentity, verifySignature } from './protocolCore.ts';
import { readDeviceLocal, removeDeviceLocal, writeDeviceLocal } from './deviceStore.ts';

/**
 * Dapp genesis — the one id every member of a dapp shares (2026-09-23).
 *
 * A dapp's id is device-local: every join picks a fresh UUID for its catalog entry. So
 * nothing a seal could name was the same on two devices, and the source seal ended up bound
 * to no dapp at all: a member of two dapps that share an owner could copy one dapp's sealed
 * source into the other. The genesis is that missing shared id:
 *
 *   - written ONCE, by the founder, into the dapp doc (`config.genesis`) and signed by it;
 *     only the pinned founder's signature counts (`getFounder`), so a member cannot write one;
 *   - every device PINS the id it verified first (device-local, `deviceStore.ts`): the founder
 *     signs the genesis of every dapp it founded, so a genesis copied over from another dapp
 *     of the same founder verifies too — the pin is what makes it "another app";
 *   - the founder's device keeps its signed record and puts it back when it is deleted or
 *     replaced.
 *
 * Dapps whose founder is gone never get one; their seals stay unbound, as before.
 */

const GENESIS_KEY = 'genesis';
const PIN_PREFIX = 'vibedapp:dapp-genesis:';
const RECORD_PREFIX = 'vibedapp:dapp-genesis-record:';

interface StoredGenesis {
  v: 1;
  id: string;
  createdAt: string;
  _signedBy: string;
  _signature: string;
}

function configOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('config');
}

function parseGenesis(raw: unknown): StoredGenesis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<StoredGenesis>;
  if (value.v !== 1 || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64) return null;
  if (typeof value.createdAt !== 'string' || typeof value._signedBy !== 'string' || typeof value._signature !== 'string') return null;
  return value as StoredGenesis;
}

/** The genesis in the doc, if the pinned founder signed it. */
async function verifiedDocGenesis(dappId: string, doc: Y.Doc): Promise<StoredGenesis | null> {
  const genesis = parseGenesis(configOf(doc).get(GENESIS_KEY));
  const founder = getFounder(dappId, doc);
  if (!genesis || !founder || genesis._signedBy !== founder) return null;
  const ok = await verifySignature(genesis as unknown as Record<string, unknown>, founder).catch(() => false);
  return ok ? genesis : null;
}

/**
 * The dapp's genesis id on this device: the pinned one, or — on first sight — the founder-signed
 * one in the doc, which is pinned from then on. `null` while the dapp has none.
 */
export async function readGenesisId(dappId: string, doc: Y.Doc = getDappDoc(dappId)): Promise<string | null> {
  const pinned = readDeviceLocal(PIN_PREFIX + dappId);
  if (pinned) return pinned;
  const genesis = await verifiedDocGenesis(dappId, doc);
  if (!genesis) return null;
  if (readDeviceLocal(PIN_PREFIX + dappId)) return readDeviceLocal(PIN_PREFIX + dappId); // pinned meanwhile
  writeDeviceLocal(PIN_PREFIX + dappId, genesis.id); // no storage: the pin lasts for this session
  return genesis.id;
}

/**
 * Founder devices only: make sure the doc carries this dapp's genesis — create it once, and put
 * the signed record back when somebody deleted or replaced it. A no-op on every other device.
 */
export async function ensureGenesis(dappId: string, doc: Y.Doc = getDappDoc(dappId)): Promise<void> {
  const identity = getIdentity();
  if (!identity || getFounder(dappId, doc) !== identity.publicKey) return;
  const config = configOf(doc);
  const stored = parseGenesis(safeJson(readDeviceLocal(RECORD_PREFIX + dappId)));
  const current = parseGenesis(config.get(GENESIS_KEY));
  if (stored) {
    if (current?._signature !== stored._signature) config.set(GENESIS_KEY, { ...stored });
    if (!readDeviceLocal(PIN_PREFIX + dappId)) writeDeviceLocal(PIN_PREFIX + dappId, stored.id);
    return;
  }
  // No record on this device: adopt a genesis this founder key signed earlier (another copy of
  // the keeper's data, an older build), else create the one and only.
  const pinned = readDeviceLocal(PIN_PREFIX + dappId);
  const existing = await verifiedDocGenesis(dappId, doc);
  if (existing && (!pinned || pinned === existing.id)) {
    writeDeviceLocal(RECORD_PREFIX + dappId, JSON.stringify(existing));
    writeDeviceLocal(PIN_PREFIX + dappId, existing.id);
    return;
  }
  if (pinned) return; // pinned an id whose record is gone: never mint a second one
  const payload = { v: 1 as const, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const genesis: StoredGenesis = { ...payload, ...(await signWithIdentity(await getSigningIdentity(), payload)) };
  if (parseGenesis(safeJson(readDeviceLocal(RECORD_PREFIX + dappId)))) return; // a parallel call won
  writeDeviceLocal(RECORD_PREFIX + dappId, JSON.stringify(genesis));
  writeDeviceLocal(PIN_PREFIX + dappId, genesis.id);
  config.set(GENESIS_KEY, { ...genesis });
}

/** Call `listener` whenever the doc's genesis entry changes. */
export function onGenesisChange(dappId: string, listener: () => void, doc: Y.Doc = getDappDoc(dappId)): () => void {
  const config = configOf(doc);
  const observer = (event: Y.YMapEvent<unknown>) => {
    if (event.keysChanged.has(GENESIS_KEY)) listener();
  };
  config.observe(observer);
  return () => config.unobserve(observer);
}

/** The dapp left this device: a rejoin starts from first sight. */
export function clearGenesisMemory(dappId: string): void {
  removeDeviceLocal(PIN_PREFIX + dappId);
  removeDeviceLocal(RECORD_PREFIX + dappId);
}

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
