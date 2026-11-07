// E13: RPC client mechanics (timeouts, backoff, Retry-After, rate cap, cache, host and method allowlists).
// Transport behaviour is simulated with a stub fetch; no transaction or account data is invented here.
import { describe, expect, it } from "vitest";
import { createRpcClient, networkOfUrl, parseRetryAfter, redactUrl, RpcError, rpcUrlFor, MAINNET_MAX_RPS } from "../src/index.js";

const KEY = "test-key-0123456789";
const MAINNET = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const DEVNET = `https://devnet.helius-rpc.com/?api-key=${KEY}`;

type Reply = { status?: number; headers?: Record<string, string>; body?: unknown } | "hang" | Error;

function stub(replies: Reply[] | ((n: number, method: string) => Reply)) {
  const seen: { method: string; params: unknown; at: number }[] = [];
  const clock = { t: 0 };
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    seen.push({ method: body.method, params: body.params, at: clock.t });
    const r = typeof replies === "function" ? replies(seen.length - 1, body.method) : replies[seen.length - 1] ?? { body: { result: "default" } };
    if (r instanceof Error) throw r;
    if (r === "hang") {
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }
    return new Response(JSON.stringify(r.body ?? { jsonrpc: "2.0", id: 1, result: null }), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const virtual = {
    fetch: fetchFn,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0.5
  };
  return { seen, clock, sleeps, virtual };
}

const ok = (result: unknown): Reply => ({ body: { jsonrpc: "2.0", id: 1, result } });

describe("endpoints", () => {
  it("accepts only Helius mainnet/devnet and localhost:8899", () => {
    expect(networkOfUrl(MAINNET)).toBe("mainnet");
    expect(networkOfUrl(DEVNET)).toBe("devnet");
    expect(networkOfUrl("http://localhost:8899")).toBe("localnet");
    expect(networkOfUrl("http://127.0.0.1:8899/")).toBe("localnet");
    for (const bad of [
      "https://api.mainnet-beta.solana.com",
      "http://mainnet.helius-rpc.com/?api-key=x",
      "https://mainnet.helius-rpc.com.evil.io/",
      "https://evil.io/?u=https://mainnet.helius-rpc.com",
      "http://localhost:8080",
      "https://localhost:8899",
      "not a url"
    ]) {
      expect(networkOfUrl(bad), bad).toBeNull();
      expect(() => createRpcClient({ url: bad })).toThrow(RpcError);
    }
  });

  it("builds URLs per network, refuses Helius without a key and never gives localnet a key", () => {
    expect(rpcUrlFor("mainnet", KEY)).toBe(MAINNET);
    expect(rpcUrlFor("localnet", KEY)).toBe("http://localhost:8899");
    expect(() => rpcUrlFor("devnet", "  ")).toThrow(/no Helius API key/);
  });

  it("redacts the key from the endpoint and from every error", async () => {
    const s = stub(() => new Error(`connect failed for ${MAINNET}`));
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual, maxRetries: 1 });
    expect(rpc.endpoint).not.toContain(KEY);
    expect(redactUrl(`x ${MAINNET}&y=1`)).toBe("x https://mainnet.helius-rpc.com/?api-key=REDACTED&y=1");
    const err = await rpc.call("getSlot").catch((e: unknown) => e as RpcError);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("network");
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("api-key=REDACTED");
  });
});

