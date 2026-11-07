// X2 review fixes: storage failures fail closed, the key is never shown, 429 copy.
import { describe, expect, it } from "vitest";
import { READ_FAILED, loadView, removeKey, saveSettings, testConnection, type Store } from "../src/options/actions.js";
import { pickEndpoint } from "../src/sw/endpoint.js";
import { GENESIS, probeEndpoint, scrub, type FetchLike } from "../src/sw/probe.js";
import { loadSettings } from "../src/sw/settings.js";

const KEY = "0123abcd-4567-89ef-0123-456789abcdef"; // shape of a Helius key, not a real one

function memStore(init: Record<string, unknown> = {}, fail: Partial<Record<"get" | "set" | "remove", boolean>> = {}) {
  const data: Record<string, unknown> = { ...init };
  const store: Store = {
    async get(keys) {
      if (fail.get) throw new Error("storage get failed");
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      if (fail.set) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(data, items);
    },
    async remove(keys) {
      if (fail.remove) throw new Error("storage remove failed");
      for (const k of [keys].flat()) delete data[k];
    }
  };
  return { store, data };
}

function fakeFetch(status: number, body: unknown, seen: string[] = []): FetchLike {
  return async (url, init) => {
    seen.push(url + " " + init.body);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

describe("storage errors fail closed", () => {
  it("service worker: unreadable settings -> blocked, never defaults", async () => {
    const r = await loadSettings(async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/blocked/) });
    expect(await loadSettings(async () => ({ heliusApiKey: KEY }))).toMatchObject({ ok: true, settings: { heliusApiKey: KEY } });
  });
  it("options load: unreadable settings -> says held and blocked, not loaded", async () => {
    const v = await loadView(memStore({}, { get: true }).store);
    expect(v).toEqual({ network: "mainnet", status: READ_FAILED, loaded: false });
    expect(v.status).toMatch(/held and blocked/);
  });
  it("save failure: no 'Saved', key field kept, nothing written", async () => {
    const { store, data } = memStore({}, { set: true });
    const o = await saveSettings(store, KEY, "devnet");
    expect(o.kind).toBe("err");
    expect(o.text).toMatch(/Could not save/);
    expect(o.text).not.toMatch(/^Saved/);
    expect(o.clearField).toBe(false);
    expect(o.text).not.toContain(KEY);
    expect(data).toEqual({});
  });
  it("save success clears the field", async () => {
    const { store, data } = memStore();
    expect(await saveSettings(store, ` ${KEY} `, "devnet")).toEqual({ text: "Saved.", kind: "ok", clearField: true });
    expect(data).toEqual({ heliusApiKey: KEY, network: "devnet" });
  });
  it("remove failure: says the key may still be saved", async () => {
    const { store, data } = memStore({ heliusApiKey: KEY }, { remove: true });
    const o = await removeKey(store);
    expect(o).toMatchObject({ kind: "err", clearField: false });
    expect(o.text).toMatch(/may still be saved/);
    expect(data.heliusApiKey).toBe(KEY);
  });
  it("test with unreadable saved key: no request sent", async () => {
    const seen: string[] = [];
    const o = await testConnection(memStore({}, { get: true }).store, "", "mainnet", fakeFetch(200, {}, seen));
    expect(o.kind).toBe("err");
    expect(seen).toHaveLength(0);
  });
  it("test with a typed key does not need storage", async () => {
    const o = await testConnection(memStore({}, { get: true }).store, KEY, "mainnet", fakeFetch(200, { result: GENESIS.mainnet }));
    expect(o.kind).toBe("ok");
  });
});

describe("the raw key is never shown", () => {
  const ep = pickEndpoint("solana:mainnet", "mainnet", KEY);
  it("scrub removes api-key= and bare copies", () => {
    expect(scrub(`x https://mainnet.helius-rpc.com/?api-key=${KEY} y`, KEY)).not.toContain(KEY);
    expect(scrub(`invalid key ${KEY}`, KEY)).toBe("invalid key REDACTED");
    expect(scrub("a".repeat(1000), KEY).length).toBeLessThanOrEqual(301);
  });
  it("bare key echoed in a thrown error", async () => {
    const r = await probeEndpoint(ep, async () => {
      throw new Error(`bad token ${KEY}`);
    });
    expect(r.message).not.toContain(KEY);
  });
  it("bare key echoed in an RPC error body", async () => {
    const r = await probeEndpoint(ep, fakeFetch(200, { error: { message: `key ${KEY} is not allowed` } }));
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(KEY);
  });
  it("key echoed in the result field (wrong cluster path)", async () => {
    const r = await probeEndpoint(ep, fakeFetch(200, { result: `genesis-${KEY}` }));
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(KEY);
  });
  it("every Test outcome text is key-free", async () => {
    const { store } = memStore({ heliusApiKey: KEY });
    for (const [status, body] of [
      [200, { result: GENESIS.mainnet }],
      [401, {}],
      [429, {}],
      [500, {}],
      [200, { error: { message: KEY } }]
    ] as const) {
      const o = await testConnection(store, "", "mainnet", fakeFetch(status, body));
      expect(o.text).not.toContain(KEY);
    }
  });
});

describe("HTTP 429 copy", () => {
  it("does not claim the key works", async () => {
    const r = await probeEndpoint(pickEndpoint("solana:mainnet", "mainnet", KEY), fakeFetch(429, {}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTP 429/);
    expect(r.message).toMatch(/could not be checked/);
    expect(r.message).not.toMatch(/key works|key accepted/i);
  });
});
