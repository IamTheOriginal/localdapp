#!/usr/bin/env node
/**
 * y-webrtc signaling server with an HTTP health check.
 *
 * Speaks the exact y-webrtc broker protocol (subscribe / unsubscribe /
 * publish / ping) — a drop-in replacement for y-webrtc's demo server — plus:
 *
 *   GET /health  →  200 {"status":"ok","connections":N,"topics":N,"uptimeSeconds":N}
 *
 * and abuse limits for a public deployment: a per-message size cap and a
 * per-socket message-rate token bucket (a socket over either is dropped), a
 * per-socket topic cap (extra topics are ignored — dropping would put a
 * member with very many dapps into a reconnect loop), an optional per-client
 * connection cap (refused at the upgrade), and dead-peer eviction. The client
 * address is the socket's, or with TRUST_PROXY the right-most
 * X-Forwarded-For entry (the one a trusted reverse proxy appended). The
 * server only relays room-name-addressed envelopes; room data itself is
 * end-to-end encrypted, so the broker never sees document content.
 *
 * Deployment expects TLS termination at a reverse proxy (wss:// outside,
 * ws:// inside). See docs/DEPLOYMENT.md.
 *
 * Env: PORT (default 4444), HOST (default 0.0.0.0),
 *      MAX_TOPICS_PER_CONNECTION (default 512),
 *      MAX_MESSAGE_BYTES (default 131072),
 *      MAX_MESSAGES_PER_SECOND (sustained, default 100),
 *      MESSAGE_BURST (bucket size, default 1000),
 *      TRUST_PROXY (1/true: client address from X-Forwarded-For),
 *      MAX_CONNECTIONS_PER_IP (default 128 with TRUST_PROXY, else 0 = off;
 *        behind a proxy without TRUST_PROXY every socket has the proxy's
 *        address, so a cap there would be one global bucket).
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';
import net from 'node:net';

const envInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const port = envInt('PORT', 4444);
const host = process.env.HOST || '0.0.0.0';
const trustProxy = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '');
const maxTopicsPerConnection = envInt('MAX_TOPICS_PER_CONNECTION', 512);
// Signaling envelopes are small (SDP offers/answers, ICE candidates: a few KiB); 128 KiB is generous.
const maxPayloadBytes = Math.max(envInt('MAX_MESSAGE_BYTES', 128 * 1024), 1024);
// Boot of a device with hundreds of dapps: one subscribe per socket, one announce per
// topic, then signals per peer — the burst absorbs that, the rate covers steady state
// (announces every 30 s per topic).
const messagesPerSecond = Math.max(envInt('MAX_MESSAGES_PER_SECOND', 100), 1);
const messageBurst = Math.max(envInt('MESSAGE_BURST', 1000), 1);
const maxConnectionsPerIp = envInt('MAX_CONNECTIONS_PER_IP', trustProxy ? 128 : 0);
const pingTimeoutMs = 30000;

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const closePolicyViolation = 1008;

const startedAt = Date.now();

/** topic name → set of subscribed sockets */
const topics = new Map();
let connectionCount = 0;
/** client key → open sockets */
const connectionsPerClient = new Map();

/**
 * The address a connection is charged to: IPv4 as is, IPv6 by its /64 (one
 * subscriber's whole prefix). X-Forwarded-For only when TRUST_PROXY says a
 * proxy is in front — otherwise any client could pick its own bucket.
 */
function clientKey(request) {
  let address = request.socket.remoteAddress ?? '';
  if (trustProxy) {
    const header = request.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header.join(',') : header;
    const last = value?.split(',').map((entry) => entry.trim()).filter(Boolean).pop();
    if (last) address = last;
  }
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return mapped[1];
  if (net.isIP(bare.split('%')[0]) !== 6) return bare || 'unknown';
  const halves = bare.split('%')[0].split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...head, ...Array(Math.max(8 - head.length - tail.length, 0)).fill('0'), ...tail];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

