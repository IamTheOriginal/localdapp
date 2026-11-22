import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';

/**
 * The production signaling broker (`server/signaling.mjs`), started as the real process.
 * The member mesh depends on two of its properties that nothing else checks: a publish
 * comes back to the sender as well, and nothing a client sends can take the broker down.
 */

const MAX_TOPICS = 3;
let broker: ChildProcess;
let port: number;

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

function request(requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // Raw request: the path must reach the server byte for byte (`//` does not survive `fetch`).
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

interface Client {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  closed: Promise<void>;
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const received: Array<Record<string, unknown>> = [];
    socket.on('message', (raw: Buffer) => { received.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
    const closed = new Promise<void>((done) => { socket.on('close', () => { done(); }); });
    socket.on('error', () => undefined);
    socket.on('open', () => { resolve({ socket, received, closed }); });
    socket.once('error', reject);
  });
}

const send = (client: Client, message: unknown) => { client.socket.send(typeof message === 'string' ? message : JSON.stringify(message)); };

async function until(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

/** A ping answered with a pong proves everything sent before it on this socket was handled. */
async function settled(client: Client): Promise<void> {
  const before = client.received.filter((message) => message.type === 'pong').length;
  send(client, { type: 'ping' });
  await until(() => client.received.filter((message) => message.type === 'pong').length > before, 'pong');
}

beforeAll(async () => {
  port = await freePort();
  broker = spawn(process.execPath, [path.resolve('server/signaling.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MAX_TOPICS_PER_CONNECTION: String(MAX_TOPICS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    broker.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('listening')) resolve(); });
    broker.on('exit', (code) => { reject(new Error(`broker exited early with code ${String(code)}`)); });
    setTimeout(() => { reject(new Error('broker did not start')); }, 10_000);
  });
}, 15_000);

afterAll(() => {
  broker.kill();
});

describe('signaling broker', () => {
  it('answers the health check and survives request paths that do not parse', async () => {
    const health = await request('/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });

    expect((await request('//')).status).toBe(400);
    expect((await request('/health')).status).toBe(200);
    expect(broker.exitCode).toBeNull();
  });

  it('delivers a publish to every subscriber of the topic, the sender included, and to nobody else', async () => {
    const [alice, bob, stranger] = await Promise.all([connect(), connect(), connect()]);
    send(alice, { type: 'subscribe', topics: ['room-1'] });
    send(bob, { type: 'subscribe', topics: ['room-1'] });
    send(stranger, { type: 'subscribe', topics: ['room-2'] });
    await Promise.all([settled(alice), settled(bob), settled(stranger)]);

    send(alice, { type: 'publish', topic: 'room-1', envelope: { iv: 'a', data: 'b' } });
    await until(() => bob.received.some((message) => message.type === 'publish'), 'fan-out to bob');
    await until(() => alice.received.some((message) => message.type === 'publish'), 'echo to the sender');
    await settled(stranger);

    expect(bob.received.find((message) => message.type === 'publish')).toMatchObject({ topic: 'room-1', envelope: { iv: 'a', data: 'b' }, clients: 2 });
    expect(stranger.received.some((message) => message.type === 'publish')).toBe(false);

    send(bob, { type: 'unsubscribe', topics: ['room-1'] });
    await settled(bob);
    const before = bob.received.filter((message) => message.type === 'publish').length;
    send(alice, { type: 'publish', topic: 'room-1', envelope: { iv: 'c', data: 'd' } });
    await until(() => alice.received.filter((message) => message.type === 'publish').length === 2, 'second echo');
    await settled(bob);
    expect(bob.received.filter((message) => message.type === 'publish').length).toBe(before);
    [alice, bob, stranger].forEach((client) => { client.socket.close(); });
  });

  it('ignores garbage and keeps serving the same connection', async () => {
    const client = await connect();
    send(client, 'this is not json');
    send(client, '[1,2,3]');
    send(client, { type: 42 });
    send(client, { type: 'subscribe', topics: 'not-a-list' });
    send(client, { type: 'subscribe', topics: [17, null, 'x'.repeat(600)] });
    send(client, { type: 'publish' });
    send(client, { type: 'unknown-thing' });
    await settled(client);
    expect(broker.exitCode).toBeNull();
    client.socket.close();
  });

  it('caps the topics of one connection', async () => {
    const greedy = await connect();
    const topics = Array.from({ length: MAX_TOPICS + 2 }, (_value, index) => `capped-${index}`);
    send(greedy, { type: 'subscribe', topics });
    await settled(greedy);

    const publisher = await connect();
    for (const topic of topics) send(publisher, { type: 'publish', topic, envelope: { topic } });
    await settled(publisher);
    await settled(greedy);

    const heard = greedy.received.filter((message) => message.type === 'publish').map((message) => message.topic);
    expect(heard).toEqual(topics.slice(0, MAX_TOPICS));
    greedy.socket.close();
    publisher.socket.close();
  });

  it('drops a connection that sends more than the payload cap, without affecting the others', async () => {
    const [bystander, sender] = await Promise.all([connect(), connect()]);
    send(bystander, { type: 'subscribe', topics: ['quiet-room'] });
    await settled(bystander);

    send(sender, { type: 'publish', topic: 'quiet-room', envelope: { data: 'x'.repeat(1024 * 1024 + 10) } });
    await sender.closed;

    await settled(bystander);
    expect(bystander.received.some((message) => message.type === 'publish')).toBe(false);
    expect((await request('/health')).status).toBe(200);
    bystander.socket.close();
  });
});
