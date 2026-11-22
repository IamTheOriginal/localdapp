import { describe, expect, it } from 'vitest';
import { LlmClient, LlmError, aggregateChatStream } from '../headless/llm.ts';

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

/** An SSE body the way LiteLLM / OpenAI-compatible servers emit it (split mid-frame to exercise buffering). */
function sse(chunks: unknown[]): Response {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  const half = Math.floor(text.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, half)));
      controller.enqueue(encoder.encode(text.slice(half)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const streamedHello = () => sse([
  { id: 'c1', model: 'served-model', choices: [{ index: 0, delta: { role: 'assistant', content: '{"ok"' } }] },
  { id: 'c1', model: 'served-model', choices: [{ index: 0, delta: { content: ':true}' } }] },
  { id: 'c1', model: 'served-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'c1', model: 'served-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
]);

describe('LlmClient', () => {
  it('posts a streaming OpenAI-compatible chat completion and aggregates the text', async () => {
    const { fetch, calls } = fakeFetch(streamedHello);
    const client = new LlmClient({ baseUrl: 'http://litellm.local:4000/v1/', apiKey: 'sk-virtual', model: 'chatgpt/gpt-6-astra', fetch });
    const result = await client.chat([{ role: 'user', content: 'hi' }], { json: true, maxTokens: 50 });

    expect(calls[0].url).toBe('http://litellm.local:4000/v1/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-virtual');
    expect(headers.Accept).toBe('text/event-stream');
    expect(bodyOf(calls[0])).toEqual({
      model: 'chatgpt/gpt-6-astra',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      max_tokens: 50,
    });
    expect(result).toEqual({ content: '{"ok":true}', model: 'served-model', usage: { promptTokens: 12, completionTokens: 3 } });
  });

  it('retries once on 5xx/429 and surfaces the final error verbatim', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('{"error":"overloaded"}', { status: 503 }));
    const client = new LlmClient({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', fetch, retryDelayMs: 0 });
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError', status: 503, message: 'llm: HTTP 503 — {"error":"overloaded"}',
    });
    expect(calls).toHaveLength(2);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('does not retry client errors', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('bad model', { status: 400 }));
    const client = new LlmClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch, retryDelayMs: 0 });
    const error = await client.chat([{ role: 'user', content: 'hi' }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('rejects a stream without completion chunks and surfaces in-stream errors', async () => {
    const empty = () => new Response(': keep-alive\n\ndata: [DONE]\n\n', { status: 200 });
    const client = new LlmClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: fakeFetch(empty).fetch, retryDelayMs: 0 });
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('no completion chunks');

    const failing = sse([{ error: { message: 'model exploded' } }]);
    await expect(aggregateChatStream(failing.body as ReadableStream<Uint8Array>, 'm')).rejects.toThrow('model exploded');
  });
});
