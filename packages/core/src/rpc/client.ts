// JSON-RPC client for Helius (mainnet, devnet) and localnet only.
// Timeouts, retries with exponential backoff (honours Retry-After), a client-side rate cap
// (mainnet <= 8 rps: Helius answered 429 at ~10 rps) and a per-session response cache.
// Service-worker safe: only fetch, AbortController and setTimeout. The API key lives in the URL
// and every error message passes through redactUrl() before it leaves this module.

export type RpcNetwork = "mainnet" | "devnet" | "localnet";

export const HELIUS_RPC_HOSTS: Readonly<Record<"mainnet" | "devnet", string>> = {
  mainnet: "mainnet.helius-rpc.com",
  devnet: "devnet.helius-rpc.com"
};
export const LOCALNET_RPC_URL = "http://localhost:8899";

/** Default rate caps (requests per second). Mainnet may never exceed MAINNET_MAX_RPS. */
export const MAINNET_MAX_RPS = 8;
export const DEFAULT_RPS: Readonly<Record<RpcNetwork, number>> = { mainnet: 8, devnet: 20, localnet: 200 };

/** Methods the engine may call. Anything that submits or changes state is refused. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "simulateTransaction",
  "getLatestBlockhash",
  "getFeeForMessage",
  "getSlot",
  "getHealth",
  "getGenesisHash",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getAsset",
  "getAssetBatch"
]);

/** Results that depend on time and must never be served from the cache. */
const UNCACHEABLE: ReadonlySet<string> = new Set(["simulateTransaction", "getLatestBlockhash", "getFeeForMessage", "getSlot", "getHealth"]);

export function redactUrl(s: string): string {
  return s.replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");
}

export type RpcErrorCode = "timeout" | "network" | "http" | "rpc" | "rate_limited" | "bad_response" | "refused";

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly method: string;
  readonly status?: number;
  readonly rpcCode?: number;
  attempts: number;
  constructor(code: RpcErrorCode, method: string, message: string, extra: { status?: number; rpcCode?: number; attempts?: number } = {}) {
    super(redactUrl(`${method}: ${message}`));
    this.name = "RpcError";
    this.code = code;
    this.method = method;
    this.status = extra.status;
    this.rpcCode = extra.rpcCode;
    this.attempts = extra.attempts ?? 1;
  }
}

/** Build the RPC URL for a network. Helius needs a key; localnet never gets one. */
export function rpcUrlFor(network: RpcNetwork, heliusApiKey?: string): string {
  if (network === "localnet") return LOCALNET_RPC_URL;
  const key = (heliusApiKey ?? "").trim();
  if (!key) throw new RpcError("refused", "rpcUrlFor", `no Helius API key for ${network}`);
  return `https://${HELIUS_RPC_HOSTS[network]}/?api-key=${encodeURIComponent(key)}`;
}

/** Which network an endpoint belongs to, or null when it is not Helius or localnet (refused). */
export function networkOfUrl(url: string): RpcNetwork | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "https:" && u.hostname === HELIUS_RPC_HOSTS.mainnet && !u.port) return "mainnet";
  if (u.protocol === "https:" && u.hostname === HELIUS_RPC_HOSTS.devnet && !u.port) return "devnet";
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port === "8899") return "localnet";
  return null;
}

export interface RpcClientOptions {
  url: string;
  /** Per-attempt timeout. Default 10 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 4. */
  maxRetries?: number;
  /** Backoff base and cap in ms. Defaults 250 and 8000. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Longest Retry-After we will honour before giving up. Default 30 s. */
  maxRetryAfterMs?: number;
  /** Requests per second. Defaults per network; mainnet is clamped to MAINNET_MAX_RPS. */
  maxRps?: number;
  /** Per-session cache (default on). Pass false to disable. */
  cache?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** [0,1) jitter source; injectable for tests. */
  random?: () => number;
}

export interface RpcStats {
  requests: number;
  retries: number;
  cacheHits: number;
  rateLimited: number;
}

