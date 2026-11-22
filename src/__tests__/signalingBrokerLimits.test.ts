import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';

/**
 * Abuse limits of the production signaling broker (`server/signaling.mjs`),
 * each started as the real process with its limits set through the
 * environment: message size and rate (the socket is dropped), connections per
 * client address (refused at the upgrade), X-Forwarded-For honored only with
 * TRUST_PROXY — and the member mesh's legitimate pattern of hundreds of topics
 * on one socket still works under the defaults.
 */

interface Broker { process: ChildProcess; port: number }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => { resolve(typeof address === 'object' && address ? address.port : 0); });
    });
  });
}

async function startBroker(env: Record<string, string>): Promise<Broker> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve('server/signaling.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '', MAX_CONNECTIONS_PER_IP: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('listening')) resolve(); });
    child.on('exit', (code) => { reject(new Error(`broker exited early with code ${String(code)}`)); });
    setTimeout(() => { reject(new Error('broker did not start')); }, 10_000);
  });
  return { process: child, port };
}

interface Client {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

function connect(broker: Broker, forwardedFor?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(broker.port)}`, forwardedFor ? { headers: { 'X-Forwarded-For': forwardedFor } } : {});
    const received: Array<Record<string, unknown>> = [];
    socket.on('message', (raw: Buffer) => { received.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
    const closed = new Promise<number>((done) => { socket.on('close', (code: number) => { done(code); }); });
    socket.on('error', () => undefined);
    socket.on('open', () => { resolve({ socket, received, closed }); });
    socket.once('unexpected-response', (_request, response) => { reject(new Error(`refused with ${String(response.statusCode)}`)); });
    socket.once('error', reject);
  });
}

const send = (client: Client, message: unknown) => { client.socket.send(JSON.stringify(message)); };

async function until(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

async function settled(client: Client): Promise<void> {
  const before = client.received.filter((message) => message.type === 'pong').length;
  send(client, { type: 'ping' });
  await until(() => client.received.filter((message) => message.type === 'pong').length > before, 'pong');
}

describe('signaling broker limits (tight settings, behind a trusted proxy)', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({
      MAX_MESSAGE_BYTES: '2048',
      MAX_MESSAGES_PER_SECOND: '5',
      MESSAGE_BURST: '20',
      TRUST_PROXY: '1',
      MAX_CONNECTIONS_PER_IP: '3',
    });
  }, 15_000);
  afterAll(() => { broker.process.kill(); });

  it('drops a socket that sends an oversized message', async () => {
    const [bystander, sender] = await Promise.all([connect(broker, '192.0.2.1'), connect(broker, '192.0.2.2')]);
    send(bystander, { type: 'subscribe', topics: ['room'] });
    await settled(bystander);
    send(sender, { type: 'publish', topic: 'room', envelope: { data: 'x'.repeat(4096) } });
    expect(await sender.closed).toBe(1009);
    await settled(bystander);
    expect(bystander.received.some((message) => message.type === 'publish')).toBe(false);
    bystander.socket.close();
  });

  it('drops a socket that floods messages, and only that one', async () => {
    const [flooder, calm] = await Promise.all([connect(broker, '192.0.2.3'), connect(broker, '192.0.2.4')]);
    for (let index = 0; index < 100; index += 1) send(flooder, { type: 'publish', topic: 'nowhere', envelope: {} });
    expect(await flooder.closed).toBe(1008);
    // A client within the burst is unaffected.
    for (let index = 0; index < 10; index += 1) send(calm, { type: 'publish', topic: 'nowhere', envelope: {} });
    await settled(calm);
    expect(calm.socket.readyState).toBe(WebSocket.OPEN);
    calm.socket.close();
  });

  it('caps connections per forwarded client address and frees the slot on close', async () => {
    const own = await Promise.all([connect(broker, '198.51.100.1'), connect(broker, '198.51.100.1'), connect(broker, '198.51.100.1')]);
    await expect(connect(broker, '198.51.100.1')).rejects.toThrow('429');
    // A spoofed prefix does not help: the right-most entry is the proxy's.
    await expect(connect(broker, '203.0.113.9, 198.51.100.1')).rejects.toThrow('429');
    // Another client is not affected.
    const other = await connect(broker, '198.51.100.2');
    own[0].socket.close();
    await own[0].closed;
    // The broker frees the slot when it sees the close, which may trail the client's event.
    let again: Client | null = null;
    const started = Date.now();
    while (!again) {
      again = await connect(broker, '198.51.100.1').catch(() => null);
      if (!again && Date.now() - started > 5000) throw new Error('slot was never freed');
    }
    [...own.slice(1), other, again].forEach((client) => { client.socket.close(); });
  });

  it('counts IPv6 clients by their /64', async () => {
    const clients = await Promise.all([
      connect(broker, '2001:db8:1:2::1'), connect(broker, '2001:db8:1:2::2'), connect(broker, '2001:db8:1:2:aaaa::3'),
    ]);
    await expect(connect(broker, '2001:db8:1:2::ffff')).rejects.toThrow('429');
    const otherPrefix = await connect(broker, '2001:db8:1:3::1');
    [...clients, otherPrefix].forEach((client) => { client.socket.close(); });
  });
});

describe('signaling broker limits (defaults, forwarded header not trusted)', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ MAX_CONNECTIONS_PER_IP: '2' });
  }, 15_000);
  afterAll(() => { broker.process.kill(); });

  it('ignores X-Forwarded-For unless TRUST_PROXY is set', async () => {
    const first = await connect(broker, '198.51.100.10');
    const second = await connect(broker, '198.51.100.11');
    await expect(connect(broker, '198.51.100.12')).rejects.toThrow('429');
    first.socket.close();
    second.socket.close();
  });

  it('serves hundreds of topics on one socket, as the member mesh does', async () => {
    const device = await connect(broker);
    const topics = Array.from({ length: 250 }, (_value, index) => `blob-v1-${String(index)}`);
    send(device, { type: 'subscribe', topics });
    // Boot pattern: one announce per topic right after subscribing.
    for (const topic of topics) send(device, { type: 'publish', topic, envelope: { announce: true } });
    await settled(device);
    await until(() => device.received.filter((message) => message.type === 'publish').length === topics.length, 'every echo');
    expect(device.socket.readyState).toBe(WebSocket.OPEN);
    device.socket.close();
  });
});