describe("method allowlist", () => {
  it("refuses methods that submit or change state, without a request", async () => {
    const s = stub([]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    for (const m of ["sendTransaction", "requestAirdrop", "sendBundle", "foo"]) {
      await expect(rpc.call(m, [])).rejects.toMatchObject({ code: "refused" });
    }
    expect(s.seen).toHaveLength(0);
  });
});

describe("retries", () => {
  it("times out a hung request, retries, then succeeds", async () => {
    const s = stub(["hang", ok(42)]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual, timeoutMs: 20 });
    await expect(rpc.call("getSlot")).resolves.toBe(42);
    expect(s.seen).toHaveLength(2);
    expect(rpc.stats.retries).toBe(1);
  });

  it("gives up after maxRetries timeouts with code timeout", async () => {
    const s = stub(() => "hang");
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual, timeoutMs: 10, maxRetries: 2 });
    await expect(rpc.call("getSlot")).rejects.toMatchObject({ code: "timeout", attempts: 3 });
    expect(s.seen).toHaveLength(3);
  });

  it("backs off exponentially on 5xx and network errors", async () => {
    const s = stub([{ status: 503 }, new Error("ECONNRESET"), { status: 502 }, ok("done")]);
    const rpc = createRpcClient({ url: DEVNET, ...s.virtual, backoffBaseMs: 100, maxRps: 1000 });
    await expect(rpc.call("getSlot")).resolves.toBe("done");
    // random() = 0.5 -> 3/4 of base * 2^attempt; sleeps of <= 1 ms are rate-cap spacing.
    expect(s.sleeps.filter((ms) => ms > 1)).toEqual([75, 150, 300]);
    const gaps = s.seen.slice(1).map((c, i) => c.at - s.seen[i]!.at);
    expect(gaps[0]).toBeGreaterThanOrEqual(75);
    expect(gaps[1]).toBeGreaterThanOrEqual(150);
    expect(gaps[2]).toBeGreaterThanOrEqual(300);
  });

  it("honours Retry-After on 429 (seconds) and pauses the whole client", async () => {
    const s = stub([{ status: 429, headers: { "retry-after": "2" } }, ok(1), ok(2)]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    await expect(rpc.call("getSlot")).resolves.toBe(1);
    expect(s.seen[1]!.at - s.seen[0]!.at).toBeGreaterThanOrEqual(2000);
    expect(rpc.stats.rateLimited).toBe(1);
  });

  it("parses Retry-After as seconds or HTTP date", () => {
    expect(parseRetryAfter("1", 0)).toBe(1000);
    expect(parseRetryAfter("0.5", 0)).toBe(500);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });

  it("does not wait out an absurd Retry-After", async () => {
    const s = stub([{ status: 429, headers: { "retry-after": "3600" } }]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    await expect(rpc.call("getSlot")).rejects.toMatchObject({ code: "rate_limited", attempts: 1 });
  });

  it("does not retry client errors or invalid params", async () => {
    const s = stub([{ body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } } }, { status: 401 }]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    await expect(rpc.call("getAccountInfo", ["x"])).rejects.toMatchObject({ code: "rpc", rpcCode: -32602, attempts: 1 });
    await expect(rpc.call("getAccountInfo", ["y"])).rejects.toMatchObject({ code: "http", status: 401, attempts: 1 });
    expect(s.seen).toHaveLength(2);
  });

  it("retries a node-behind RPC error", async () => {
    const s = stub([{ body: { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Node is behind" } } }, ok(7)]);
    const rpc = createRpcClient({ url: DEVNET, ...s.virtual });
    await expect(rpc.call("getSlot")).resolves.toBe(7);
  });
});

describe("rate cap", () => {
  it("clamps mainnet to 8 rps even when asked for more", async () => {
    const s = stub(() => ok(1));
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual, maxRps: 50, cache: false });
    for (let i = 0; i < 25; i++) await rpc.call("getSlot");
    const ats = s.seen.map((c) => c.at);
    for (let i = 0; i < ats.length; i++) {
      const inWindow = ats.filter((t) => t >= ats[i]! && t < ats[i]! + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(MAINNET_MAX_RPS);
    }
    expect(ats[24]! - ats[0]!).toBeGreaterThanOrEqual((24 * 1000) / MAINNET_MAX_RPS);
  });

  it("spaces concurrent callers (real timers)", async () => {
    const s = stub(() => ok(1));
    const starts: number[] = [];
    const rpc = createRpcClient({
      url: DEVNET,
      maxRps: 50,
      cache: false,
      fetch: (async (u: unknown, init?: RequestInit) => {
        starts.push(performance.now());
        return s.virtual.fetch(u as string, init);
      }) as typeof fetch
    });
    await Promise.all(Array.from({ length: 8 }, () => rpc.call("getSlot")));
    starts.sort((a, b) => a - b);
    expect(starts[7]! - starts[0]!).toBeGreaterThanOrEqual(7 * 20 - 5);
  });
});

describe("per-session cache", () => {
  it("serves repeated reads from the cache and dedupes in-flight calls", async () => {
    const s = stub(() => ok({ value: "acc" }));
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    const p = ["A", { encoding: "base64" }];
    const [a, b] = await Promise.all([rpc.call("getAccountInfo", p), rpc.call("getAccountInfo", p)]);
    await rpc.call("getAccountInfo", p);
    expect(a).toEqual(b);
    expect(s.seen).toHaveLength(1);
    expect(rpc.stats.cacheHits).toBe(2);
    await rpc.call("getAccountInfo", ["B", { encoding: "base64" }]);
    expect(s.seen).toHaveLength(2);
    rpc.clearCache();
    await rpc.call("getAccountInfo", p);
    expect(s.seen).toHaveLength(3);
  });

  it("never caches simulations, blockhashes or failures", async () => {
    const s = stub([ok(1), ok(2), ok(3), ok(4), { body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } } }, ok("now ok")]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    expect(await rpc.call("simulateTransaction", ["tx"])).toBe(1);
    expect(await rpc.call("simulateTransaction", ["tx"])).toBe(2);
    expect(await rpc.call("getLatestBlockhash")).toBe(3);
    expect(await rpc.call("getLatestBlockhash")).toBe(4);
    await expect(rpc.call("getAccountInfo", ["X"])).rejects.toBeInstanceOf(RpcError);
    expect(await rpc.call("getAccountInfo", ["X"])).toBe("now ok");
  });

  it("can be turned off", async () => {
    const s = stub(() => ok(1));
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual, cache: false });
    await rpc.call("getAccountInfo", ["A"]);
    await rpc.call("getAccountInfo", ["A"]);
    expect(s.seen).toHaveLength(2);
  });
});

describe("bad responses", () => {
  it("rejects a body without result", async () => {
    const s = stub([{ body: { jsonrpc: "2.0", id: 1 } }]);
    const rpc = createRpcClient({ url: MAINNET, ...s.virtual });
    await expect(rpc.call("getSlot")).rejects.toMatchObject({ code: "bad_response" });
  });
});