/** JSON-RPC params: positional, or named (Helius DAS methods such as getAssetBatch). */
export type RpcParams = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface RpcClient {
  readonly network: RpcNetwork;
  /** Endpoint with any api-key redacted, safe to log. */
  readonly endpoint: string;
  readonly stats: RpcStats;
  call<T>(method: string, params?: RpcParams): Promise<T>;
  clearCache(): void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After as seconds or an HTTP date; returns ms or null. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function cacheKey(method: string, params: RpcParams): string {
  return `${method}:${JSON.stringify(params, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`;
}

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
// -32005 node behind / -32004 block not available / -32014 status unavailable / -32603 internal
const RETRYABLE_RPC = new Set([-32005, -32004, -32014, -32603, -32429]);

export function createRpcClient(options: RpcClientOptions): RpcClient {
  const network = networkOfUrl(options.url);
  if (!network) throw new RpcError("refused", "createRpcClient", `endpoint not allowed (Helius or localhost:8899 only): ${options.url}`);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 4;
  const base = options.backoffBaseMs ?? 250;
  const cap = options.backoffMaxMs ?? 8_000;
  const maxRetryAfter = options.maxRetryAfterMs ?? 30_000;
  let rps = options.maxRps ?? DEFAULT_RPS[network];
  if (network === "mainnet") rps = Math.min(rps, MAINNET_MAX_RPS);
  if (!(rps > 0)) throw new RpcError("refused", "createRpcClient", "maxRps must be positive");
  const interval = 1000 / rps;
  const useCache = options.cache !== false;
  const cache = new Map<string, Promise<unknown>>();
  const stats: RpcStats = { requests: 0, retries: 0, cacheHits: 0, rateLimited: 0 };
  let nextSlot = 0;
  let nextId = 1;

  // Start-time spacing: request k may start no earlier than interval after request k-1.
  async function takeSlot(): Promise<void> {
    const t = now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + interval;
    if (at > t) await sleep(at - t);
  }

  function backoff(attempt: number): number {
    const exp = Math.min(cap, base * 2 ** attempt);
    return Math.round(exp / 2 + (exp / 2) * random());
  }

  async function attemptOnce(method: string, params: RpcParams): Promise<{ ok: true; value: unknown } | { ok: false; error: RpcError; retryable: boolean; waitMs?: number }> {
    await takeSlot();
    stats.requests++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await doFetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (timedOut) return { ok: false, error: new RpcError("timeout", method, `no response within ${timeoutMs} ms`), retryable: true };
      return { ok: false, error: new RpcError("network", method, (e as Error)?.message ?? String(e)), retryable: true };
    }
    try {
      if (res.status === 429) {
        stats.rateLimited++;
        const ra = parseRetryAfter(res.headers.get("retry-after"), now());
        return { ok: false, error: new RpcError("rate_limited", method, "HTTP 429", { status: 429 }), retryable: ra === null || ra <= maxRetryAfter, waitMs: ra ?? undefined };
      }
      if (!res.ok) {
        const ra = parseRetryAfter(res.headers.get("retry-after"), now());
        return { ok: false, error: new RpcError("http", method, `HTTP ${res.status}`, { status: res.status }), retryable: RETRYABLE_HTTP.has(res.status), waitMs: ra ?? undefined };
      }
      let body: { result?: unknown; error?: { code?: number; message?: string } };
      try {
        body = (await res.json()) as typeof body;
      } catch (e) {
        if (timedOut) return { ok: false, error: new RpcError("timeout", method, `no response within ${timeoutMs} ms`), retryable: true };
        return { ok: false, error: new RpcError("bad_response", method, `invalid JSON (${(e as Error).message})`), retryable: true };
      }
      if (body && typeof body === "object" && body.error) {
        const code = typeof body.error.code === "number" ? body.error.code : undefined;
        return { ok: false, error: new RpcError("rpc", method, `${code ?? "?"} ${body.error.message ?? "error"}`, { rpcCode: code }), retryable: code !== undefined && RETRYABLE_RPC.has(code) };
      }
      if (!body || typeof body !== "object" || !("result" in body)) {
        return { ok: false, error: new RpcError("bad_response", method, "response has no result"), retryable: false };
      }
      return { ok: true, value: body.result };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(method: string, params: RpcParams): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const r = await attemptOnce(method, params);
      if (r.ok) return r.value;
      if (!r.retryable || attempt >= maxRetries) {
        r.error.attempts = attempt + 1;
        throw r.error;
      }
      stats.retries++;
      if (r.waitMs !== undefined) {
        // Retry-After pauses every caller of this client, not only this request.
        nextSlot = Math.max(nextSlot, now() + Math.max(r.waitMs, base));
      } else {
        await sleep(backoff(attempt));
      }
    }
  }

  return {
    network,
    endpoint: redactUrl(options.url),
    stats,
    call<T>(method: string, params: RpcParams = []): Promise<T> {
      if (!ALLOWED_METHODS.has(method)) return Promise.reject(new RpcError("refused", method, "method not allowed (the engine never submits or signs)"));
      if (!useCache || UNCACHEABLE.has(method)) return send(method, params) as Promise<T>;
      const key = cacheKey(method, params);
      const hit = cache.get(key);
      if (hit) {
        stats.cacheHits++;
        return hit as Promise<T>;
      }
      const p = send(method, params);
      cache.set(key, p);
      p.catch(() => cache.delete(key)); // never cache failures
      return p as Promise<T>;
    },
    clearCache() {
      cache.clear();
    }
  };
}
