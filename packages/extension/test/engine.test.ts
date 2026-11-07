// X6: the real engine in the service worker. Uses the real Squads approval executed on localnet
// (fixtures, e2e role l3-batch) with an injected RPC client, so no network is touched.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingestSession, type RpcClient } from "@kelvara/core";
import { validateWorkerVerdict, type SignRequest } from "../src/shared/protocol.js";
import { createRealEngine, walletFor } from "../src/sw/engine.js";
import { buildRegistry } from "../src/sw/registry.js";
import { decide, messageHashes, type Settings, type Sha256 } from "../src/sw/policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = (JSON.parse(readFileSync(path.join(ROOT, "fixtures/tx/manifest.json"), "utf8")) as { fixtures: { path: string; e2e?: string }[] }).fixtures;
const fixture = (role: string) => {
  const e = manifest.find((m) => m.e2e === role);
  if (!e) throw new Error(`no ${role} fixture`);
  return JSON.parse(readFileSync(path.join(ROOT, "fixtures", e.path), "utf8")) as { transaction: string; network: string };
};
const squads = fixture("l3-batch");
const nodeSha256: Sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());
const unlicensed = async () => false;

const req = (over: Partial<SignRequest> = {}): SignRequest => ({
  v: 1,
  kind: "sign",
  id: "b".repeat(32),
  method: "solana:signTransaction",
  wallet: "W",
  account: null,
  chain: "solana:localnet",
  txs: [squads.transaction],
  ...over
});
const settings: Settings = { network: "devnet", passThrough: false };

/** An RPC client whose every call fails: the engine must report "not read", never "safe". */
function deadRpc(network: RpcClient["network"] = "localnet", hang = false): RpcClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    network,
    endpoint: "http://localhost:8899",
    stats: { requests: 0, retries: 0, cacheHits: 0, rateLimited: 0 },
    calls,
    call<T>(method: string): Promise<T> {
      calls.push(method);
      return hang ? new Promise<T>(() => {}) : Promise.reject(new Error("connection refused https://devnet.helius-rpc.com/?api-key=SECRET"));
    },
    clearCache() {}
  };
}

describe("bundled registry", () => {
  it("builds the CLI's registry from the IDL manifest, with Squads and the demo program as authority maps", () => {
    const reg = buildRegistry();
    const ids = reg.authorityMaps.map((m) => m.programId);
    expect(ids).toContain("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
    expect(ids).toContain("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
    expect(ids.length).toBe(3); // squads, drift, marginfi demo
    expect(reg.squadsAccounts).toBeTruthy();
  });
});

describe("walletFor (connected account, never inferred)", () => {
  it("uses the account only when it is a required signer of the request", async () => {
    const session = await ingestSession([{ base64: squads.transaction, kind: "wire" }]);
    const signer = session.transactions[0]!.signatures[0]!.signer;
    expect(walletFor(req({ account: signer }), session)).toBe(signer);
    expect(walletFor(req({ account: "EZwZ2ZSo4E42DFwuvk4HuGUFCnkKom9e7ex7EBuCBd7o" }), session)).toBeUndefined();
    expect(walletFor(req({ account: null }), session)).toBeUndefined();
  });
});

describe("real engine in decide()", () => {
  it("analyzes the real Squads approval: durable nonce + unknown proposal holds at L2 even with every read failing", async () => {
    const rpc = deadRpc();
    const engine = createRealEngine({ rpcFor: () => rpc });
    const v = await decide(req(), settings, engine, nodeSha256, async () => true);
    expect(validateWorkerVerdict(v)).not.toBeNull();
    expect(v).toMatchObject({ allow: false, hold: true, level: 2 });
    expect(v.report!.messageHashes).toEqual(await messageHashes([squads.transaction], nodeSha256));
    expect(v.report!.limited).toBe(false);
    expect(v.report!.claims.map((c) => c.text).join(" ")).toMatch(/Rule lifetime.durable_nonce, L2/);
    expect(rpc.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(v)).not.toContain("SECRET");
  });

  it("times out closed: a hanging RPC blocks with a fixed reason", async () => {
    const engine = createRealEngine({ rpcFor: () => deadRpc("localnet", true), timeoutMs: 50 });
    const v = await decide(req(), settings, engine, nodeSha256, unlicensed);
    expect(v).toMatchObject({ allow: false, hold: false, level: null });
    expect(v.reason).toMatch(/engine timed out/);
    expect(v.report!.title).toMatch(/could not be analyzed/);
  });

  it("an RPC client that cannot start blocks, and nothing from its error (URL, key) is shown", async () => {
    const engine = createRealEngine({
      rpcFor: () => {
        throw new Error("endpoint not allowed: https://devnet.helius-rpc.com/?api-key=SECRET");
      }
    });
    const v = await decide(req({ chain: "solana:devnet" }), { ...settings, heliusApiKey: "SECRET-KEY-0123456789" }, engine, nodeSha256, unlicensed);
    expect(v).toMatchObject({ allow: false, hold: false, level: null, reason: "engine error: could not start the analysis" });
    expect(JSON.stringify(v)).not.toMatch(/SECRET|api-key/);
  });

  it("bytes the engine cannot parse block", async () => {
    const engine = createRealEngine({ rpcFor: () => deadRpc() });
    const v = await decide(req({ txs: ["AQID"] }), settings, engine, nodeSha256, unlicensed);
    expect(v.allow).toBe(false);
    expect(v.hold).toBe(false);
  });

  it("a report for other bytes than the worker hashed is refused", async () => {
    const engine = createRealEngine({ rpcFor: () => deadRpc() });
    const endpoint = { ok: true as const, network: "localnet" as const, url: "http://localhost:8899" };
    await expect(engine.analyze(req(), endpoint, ["1111"])).rejects.toThrow(/different transactions/);
    await expect(engine.analyze(req(), endpoint)).rejects.toThrow(/no message hashes/);
  });

  it("no Helius key on devnet: blocked before any RPC, and the report says to add a key", async () => {
    let started = 0;
    const engine = createRealEngine({ rpcFor: () => (started++, deadRpc("devnet")) });
    const v = await decide(req({ chain: "solana:devnet" }), settings, engine, nodeSha256, unlicensed);
    expect(started).toBe(0);
    expect(v).toMatchObject({ allow: false, level: null });
    expect(v.report!.summary).toMatch(/no Helius API key/);
  });
});
