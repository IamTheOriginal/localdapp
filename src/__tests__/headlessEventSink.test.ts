import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventSink, type RecordEvent } from '../headless/eventSink.ts';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-sink-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function event(overrides: Partial<RecordEvent> = {}): RecordEvent {
  return {
    type: 'record-created',
    at: new Date().toISOString(),
    dappId: 'dapp-1',
    dappName: 'Recipes',
    collection: 'links',
    record: { id: 'r1', url: 'https://example.com' },
    ...overrides,
  };
}

interface Call { url: string; init: RequestInit }

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(call: Call): Record<string, unknown> {
  if (typeof call.init.body !== 'string') throw new Error('expected a string body');
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function fakeFetch(responder: (call: Call, index: number) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    const call = { url: urlOf(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(responder(call, calls.length - 1));
  };
  return { fetch: impl, calls };
}

const immediate: typeof setTimeout = ((fn: () => void) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout;

describe('EventSink', () => {
  it('posts JSON envelopes with the bearer secret, in order', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('ok', { status: 200 }));
    const sink = new EventSink({ url: 'http://n8n.local/webhook/keeper', secret: 's3cret', fetch });
    sink.post(event({ record: { id: 'a' } }));
    sink.post(event({ record: { id: 'b' }, type: 'record-updated' }));
    await sink.drain();

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://n8n.local/webhook/keeper');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
    expect((bodyOf(calls[0]).record as Record<string, unknown>).id).toBe('a');
    expect(bodyOf(calls[1]).type).toBe('record-updated');
    expect(sink.status()).toMatchObject({ queued: 0, delivered: 2, dropped: 0, lastError: null });
  });

  it('retries a failed delivery with backoff and keeps later events behind it', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => (index < 2 ? new Response('busy', { status: 503 }) : new Response('', { status: 200 })));
    const delays: number[] = [];
    const sink = new EventSink({
      url: 'http://n8n.local/hook',
      secret: '',
      fetch,
      initialDelayMs: 100,
      maxDelayMs: 150,
      setTimeoutFn: ((fn: () => void, ms: number) => { delays.push(ms); fn(); return 0; }) as unknown as typeof setTimeout,
    });
    sink.post(event({ record: { id: 'first' } }));
    sink.post(event({ record: { id: 'second' } }));
    await sink.drain();

    expect(delays).toEqual([100, 150]);
    expect(calls.map((call) => (bodyOf(call).record as Record<string, unknown>).id)).toEqual(['first', 'first', 'first', 'second']);
    expect(sink.status()).toMatchObject({ delivered: 2, lastError: null });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('drops events older than the max age instead of retrying forever', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('nope', { status: 500 }));
    const sink = new EventSink({ url: 'http://n8n.local/hook', secret: 'x', fetch, maxAgeMs: 60_000, setTimeoutFn: immediate });
    const stale = event({ at: new Date(Date.now() - 120_000).toISOString() });
    sink.post(stale);
    await sink.drain();

    expect(calls).toHaveLength(0);
    expect(sink.status()).toMatchObject({ dropped: 1, queued: 0 });
  });

  it('drops an event the receiver keeps rejecting, so the ones behind it get through', async () => {
    const { fetch, calls } = fakeFetch((call) => ((bodyOf(call).record as Record<string, unknown>).id === 'bad'
      ? new Response('no such field', { status: 400 })
      : new Response('', { status: 200 })));
    const sink = new EventSink({ url: 'http://n8n.local/hook', secret: '', fetch, maxRejections: 3, setTimeoutFn: immediate });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sink.post(event({ record: { id: 'bad' } }));
    sink.post(event({ record: { id: 'good' } }));
    await sink.drain();
    spy.mockRestore();

    expect(calls.map((call) => (bodyOf(call).record as Record<string, unknown>).id)).toEqual(['bad', 'bad', 'bad', 'good']);
    expect(sink.status()).toMatchObject({ delivered: 1, dropped: 1, queued: 0 });
  });

  it('caps the queue by dropping the oldest events', () => {
    const { fetch } = fakeFetch(() => new Response('down', { status: 503 }));
    const never: typeof setTimeout = (() => 0) as unknown as typeof setTimeout;
    const sink = new EventSink({ url: 'http://n8n.local/hook', secret: '', fetch, maxQueued: 2, setTimeoutFn: never });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ['a', 'b', 'c', 'd'].forEach((id) => { sink.post(event({ record: { id } })); });
    spy.mockRestore();
    expect(sink.status()).toMatchObject({ queued: 2, dropped: 2 });
  });

  it('keeps undelivered events across a restart and delivers them first', async () => {
    const queueFile = path.join(await tempDir(), 'event-queue.json');
    const down = fakeFetch(() => new Response('down', { status: 503 }));
    const never: typeof setTimeout = (() => 0) as unknown as typeof setTimeout;
    const first = new EventSink({ url: 'http://n8n.local/hook', secret: '', fetch: down.fetch, queueFile, setTimeoutFn: never });
    first.post(event({ record: { id: 'before-restart-1' } }));
    first.post(event({ record: { id: 'before-restart-2' } }));
    await vi.waitFor(() => { expect(down.calls.length).toBeGreaterThan(0); });
    await first.stop();
    expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).toHaveLength(2);

    const up = fakeFetch(() => new Response('', { status: 200 }));
    const second = new EventSink({ url: 'http://n8n.local/hook', secret: '', fetch: up.fetch, queueFile });
    second.post(event({ record: { id: 'after-restart' } }));
    await second.drain();
    await second.stop();

    expect(up.calls.map((call) => (bodyOf(call).record as Record<string, unknown>).id)).toEqual(['before-restart-1', 'before-restart-2', 'after-restart']);
    expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).toEqual([]);
  });

  it('records the last error while an event is stuck', async () => {
    let failing = true;
    const { fetch } = fakeFetch(() => (failing ? new Response('boom', { status: 502 }) : new Response(null, { status: 204 })));
    const sink = new EventSink({
      url: 'http://n8n.local/hook',
      secret: 'x',
      fetch,
      setTimeoutFn: ((fn: () => void) => { failing = false; fn(); return 0; }) as unknown as typeof setTimeout,
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sink.post(event());
    await sink.drain();
    spy.mockRestore();
    expect(sink.status()).toMatchObject({ delivered: 1, lastError: null });
  });
});
