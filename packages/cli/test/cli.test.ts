// E14: kelvara analyze / replay through main() with captured output. Real data only: the Drift fixtures,
// the recorded localnet G6 responses (packages/core/test/fixtures/analyze) served through rpcFor.
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createRpcClient, type RpcClient } from "@kelvara/core";
import { main, parseArgs, RESULT_KIND, type CliResult } from "../src/index.js";
import { inputsFromText } from "../src/io.js";
import { findRoot } from "../src/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DRIFT = [
  "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H",
  "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1"
];
const readJson = <T>(p: string): T => JSON.parse(readFileSync(path.join(root, p), "utf8")) as T;
const tmp = mkdtempSync(path.join(os.tmpdir(), "kelvara-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Recorded { network: "localnet" | "mainnet"; inputs: { transactions: string[]; wallet?: string; creator?: string }; calls: { method: string; params: unknown; result: unknown }[] }

/** Serves recorded calls; anything unrecorded is an RPC error, never the network. */
function recordedRpc(rec: Pick<Recorded, "network" | "calls">, extra: Record<string, unknown> = {}): RpcClient {
  const map = new Map(rec.calls.map((c) => [`${c.method}:${JSON.stringify(c.params)}`, c.result]));
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown };
    const k = `${b.method}:${JSON.stringify(b.params)}`;
    const hit = map.has(k) ? map.get(k) : extra[b.method];
    if (hit === undefined) return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "not recorded" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: hit }));
  }) as typeof fetch;
  const url = rec.network === "mainnet" ? "https://mainnet.helius-rpc.com/?api-key=test-secret-key" : "http://localhost:8899";
  return createRpcClient({ url, fetch: fetchFn, maxRps: 1000, sleep: async () => {} });
}

async function run(argv: string[], rpcFor?: () => RpcClient) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd: root, ...(rpcFor ? { rpcFor } : {}) });
  return { code, stdout, stderr };
}
const claimsOf = (r: CliResult, ruleId: string) => r.report.claims.filter((c) => c.ruleId === ruleId);

describe("kelvara replay", () => {
  it("cached Drift replay (the G8 command): critical, durable nonce, approve-and-execute, authority.transfer naming updateAdmin", async () => {
    const { code, stdout, stderr } = await run(["replay", "--json", ...DRIFT]);
    expect(code, stderr).toBe(0);
    const r = JSON.parse(stdout) as CliResult;
    expect(r).toMatchObject({ kind: RESULT_KIND, command: "replay", network: "mainnet", mode: "offline", level: "critical", alertLevel: "L3" });
    expect(claimsOf(r, "lifetime.durable_nonce").length).toBe(2);
    expect(claimsOf(r, "squads.approve_and_execute").length).toBe(1);
    expect(claimsOf(r, "authority.transfer").some((c) => /updateAdmin/.test(c.statement))).toBe(true);
    expect(r.inputs.map((i) => i.fixture)).toEqual(DRIFT.map((s) => `fixtures/tx/drift-replay/${s}.json`));
    expect(stderr).toContain("ALERT L3 Critical");
  });

  it("--live: fetched bytes must equal the stored fixture; the recorded Helius state adds the outsider-funded nonces", async () => {
    const rec = readJson<Recorded>("packages/core/test/fixtures/analyze/drift-replay-mainnet.json");
    const getTx = (sig: string) => {
      const f = readJson<{ slot: number; blockTime: number; version: string; transaction: string; meta: unknown }>(`fixtures/tx/drift-replay/${sig}.json`);
      return { slot: f.slot, blockTime: f.blockTime, version: f.version, transaction: [f.transaction, "base64"], meta: f.meta };
    };
    const calls = [...rec.calls, ...DRIFT.map((s) => ({ method: "getTransaction", params: [s, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], result: getTx(s) }))];
    const { code, stdout, stderr } = await run(["replay", "--live", "--json", ...DRIFT], () => recordedRpc({ network: "mainnet", calls }));
    expect(code, stderr).toBe(0);
    const r = JSON.parse(stdout) as CliResult;
    expect(r.mode).toBe("online");
    expect(r.level).toBe("critical");
    expect(claimsOf(r, "nonce.staged_by_outsider").every((c) => c.kind === "Fact" && c.level === "L3")).toBe(true);
    expect(stderr).toContain("live bytes match fixtures/tx/drift-replay/");
    expect(stdout + stderr).not.toContain("test-secret-key");
  });

  it("--live with bytes that differ from the stored fixture fails, and stores a new fixture only where none exists", async () => {
    const other = readJson<{ transaction: string }>(`fixtures/tx/drift-replay/${DRIFT[1]}.json`).transaction;
    const calls = [{ method: "getTransaction", params: [DRIFT[0], { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], result: { slot: 1, blockTime: 1, transaction: [other, "base64"], meta: null } }];
    const bad = await run(["replay", "--live", "--json", "--fixtures", tmp, DRIFT[0]!], () => recordedRpc({ network: "mainnet", calls }));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/stored bytes differ/);
    expect(existsSync(path.join(tmp, `${DRIFT[0]}.json`))).toBe(false);
  });

  it("missing cached fixture -> exit 1 with a hint; bad signature -> usage exit 2", async () => {
    const sig = "5".repeat(87);
    const miss = await run(["replay", sig]);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain("run with --live");
    const bad = await run(["replay", "not-a-signature"]);
    expect(bad.code).toBe(2);
  });
});

