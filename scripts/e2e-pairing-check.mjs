#!/usr/bin/env node
/**
 * End-to-end contact pairing over REAL WebRTC with two headless Chrome profiles: both sides
 * must show the SAME safety number before anyone approves (review item 6.1), and the number
 * must not change when the pairing completes.
 *
 * Not part of `npm test` (needs Chrome and free ports). Run by hand:
 *   1. node server/signaling.mjs   and   npx vite --port 5199 --strictPort
 *   2. two Chromes: chrome --headless=new --remote-debugging-port=9444 --ignore-certificate-errors
 *                   --lang=en-US --user-data-dir=<tmp>/a about:blank      (and 9445 / <tmp>/b)
 *   3. node scripts/e2e-pairing-check.mjs <directory for screenshots>
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
  const waitFor = async (expression, what, timeout = 60000) => {
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const onboard = async (name) => {
    await send('Page.navigate', { url: BASE });
    await waitFor(`document.querySelector('input') !== null || document.querySelector('nav') !== null`, 'app');
    if (await evaluate(`document.querySelector('nav') === null`)) {
      await evaluate(`(() => { const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await evaluate(`[...document.querySelectorAll('button')].find((button) => !button.disabled && /start|create|continue/i.test(button.textContent))?.click()`);
      await waitFor(`document.querySelector('nav') !== null`, 'shell');
    }
    await sleep(800);
  };
  const go = async (path) => {
    await evaluate(`history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate'))`);
    await sleep(800);
  };
  return { send, evaluate, waitFor, shot, onboard, go, errors, close: () => ws.close() };
}

const NUMBER = String.raw`\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}`;
const inviter = await attach(9444, 'inviter');
const joiner = await attach(9445, 'joiner');
await inviter.onboard('Alice Laptop');
await joiner.onboard('Bob Phone');

const uri = await inviter.evaluate(`(async () => {
  const runtime = await import('/src/services/browserRelationshipRuntime.ts');
  const hosted = await runtime.hostRelationshipPairing();
  return hosted.uri;
})()`);
const result = { uri: String(uri).slice(0, 22) + '…' };

await joiner.evaluate(`(async () => {
  const runtime = await import('/src/services/browserRelationshipRuntime.ts');
  await runtime.joinRelationshipPairing(${JSON.stringify(uri)});
})()`);

// The joiner waits — its pending contact card must already show the number.
await joiner.go('/people');
await joiner.waitFor(`/${NUMBER}/.test(document.body.innerText)`, 'the safety number on the joiner card');
result.joinerBeforeApproval = await joiner.evaluate(`document.body.innerText.match(/${NUMBER}/)[0]`);
result.joinerHint = await joiner.evaluate(`/compare BEFORE they approve|BEVOR freigegeben/.test(document.body.innerText)`);
await joiner.shot('pair-joiner-waiting.png');

// The inviter's request row must show the same number BEFORE Approve is used.
await inviter.go('/requests');
await inviter.waitFor(`/${NUMBER}/.test(document.body.innerText)`, 'the safety number in the request row');
result.inviterBeforeApproval = await inviter.evaluate(`document.body.innerText.match(/${NUMBER}/)[0]`);
result.approveStillPending = await inviter.evaluate(`[...document.querySelectorAll('button')].some((button) => /^\\s*Approve/.test(button.textContent))`);
await inviter.shot('pair-inviter-request.png');
result.sameNumber = result.joinerBeforeApproval === result.inviterBeforeApproval;

await inviter.evaluate(`[...document.querySelectorAll('button')].find((button) => /^\\s*Approve/.test(button.textContent)).click()`);
await joiner.waitFor(`(async () => { const rel = await import('/src/services/store/relationships.ts'); return rel.listRelationships().some((entry) => entry.status === 'active'); })()`, 'the pairing to complete');
await joiner.go('/people');
result.numberAfterPairing = await joiner.evaluate(`document.body.innerText.match(/${NUMBER}/)?.[0] ?? null`);
result.unchangedAfterPairing = result.numberAfterPairing === result.joinerBeforeApproval;
await joiner.shot('pair-joiner-active.png');
result.errors = { inviter: inviter.errors.slice(0, 5), joiner: joiner.errors.slice(0, 5) };
console.log(JSON.stringify(result, null, 1));
inviter.close();
joiner.close();
