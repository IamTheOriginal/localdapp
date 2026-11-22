import { DurableObject } from 'cloudflare:workers';
import { SignalingHubCore, createWorkerFetch } from './core.mjs';

export class SignalingHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answer standard y-webrtc JSON keepalive pings at the Cloudflare edge
    // without waking the Durable Object from hibernation (saves free-tier quota).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    this.core = new SignalingHubCore(ctx, env);
  }

  fetch(request) {
    return this.core.handleFetch(request);
  }

  webSocketMessage(ws, message) {
    this.core.handleWebSocketMessage(ws, message);
  }

  webSocketClose(ws) {
    this.core.handleWebSocketClose(ws);
  }

  webSocketError(ws) {
    this.core.handleWebSocketError(ws);
  }
}

export default {
  fetch: createWorkerFetch(),
  async scheduled(_controller, env, ctx) {
    const stub = env.SIGNALING_HUB.get(env.SIGNALING_HUB.idFromName('global'));
    ctx.waitUntil(
      stub.fetch(new Request('https://internal/_internal/cron/sync-turn-usage', { method: 'POST' })),
    );
  },
};
