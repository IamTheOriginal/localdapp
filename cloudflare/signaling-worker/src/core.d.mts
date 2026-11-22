export interface SqlCursor {
  [Symbol.iterator](): Iterator<Record<string, unknown>>;
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

export interface HibernatableWebSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectStateLike {
  storage: { sql: SqlStorage };
  acceptWebSocket(ws: HibernatableWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableWebSocket[];
}

export interface SignalingWorkerEnv {
  SIGNALING_HUB?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> | Response };
  };
  ASSETS?: {
    fetch(request: Request): Promise<Response> | Response;
  };
  ALLOWED_ORIGINS?: string;
  MAX_TOPICS_PER_CONNECTION?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_MESSAGES_PER_SECOND?: string;
  MESSAGE_BURST?: string;
  MAX_CONNECTIONS_PER_IP?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  TURN_USER_MONTHLY_LIMIT_BYTES?: string;
  TURN_IP_MONTHLY_LIMIT_BYTES?: string;
  TURN_ACCOUNT_WARN_BYTES?: string;
  TURN_ACCOUNT_HARD_CAP_BYTES?: string;
  TURN_ALERT_WEBHOOK_URL?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  ICE_ACCESS_TOKEN?: string;
  ICE_RATE_LIMIT_PER_HOUR?: string;
}

export function envInt(env: SignalingWorkerEnv | undefined, name: string, fallback: number): number;
export function normalizeClientIp(rawAddress: string | null | undefined): string;
export function normalizeIpPrefix(normalizedIp: string): string;
export function clientIpFromRequest(request: Request): string;
export function parseAllowedOrigins(env: SignalingWorkerEnv | undefined): string[];
export function verifyIceIdentity(
  request: Request,
  nowMs?: number,
): Promise<{ verified: true; userId: string } | { verified: false; reason: string }>;

export interface TurnSyncResult {
  synced: boolean;
  month: string;
  reason?: string;
  error?: string;
  accountEgressBytes?: number;
  trackedUsers?: number;
  warnSent?: boolean;
  killSwitchTripped?: boolean;
  revokedCount?: number;
}

export class SignalingHubCore {
  topics: Map<string, Set<HibernatableWebSocket>>;
  socketTopics: Map<HibernatableWebSocket, Set<string>>;
  constructor(
    ctx: DurableObjectStateLike,
    env?: SignalingWorkerEnv,
    options?: {
      now?: () => number;
      fetchFn?: typeof fetch;
      createWebSocketPair?: () => [HibernatableWebSocket, HibernatableWebSocket];
      createUpgradeResponse?: (client: HibernatableWebSocket) => Response;
    },
  );
  handleFetch(request: Request): Response | Promise<Response>;
  handleIceRequest(request: Request): Promise<Response>;
  syncTurnUsage(): Promise<TurnSyncResult>;
  handleWebSocketMessage(ws: HibernatableWebSocket, raw: string | ArrayBuffer | ArrayBufferView): void;
  handleWebSocketClose(ws: HibernatableWebSocket): void;
  handleWebSocketError(ws: HibernatableWebSocket): void;
}

export function createIceHandler(options?: {
  fetchFn?: typeof fetch;
  now?: () => number;
}): (request: Request, env?: SignalingWorkerEnv) => Promise<Response>;

export function createWorkerFetch(): (request: Request, env: SignalingWorkerEnv) => Promise<Response>;
