// Endpoint check for the options page's Test button. One JSON-RPC call
// (getGenesisHash) tells us the endpoint answers, the key is accepted, and the
// cluster is the one the user picked. The key is never shown: every message,
// success or failure, goes through scrub(), which removes `api-key=...` and any
// bare copy of the key (an error text or RPC body may echo it without the prefix).
import { redactUrl, type Endpoint, type Network } from "./endpoint.js";

const MAX_MESSAGE = 300;

function keyOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("api-key") || undefined;
  } catch {
    return undefined;
  }
}

/** Remove the key from text shown to the user. Exported for tests. */
export function scrub(text: string, key: string | undefined): string {
  let s = redactUrl(text);
  if (key) {
    for (const form of new Set([key, encodeURIComponent(key)])) s = s.split(form).join("REDACTED");
  }
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s;
}

export const GENESIS: Record<"mainnet" | "devnet", string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
};

export interface ProbeResult {
  ok: boolean;
  network: Network | null;
  message: string;
  ms: number | null;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function probeEndpoint(
  endpoint: Endpoint,
  fetchFn: FetchLike,
  opts: { timeoutMs?: number; now?: () => number } = {}
): Promise<ProbeResult> {
  if (!endpoint.ok) return { ok: false, network: null, message: endpoint.reason, ms: null };
  const now = opts.now ?? (() => Date.now());
  const ctl = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000) : undefined;
  const start = now();
  const { network } = endpoint;
  const key = keyOf(endpoint.url);
  const done = (ok: boolean, message: string, ms: number): ProbeResult => ({ ok, network, message: scrub(message, key), ms });
  const fail = (message: string): ProbeResult => done(false, message, now() - start);
  try {
    const res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
      ...(ctl ? { signal: ctl.signal } : {})
    });
    if (res.status === 401 || res.status === 403) return fail(`Helius rejected the API key (HTTP ${res.status})`);
    // 429 says nothing about the key: Helius may rate-limit before checking it.
    if (res.status === 429)
      return fail("Helius is rate-limiting requests (HTTP 429), so the key could not be checked. Wait a minute and test again");
    if (!res.ok) return fail(`endpoint answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } } | null;
    if (body && body.error) return fail(`RPC error: ${String(body.error.message ?? "unknown")}`);
    const hash = body?.result;
    if (typeof hash !== "string") return fail("endpoint gave no genesis hash");
    const ms = now() - start;
    if (network === "localnet") return done(true, `localnet answered (genesis ${hash})`, ms);
    if (hash !== GENESIS[network]) return done(false, `endpoint is not ${network}: genesis ${hash}`, ms);
    return done(true, `Helius ${network} OK, key accepted`, ms);
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "AbortError") return fail("endpoint did not answer within the timeout");
    return fail(`could not reach the endpoint: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
