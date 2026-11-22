// Manual QA helper for the headless runtime (docs/HEADLESS.md): simulates an
// owner browser device in Node — creates a dapp with one record, optionally
// grants a keeper's public key the editor role, writes the room credentials
// to <dataDir>/creds.json, and logs the record count it sees every 2s
// (flagging HEADLESS_WRITE_SEEN once a keeper-authored record arrives).
//
// Usage (from the repo root, Node >= 23.6):
//   node scripts/headless-owner-sim.mjs <dataDir> <signalingUrl> [headlessPublicKey]
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [dataDir, signaling, headlessPubKey] = process.argv.slice(2);
if (!dataDir || !signaling) {
  console.error('usage: node scripts/headless-owner-sim.mjs <dataDir> <signalingUrl> [headlessPublicKey]');
  process.exit(1);
}

const { initHeadlessEnvironment } = await import('../src/headless/env.ts');
await initHeadlessEnvironment({ signalingUrls: [signaling] });

const { loadOrCreateHeadlessIdentity } = await import('../src/headless/identityFile.ts');
await loadOrCreateHeadlessIdentity(dataDir, 'Owner Sim');

const { createDapp } = await import('../src/services/store/config.ts');
const { addRecord, getEntityRecords } = await import('../src/services/store/data.ts');
const { getDappCredentials, getDappDoc } = await import('../src/services/store/docs.ts');
const { writeSignedMember } = await import('../src/services/store/protocolCore.ts');
const { getSigningIdentity } = await import('../src/services/identity.ts');

const dappId = createDapp('Smoke Dapp', '🧪', '#123456');
await addRecord(dappId, 'items', { id: 'rec-owner-1', title: 'hello from owner' });

if (headlessPubKey) {
  await writeSignedMember(getDappDoc(dappId), {
    publicKey: headlessPubKey,
    name: 'Keeper',
    role: 'editor',
  }, await getSigningIdentity());
  console.log('owner: keeper granted editor role');
}

const creds = getDappCredentials(dappId);
await fs.writeFile(path.join(dataDir, 'creds.json'), JSON.stringify({ dappId, ...creds }));
console.log('owner: dapp ready', dappId, creds.roomId);

setInterval(() => {
  const records = getEntityRecords(dappId, 'items') ?? [];
  const fromKeeper = records.find((record) => record.createdBy === headlessPubKey);
  console.log(`owner: sees ${records.length} record(s)${fromKeeper ? ' HEADLESS_WRITE_SEEN' : ''}`);
}, 2000);
