import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keyForTest, keyStatus, planSave } from "../src/options/form.js";
import { pickEndpoint } from "../src/sw/endpoint.js";
import { GENESIS, probeEndpoint, type FetchLike } from "../src/sw/probe.js";
import { readSettings } from "../src/sw/settings.js";

const KEY = "0123abcd-4567-89ef-0123-456789abcdef"; // shape of a Helius key, not a real one

function fakeFetch(status: number, body: unknown, seen: string[] = []): FetchLike {
  return async (url, init) => {
    seen.push(url + " " + init.body);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

describe("settings", () => {
  it("defaults to mainnet and drops malformed keys (held, never spliced into a URL)", () => {
    expect(readSettings({ passThrough: true }).passThrough).toBe(false);
    expect(readSettings({})).toEqual({ heliusApiKey: undefined, network: "mainnet", passThrough: false });
    expect(readSettings({ network: "testnet", heliusApiKey: "x&y=1" }).heliusApiKey).toBeUndefined();
    expect(readSettings({ heliusApiKey: "https://mainnet.helius-rpc.com/?api-key=" + KEY }).heliusApiKey).toBeUndefined();
    expect(readSettings({ network: "localnet", heliusApiKey: ` ${KEY} ` })).toMatchObject({ network: "localnet", heliusApiKey: KEY });
  });
  it("a malformed stored key leaves mainnet/devnet requests without an endpoint", () => {
    const s = readSettings({ heliusApiKey: "bad key" });
    expect(pickEndpoint("solana:devnet", s.network, s.heliusApiKey).ok).toBe(false);
  });
});

describe("options form", () => {
  it("save: empty key field keeps the saved key, typed key is validated", () => {
    expect(planSave({ keyField: "  ", network: "devnet" })).toEqual({ ok: true, patch: { network: "devnet" } });
    expect(planSave({ keyField: KEY, network: "mainnet" })).toEqual({ ok: true, patch: { heliusApiKey: KEY, network: "mainnet" } });
    expect(planSave({ keyField: "not a key", network: "mainnet" }).ok).toBe(false);
    expect(planSave({ keyField: KEY, network: "testnet" }).ok).toBe(false);
  });
  it("test uses the typed key, else the saved one", () => {
    expect(keyForTest("", KEY)).toBe(KEY);
    expect(keyForTest(KEY, "zzzzzzzzzzzzzzzzzzzz")).toBe(KEY);
    expect(keyForTest("", undefined)).toBeUndefined();
  });
  it("status never echoes the key", () => {
    expect(keyStatus(KEY)).not.toContain(KEY.slice(-4));
    expect(keyStatus(undefined)).toMatch(/held and blocked/);
  });
});

describe("endpoint probe (Test button)", () => {
  it("mainnet: genesis matches -> OK, sends getGenesisHash", async () => {
    const seen: string[] = [];
    const r = await probeEndpoint(pickEndpoint("solana:mainnet", "mainnet", KEY), fakeFetch(200, { result: GENESIS.mainnet }, seen));
    expect(r).toMatchObject({ ok: true, network: "mainnet" });
    expect(seen[0]).toContain("getGenesisHash");
  });
  it("devnet key against wrong cluster -> not OK", async () => {
    const r = await probeEndpoint(pickEndpoint("solana:devnet", "devnet", KEY), fakeFetch(200, { result: GENESIS.mainnet }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not devnet/);
  });
  it("401 -> key rejected", async () => {
    const r = await probeEndpoint(pickEndpoint("solana:mainnet", "mainnet", KEY), fakeFetch(401, {}));
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the API key/) });
  });
  it("network error message is redacted", async () => {
    const boom: FetchLike = async (url) => {
      throw new Error(`failed to fetch ${url}`);
    };
    const r = await probeEndpoint(pickEndpoint("solana:mainnet", "mainnet", KEY), boom);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(KEY);
    expect(r.message).toContain("api-key=REDACTED");
  });
  it("RPC error body and missing result are failures", async () => {
    const ep = pickEndpoint("solana:mainnet", "mainnet", KEY);
    expect((await probeEndpoint(ep, fakeFetch(200, { error: { message: "nope" } }))).ok).toBe(false);
    expect((await probeEndpoint(ep, fakeFetch(200, {}))).ok).toBe(false);
  });
  it("no key: says so without calling fetch", async () => {
    const seen: string[] = [];
    const r = await probeEndpoint(pickEndpoint("solana:mainnet", "mainnet", undefined), fakeFetch(200, {}, seen));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no Helius API key/);
    expect(seen).toHaveLength(0);
  });
  it("localnet: any genesis is fine, no key needed", async () => {
    const seen: string[] = [];
    const r = await probeEndpoint(pickEndpoint("solana:localnet", "mainnet", undefined), fakeFetch(200, { result: "LocalGenesis111" }, seen));
    expect(r.ok).toBe(true);
    expect(seen[0]).toMatch(/^http:\/\/localhost:8899 /);
  });
});

describe("manifest", () => {
  const m = JSON.parse(readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"));
  it("permissions: storage + Helius hosts + localhost:8899 only, module SW, options page", () => {
    expect(m.permissions).toEqual(["storage"]);
    expect(m.host_permissions).toEqual([
      "https://mainnet.helius-rpc.com/*",
      "https://devnet.helius-rpc.com/*",
      "https://api.helius.xyz/*",
      "http://localhost:8899/*"
    ]);
    expect(m.optional_permissions ?? []).toEqual([]);
    expect(m.optional_host_permissions ?? []).toEqual([]);
    expect(m.background).toEqual({ service_worker: "service-worker.js", type: "module" });
    expect(m.options_ui).toEqual({ page: "options.html", open_in_tab: true });
  });
  it("options page loads only the bundled ui.js (no inline or remote script)", () => {
    const html = readFileSync(new URL("../static/options.html", import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((x) => x[0]);
    expect(scripts).toEqual(['<script type="module" src="ui.js">']);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
