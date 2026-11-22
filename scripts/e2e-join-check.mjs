#!/usr/bin/env node
/**
 * End-to-end join check over REAL WebRTC: two headless Chrome profiles, an owner that creates a
 * dapp and a single-use invite, and a joiner. Verifies the joiner-side confirmation step
 * (services/store/pendingGrant.ts): same code on both screens, no credentials before the person
 * confirmed, the held approval survives a reload, the dapp syncs afterwards.
 *
 * Not part of `npm test` (needs Chrome and free ports). Run by hand:
 *   1. node server/signaling.mjs   and   npx vite --port 5199 --strictPort
 *   2. start two Chromes:  chrome --headless=new --remote-debugging-port=9444 --ignore-certificate-errors
 *                          --lang=en-US --user-data-dir=<tmp>/a about:blank      (and 9445 / <tmp>/b)
 *   3. node scripts/e2e-join-check.mjs <directory for screenshots>
 */
import { writeFileSync } from 'node:fs';

const BASE = 'https://localhost:5199';
const OUT = process.argv[2];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attach(port, label) {
  const targets = await (await fetch(`http://localhost:${port}/json`)).json();
  const ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => { ws.onopen = resolve; });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result ?? message.error); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(`${label}: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result?.value;
  };
  const waitFor = async (expression, what, timeout = 45000) => {
    const started = Date.now();
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() - started > timeout) throw new Error(`${label}: timed out waiting for ${what}`);
      await sleep(300);
    }
  };
  const shot = async (name) => writeFileSync(`${OUT}/${name}`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  const onboard = async (name) => {
    await send('Page.navigate', { url: BASE });
    await waitFor(`document.querySelector('input') !== null || document.querySelector('nav') !== null`, 'app');
    if (await evaluate(`document.querySelector('nav') === null`)) {
      await evaluate(`(() => { const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await evaluate(`[...document.querySelectorAll('button')].find((button) => !button.disabled && /start|create|continue/i.test(button.textContent))?.click()`);
      await waitFor(`document.querySelector('nav') !== null`, 'shell');
    }
    await sleep(1000);
  };
  return { send, evaluate, waitFor, shot, onboard, errors, close: () => ws.close() };
}

const owner = await attach(9444, 'owner');
const joiner = await attach(9445, 'joiner');
await owner.onboard('Owner Laptop');
await joiner.onboard('Joiner Phone');

const dappId = await owner.evaluate(`(async () => {
  const starters = await import('/src/services/store/starters.ts');
  const catalog = await starters.fetchStarterCatalog();
  const definition = await starters.fetchStarterDefinition(catalog.find((item) => item.id === 'todo-list'));
  return starters.createStarterDapp(definition);
})()`);
await sleep(2500);
const inviteUri = await owner.evaluate(`(async () => { const invites = await import('/src/services/store/invites.ts'); return invites.createInvite(${JSON.stringify(dappId)}, 1); })()`);
const result = { invite: String(inviteUri).slice(0, 24) + '…' };
await owner.evaluate(`history.pushState({}, '', '/requests'); window.dispatchEvent(new PopStateEvent('popstate'))`);

const joinedId = await joiner.evaluate(`(async () => { const config = await import('/src/services/store/config.ts'); return config.joinDapp(${JSON.stringify(inviteUri)}); })()`);
await joiner.evaluate(`history.pushState({}, '', '/dapp/${joinedId}'); window.dispatchEvent(new PopStateEvent('popstate'))`);

// Joiner waits with a code; owner sees the request with the same code and approves.
await joiner.waitFor(`/\\d{4} \\d{4}/.test(document.body.innerText)`, 'a connection code on the waiting screen', 60000);
result.joinerWaitingCode = await joiner.evaluate(`document.body.innerText.match(/\\d{4} \\d{4}/)[0]`);
await owner.waitFor(`[...document.querySelectorAll('button')].some((button) => /^\\s*Approve/.test(button.textContent))`, 'the Approve button', 60000);
result.ownerRequestCode = await owner.evaluate(`document.body.innerText.match(/\\d{4} \\d{4}/)?.[0] ?? null`);
await owner.shot('join-owner-request.png');
await owner.evaluate(`[...document.querySelectorAll('button')].find((button) => /^\\s*Approve/.test(button.textContent)).click()`);

// The joiner must NOT be inside yet: it asks who approved.
await joiner.waitFor(`/check who let you in/i.test(document.body.innerText)`, 'the confirmation card', 60000);
result.confirmCard = await joiner.evaluate(`({ approver: /Owner Laptop/.test(document.body.innerText), code: document.body.innerText.match(/\\d{4} \\d{4}/)[0] })`);
result.joinerHasCredentialsBeforeConfirm = await joiner.evaluate(`(async () => { const docs = await import('/src/services/store/docs.ts'); return Boolean(docs.getDappCredentials(${JSON.stringify(joinedId)}).roomId); })()`);
await joiner.shot('join-confirm-card.png');
await sleep(1500);
result.ownerNoticeAfterApprove = await owner.evaluate(`({ notice: /must be this one/.test(document.body.innerText), code: (document.querySelector('[role="dialog"], [role="alertdialog"]')?.innerText.match(/\d{4} \d{4}/) ?? [null])[0] })`);
await owner.shot('join-owner-after-approve.png');

// A reload in between must not lose the held approval.
await joiner.send('Page.navigate', { url: `${BASE}/dapp/${joinedId}` });
await joiner.waitFor(`/check who let you in/i.test(document.body.innerText)`, 'the confirmation card after a reload', 60000);
result.cardSurvivesReload = true;

await joiner.evaluate(`[...document.querySelectorAll('button')].find((button) => /codes match/i.test(button.textContent)).click()`);
await joiner.waitFor(`(async () => { const docs = await import('/src/services/store/docs.ts'); return Boolean(docs.getDappCredentials(${JSON.stringify(joinedId)}).roomId); })()`, 'credentials after confirming');
await joiner.waitFor(`(async () => { const docs = await import('/src/services/store/docs.ts'); return docs.getDappDoc(${JSON.stringify(joinedId)}).getMap('members').size >= 2; })()`, 'the members map to sync over the mesh', 90000);
result.joinedAndSynced = true;
await sleep(2000);
await joiner.shot('join-joined.png');
result.errors = { owner: owner.errors.slice(0, 5), joiner: joiner.errors.slice(0, 5) };
console.log(JSON.stringify(result, null, 1));
owner.close();
joiner.close();