describe("kelvara analyze", () => {
  it("G6 admin approval on (recorded) localnet: critical with SetAuthority, durable nonce, outsider funder, zero time lock and the simulation line", async () => {
    const rec = readJson<Recorded>("packages/core/test/fixtures/analyze/admin-local.json");
    const file = path.join(tmp, "approval.unsigned.b64");
    (await import("node:fs")).writeFileSync(file, rec.inputs.transactions[0] + "\n");
    const out = path.join(tmp, "admin.json");
    const { code, stdout, stderr } = await run(["analyze", "--network", "localnet", "--out", out, file], () => recordedRpc(rec));
    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/^Kelvara ClearSign analyze {2}network localnet/);
    expect(stdout).toContain("ALERT L3 Critical");
    expect(stdout).toContain("Simulation shows: Transaction 0:");
    const r = JSON.parse(readFileSync(out, "utf8")) as CliResult;
    expect(r.level).toBe("critical");
    for (const id of ["authority.transfer", "lifetime.durable_nonce", "nonce.staged_by_outsider", "squads.zero_timelock_execution"]) expect(claimsOf(r, id).length, id).toBeGreaterThan(0);
    expect(claimsOf(r, "authority.transfer")[0]!.statement).toContain("setAuthority");
    expect(r.reads.every((x) => x.ok)).toBe(true);
  });

  it("G6 trap purchase with --wallet: L2 Warning (permanent delegate, freeze authority) and the simulated purchase", async () => {
    const rec = readJson<Recorded>("packages/core/test/fixtures/analyze/trap-local.json");
    const { code, stdout, stderr } = await run(["analyze", "--json", "--wallet", rec.inputs.wallet!, "--tx", rec.inputs.transactions[0]!], () => recordedRpc(rec));
    expect(code, stderr).toBe(0);
    const r = JSON.parse(stdout) as CliResult;
    expect(r).toMatchObject({ level: "warning", alertLevel: "L2", action: "hold" });
    expect(claimsOf(r, "token2022.permanent_delegate")[0]!.statement).toContain(rec.inputs.creator!);
    expect(claimsOf(r, "token.freeze_authority")[0]!.level).toBe("L2");
    expect(r.report.simulation.summary).toContain("+50000 of mint");
  });

  it("offline session from a JSON array of fixtures; without --wallet the note says what did not run", async () => {
    const file = path.join(tmp, "session.json");
    (await import("node:fs")).writeFileSync(file, JSON.stringify(DRIFT.map((s) => readJson(`fixtures/tx/drift-replay/${s}.json`))));
    const { code, stdout } = await run(["analyze", "--offline", "--network", "mainnet", file]);
    expect(code).toBe(0);
    expect(stdout).toContain("Note: no --wallet");
    expect(stdout).toContain("ALERT L3 Critical");
  });

  it("errors are redacted and exit 1; bad usage exits 2", async () => {
    const rpcFor = () => createRpcClient({ url: "https://mainnet.helius-rpc.com/?api-key=test-secret-key", fetch: (async () => { throw new Error("connect failed https://mainnet.helius-rpc.com/?api-key=test-secret-key"); }) as typeof fetch, maxRps: 1000, sleep: async () => {}, maxRetries: 0 });
    const r = await run(["replay", "--live", DRIFT[0]!], rpcFor);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("test-secret-key");
    expect((await run(["analyze"])).code).toBe(2);
    expect((await run(["analyze", "--network", "testnet", "x"])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
  });
});

describe("inputs and args", () => {
  it("parses base64 lines, fixtures, arrays and {transactions}", () => {
    const b = readJson<{ transaction: string }>(`fixtures/tx/drift-replay/${DRIFT[0]}.json`).transaction;
    expect(inputsFromText(`${b}\n${b}\n`, "f")).toHaveLength(2);
    expect(inputsFromText(JSON.stringify({ transaction: b, label: "x" }), "f")).toEqual([{ base64: b, label: "x" }]);
    expect(inputsFromText(JSON.stringify({ transactions: [b, { wireBase64: b }] }), "f")).toHaveLength(2);
    expect(() => inputsFromText("not base64!", "f")).toThrow(/not base64/);
    expect(() => inputsFromText("", "f")).toThrow(/empty/);
  });

  it("args", () => {
    const a = parseArgs(["analyze", "--network", "devnet", "--wallet", "696JqKtWrG8WYwdbFEShWVNrgASnJFwJ5cVt1zLKRzAU", "--no-simulate", "--idl", "x.json:MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", "a", "b"]);
    expect(a).toMatchObject({ cmd: "analyze", network: "devnet", simulate: false, idls: ["x.json:MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"], positional: ["a", "b"] });
    expect(() => parseArgs(["analyze", "--wallet", "nope"])).toThrow();
    expect(findRoot(path.join(root, "packages/cli"))).toBe(root);
  });
});
