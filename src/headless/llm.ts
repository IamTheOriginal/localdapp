/**
 * The keeper's entire LLM "harness": one OpenAI-compatible chat-completions
 * call over `fetch`. Vendor choice, keys and routing live in the gateway the
 * base URL points at (LiteLLM on the NAS — docs/HEADLESS.md). No SDK on
 * purpose: the wire format is the one thing every hosted, aggregated and
 * self-hosted model server has in common.
 *
 * Requests always stream (SSE) and are aggregated here: dapp generation runs
 * for minutes, which non-streaming HTTP handles badly, and some gateway
 * bridges (LiteLLM's ChatGPT-subscription provider) only work when streaming.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatOptions {
  /** Ask the server for a JSON object (`response_format`); the caller still parses. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmChatResult {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  /** May be absent until an operator picks one; `chat` refuses to run without it. */
  model?: string;
  fetch?: typeof fetch;
  /** Per-request timeout (default 10 min — dapp generation is slow). */
  timeoutMs?: number;
  /** Delay before the single retry on 429/5xx/network errors (default 2 s). */
  retryDelayMs?: number;
}

interface ChatCompletionChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: unknown;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export class LlmError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

function isRetryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/** Folds an SSE `data:` stream of chat-completion chunks into one result. */
export async function aggregateChatStream(body: ReadableStream<Uint8Array>, fallbackModel: string): Promise<LlmChatResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = '';
  let content = '';
  let model = fallbackModel;
  let usage: LlmChatResult['usage'] = null;
  let sawChunk = false;

  const consume = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(payload) as ChatCompletionChunk;
    } catch {
      return; // keep-alive noise or a partial frame we cannot use
    }
    if (chunk.error !== undefined) {
      throw new LlmError(`llm: stream error — ${JSON.stringify(chunk.error).slice(0, 500)}`, null);
    }
    sawChunk = true;
    if (chunk.model) model = chunk.model;
    for (const choice of chunk.choices ?? []) content += choice.delta?.content ?? '';
    const chunkUsage = chunk.usage;
    if (chunkUsage && typeof chunkUsage.prompt_tokens === 'number' && typeof chunkUsage.completion_tokens === 'number') {
      usage = { promptTokens: chunkUsage.prompt_tokens, completionTokens: chunkUsage.completion_tokens };
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      consume(buffered.slice(0, newline).replace(/\r$/, ''));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  if (buffered.trim()) consume(buffered.trim());
  if (!sawChunk) throw new LlmError('llm: response stream carried no completion chunks', null);
  return { content, model, usage };
}

interface ModelListResponse {
  data?: Array<{ id?: unknown }>;
}

export class LlmClient {
  model: string | null;
  readonly baseUrl: string;
  private readonly options: Required<Omit<LlmClientOptions, 'model'>>;

  constructor(options: LlmClientOptions) {
    this.model = options.model ?? null;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.options = {
      apiKey: options.apiKey,
      baseUrl: this.baseUrl,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };
  }

  get keyConfigured(): boolean {
    return this.options.apiKey.length > 0;
  }

  /** Model names the gateway offers this key (`GET /models`). */
  async listModels(): Promise<string[]> {
    const response = await this.options.fetch(`${this.baseUrl}/models`, {
      headers: { ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new LlmError(`llm: HTTP ${response.status} listing models`, response.status);
    const payload = await response.json() as ModelListResponse;
    return (payload.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
  }

  async chat(messages: LlmMessage[], chatOptions: LlmChatOptions = {}): Promise<LlmChatResult> {
    if (!this.model) throw new LlmError('llm: no model selected — pick one in the control dapp (set-model) or set LLM_MODEL', 400);
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(chatOptions.json ? { response_format: { type: 'json_object' } } : {}),
      ...(chatOptions.temperature !== undefined ? { temperature: chatOptions.temperature } : {}),
      ...(chatOptions.maxTokens !== undefined ? { max_tokens: chatOptions.maxTokens } : {}),
    });

    let lastError: LlmError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
      try {
        return await this.request(body);
      } catch (error) {
        lastError = error instanceof LlmError ? error : new LlmError(error instanceof Error ? error.message : String(error), null);
        if (!isRetryable(lastError.status)) throw lastError;
      }
    }
    throw lastError ?? new LlmError('llm: request failed', null);
  }

  private async request(body: string): Promise<LlmChatResult> {
    const response = await this.options.fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 500);
      throw new LlmError(`llm: HTTP ${response.status}${text ? ` — ${text}` : ''}`, response.status);
    }
    if (!response.body) throw new LlmError('llm: empty response body', response.status);
    return aggregateChatStream(response.body, this.model ?? '');
  }
}