const send = (conn, message) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    conn.close();
    return;
  }
  try {
    conn.send(JSON.stringify(message));
  } catch {
    conn.close();
  }
};

const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });

wss.on('connection', (conn, request, key) => {
  connectionCount++;
  const subscribedTopics = new Set();
  let closed = false;
  let pongReceived = true;
  let tokens = messageBurst;
  let refilledAt = Date.now();

  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close();
      clearInterval(pingInterval);
      return;
    }
    pongReceived = false;
    try {
      conn.ping();
    } catch {
      conn.close();
    }
  }, pingTimeoutMs);

  conn.on('pong', () => {
    pongReceived = true;
  });

  conn.on('close', () => {
    connectionCount--;
    if (key !== undefined) {
      const remaining = (connectionsPerClient.get(key) ?? 1) - 1;
      if (remaining > 0) connectionsPerClient.set(key, remaining);
      else connectionsPerClient.delete(key);
    }
    clearInterval(pingInterval);
    subscribedTopics.forEach((topicName) => {
      const subs = topics.get(topicName);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) topics.delete(topicName);
      }
    });
    subscribedTopics.clear();
    closed = true;
  });

  conn.on('error', () => {
    conn.close();
  });

  conn.on('message', (raw) => {
    if (closed) return;
    // Token bucket: a socket that outruns it is hostile or broken — drop it.
    const now = Date.now();
    tokens = Math.min(messageBurst, tokens + ((now - refilledAt) / 1000) * messagesPerSecond);
    refilledAt = now;
    if (tokens < 1) {
      closed = true;
      conn.close(closePolicyViolation, 'rate limit');
      return;
    }
    tokens -= 1;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'subscribe':
        (Array.isArray(message.topics) ? message.topics : []).forEach((topicName) => {
          if (typeof topicName !== 'string' || topicName.length > 512) return;
          if (subscribedTopics.size >= maxTopicsPerConnection) return;
          let topic = topics.get(topicName);
          if (!topic) {
            topic = new Set();
            topics.set(topicName, topic);
          }
          topic.add(conn);
          subscribedTopics.add(topicName);
        });
        break;
      case 'unsubscribe':
        (Array.isArray(message.topics) ? message.topics : []).forEach((topicName) => {
          const subs = topics.get(topicName);
          if (subs) {
            subs.delete(conn);
            if (subs.size === 0) topics.delete(topicName);
          }
          subscribedTopics.delete(topicName);
        });
        break;
      case 'publish':
        if (typeof message.topic === 'string') {
          const receivers = topics.get(message.topic);
          if (receivers) {
            message.clients = receivers.size;
            receivers.forEach((receiver) => send(receiver, message));
          }
        }
        break;
      case 'ping':
        send(conn, { type: 'pong' });
        break;
      default:
        break;
    }
  });
});

const server = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    // `GET //` and friends do not parse; an exception here would take the whole broker down.
    response.writeHead(400, { 'Content-Type': 'text/plain' });
    response.end('bad request');
    return;
  }
  if (url.pathname === '/health' || url.pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      connections: connectionCount,
      topics: topics.size,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('y-webrtc signaling server');
});

server.on('upgrade', (request, socket, head) => {
  let key;
  if (maxConnectionsPerIp > 0) {
    key = clientKey(request);
    const open = connectionsPerClient.get(key) ?? 0;
    if (open >= maxConnectionsPerIp) {
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // Counted before the handshake finishes, so a burst of upgrades cannot slip past the cap.
    connectionsPerClient.set(key, open + 1);
    socket.once('close', () => {
      if (!socket.upgradeCompleted) {
        const remaining = (connectionsPerClient.get(key) ?? 1) - 1;
        if (remaining > 0) connectionsPerClient.set(key, remaining);
        else connectionsPerClient.delete(key);
      }
    });
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    socket.upgradeCompleted = true;
    wss.emit('connection', ws, request, key);
  });
});

server.listen(port, host, () => {
  console.log(`Signaling server listening on ${host}:${port} (health: http://${host}:${port}/health)`);
});
