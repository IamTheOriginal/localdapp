import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomicFile.ts';

/**
 * Outbound event delivery to the single configured n8n webhook
 * (docs/HEADLESS.md, "Events → n8n"). One in-order queue: an event is retried
 * with exponential backoff until it is accepted (2xx) or older than
 * `maxAgeMs`, then dropped with a log line. n8n does all filtering; the
 * keeper never decides which events matter.
 *
 * With `queueFile` set the undelivered events are kept on disk, so a restart
 * during an n8n outage loses nothing (the record feed's cursor has already
 * moved past them). Two guards keep one bad event from blocking the rest: an
 * answer that will not change on retry (4xx other than 408 / 429) drops the
 * event after `maxRejections` attempts, and the queue holds at most
 * `maxQueued` events — the oldest go first.
 */

export interface RecordEvent {
  type: 'record-created' | 'record-updated' | 'record-deleted';
  /** Keeper clock, ISO. */
  at: string;
  dappId: string;
  dappName: string;
  collection: string;
  record: Record<string, unknown>;
  /** Last verified state before an update or deletion, when the keeper saw one. */
  previous?: Record<string, unknown>;
}

export interface EventSinkStatus {
  url: string;
  queued: number;
  delivered: number;
  dropped: number;
  lastError: string | null;
  lastDeliveredAt: string | null;
}

interface EventSinkOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  /** Events older than this are dropped instead of retried (default 24 h). */
  maxAgeMs?: number;
  /** First retry delay; doubles per attempt up to `maxDelayMs` (defaults 1 s / 5 min). */
  initialDelayMs?: number;
  maxDelayMs?: number;
  setTimeoutFn?: typeof setTimeout;
  /** Where undelivered events survive a restart; absent = memory only. */
  queueFile?: string;
  /** Attempts before an event the receiver rejects (4xx) is dropped (default 5). */
  maxRejections?: number;
  /** Upper bound of waiting events (default 5000). */
  maxQueued?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REJECTIONS = 5;
const DEFAULT_MAX_QUEUED = 5_000;

interface SendFailure {
  message: string;
  /** The receiver answered and said no — retrying the same body will not help. */
  rejected: boolean;
}

function isRecordEvent(value: unknown): value is RecordEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.type === 'string' && typeof event.at === 'string' && typeof event.dappId === 'string'
    && typeof event.collection === 'string' && Boolean(event.record) && typeof event.record === 'object';
}

export class EventSink {
  private readonly options: Required<Omit<EventSinkOptions, 'fetch' | 'setTimeoutFn' | 'queueFile'>> & { fetch: typeof fetch; setTimeoutFn: typeof setTimeout; queueFile: string | null };
  private readonly queue: RecordEvent[] = [];
  private readonly ready: Promise<void>;
  private persistChain: Promise<void> = Promise.resolve();
  private persistPending = false;
  private draining: Promise<void> | null = null;
  private attempt = 0;
  private rejections = 0;
  private delivered = 0;
  private dropped = 0;
  private lastError: string | null = null;
  private lastDeliveredAt: string | null = null;
  private stopped = false;

  constructor(options: EventSinkOptions) {
    this.options = {
      url: options.url,
      secret: options.secret,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      initialDelayMs: options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      setTimeoutFn: options.setTimeoutFn ?? setTimeout,
      queueFile: options.queueFile ?? null,
      maxRejections: options.maxRejections ?? DEFAULT_MAX_REJECTIONS,
      maxQueued: options.maxQueued ?? DEFAULT_MAX_QUEUED,
    };
    this.ready = this.restore();
    if (this.options.queueFile) void this.ready.then(() => { if (this.queue.length > 0) void this.drain(); });
  }

  /** Events left over from the previous run go in front of anything posted since. */
  private async restore(): Promise<void> {
    if (!this.options.queueFile) return;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.options.queueFile, 'utf8'));
      if (Array.isArray(parsed)) this.queue.unshift(...parsed.filter(isRecordEvent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('event sink: stored queue is unreadable, starting empty', error);
    }
  }

  /** Coalesced: one write covers every change made while the previous write was running. */
  private persist(): void {
    const file = this.options.queueFile;
    if (!file || this.persistPending) return;
    this.persistPending = true;
    this.persistChain = this.persistChain
      .then(async () => {
        await this.ready;
        this.persistPending = false;
        await writeFileAtomic(file, `${JSON.stringify(this.queue)}\n`, { mode: 0o600 });
      })
      .catch((error: unknown) => {
        this.persistPending = false;
        console.error('event sink: could not store the queue', error);
      });
  }

  /** Enqueue and start draining; never throws — delivery problems show up in `status()`. */
  post(event: RecordEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    while (this.queue.length > this.options.maxQueued) {
      const oldest = this.queue.shift();
      this.dropped += 1;
      if (oldest) console.error(`event sink: queue is full, dropped ${oldest.type} for ${oldest.dappId}/${oldest.collection}`);
    }
    this.persist();
    void this.drain();
  }

  /** Stops delivering; what is still queued stays on disk for the next run. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.persistChain;
  }

  status(): EventSinkStatus {
    return {
      url: this.options.url,
      queued: this.queue.length,
      delivered: this.delivered,
      dropped: this.dropped,
      lastError: this.lastError,
      lastDeliveredAt: this.lastDeliveredAt,
    };
  }

  /** Resolves once the queue is empty (tests); production callers use `post` fire-and-forget. */
  drain(): Promise<void> {
    this.draining ??= this.drainLoop().finally(() => { this.draining = null; });
    return this.draining;
  }

  private removeHead(): void {
    this.queue.shift();
    this.attempt = 0;
    this.rejections = 0;
    this.persist();
  }

  private async drainLoop(): Promise<void> {
    await this.ready;
    while (this.queue.length > 0 && !this.stopped) {
      const event = this.queue[0];
      if (Date.now() - Date.parse(event.at) > this.options.maxAgeMs) {
        this.removeHead();
        this.dropped += 1;
        console.error(`event sink: dropped ${event.type} for ${event.dappId}/${event.collection} (older than max age)`);
        continue;
      }
      const failure = await this.send(event);
      if (failure === null) {
        this.removeHead();
        this.delivered += 1;
        this.lastDeliveredAt = new Date().toISOString();
        this.lastError = null;
        continue;
      }
      this.lastError = failure.message;
      if (failure.rejected) {
        this.rejections += 1;
        if (this.rejections >= this.options.maxRejections) {
          this.removeHead();
          this.dropped += 1;
          console.error(`event sink: dropped ${event.type} for ${event.dappId}/${event.collection} (receiver keeps rejecting it: ${failure.message})`);
          continue;
        }
      }
      const delay = Math.min(this.options.initialDelayMs * 2 ** this.attempt, this.options.maxDelayMs);
      this.attempt += 1;
      await new Promise<void>((resolve) => this.options.setTimeoutFn(resolve, delay));
    }
  }

  private async send(event: RecordEvent): Promise<SendFailure | null> {
    try {
      const response = await this.options.fetch(this.options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.secret ? { Authorization: `Bearer ${this.options.secret}` } : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return null;
      const text = (await response.text().catch(() => '')).slice(0, 200);
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      return { message: `HTTP ${response.status}${text ? `: ${text}` : ''}`, rejected };
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error), rejected: false };
    }
  }
}
