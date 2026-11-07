/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// Shared setup for rules-*.test.ts: the manifest decoder, real fixtures, recorded state replay.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RootNode } from "@codama/nodes";
import {
  analyzeSession,
  createDecoder,
  createRpcAccountReader,
  createRpcClient,
  createSquadsDecoder,
  findAccountOrigin,
  readNonceAccount,
  readSquadsAccount,
  ingestSession,
  ReportBuilder,
  runRules,
  validateReport,
  type AnchorIdlJson,
  type Report,
  type RuleState,
  type Session
} from "../src/index.js";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "../../..");
export const json = <T = any>(p: string): T => JSON.parse(readFileSync(path.join(root, p), "utf8")) as T;

const manifest = json<{ idls: { name: string; programId: string; format: string }[] }>("packages/idls/manifest.json");
export const decoder = createDecoder(
  manifest.idls.map((e) => ({
    name: e.name,
    programId: e.programId,
    root: json<RootNode>(`packages/idls/roots/${e.name}.json`),
    ...(e.format.startsWith("anchor") ? { idl: json<AnchorIdlJson>(`packages/idls/raw/${e.name}.json`) } : {})
  }))
);
export const squadsAccounts = createSquadsDecoder(json<AnchorIdlJson>("packages/idls/raw/squads-v4.json"));

export const DRIFT_1 = "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H";
export const DRIFT_2 = "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1";
export const driftTx = (sig: string): string => json<{ transaction: string }>(`fixtures/tx/drift-replay/${sig}.json`).transaction;

/** Every manifest fixture: path and base64 wire bytes (with the runtime's loaded addresses). */
export function manifestFixtures(): { path: string; slug: string; base64: string; loaded: { writable: string[]; readonly: string[] } | null }[] {
  const m = json<{ fixtures: { path: string; slug: string }[] }>("fixtures/tx/manifest.json");
  return m.fixtures.map((f) => {
    const fx = json<{ transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } }>(`fixtures/${f.path}`);
    return { path: f.path, slug: f.slug, base64: fx.transaction, loaded: fx.meta.loadedAddresses ?? null };
  });
}

export interface RuleFixture {
  signature: string;
  why: string;
  transaction: string;
}
export const ruleFixtures = json<{ transactions: RuleFixture[] }>("packages/core/test/fixtures/rules/mainnet-squads.json").transactions;
export const ruleFixture = (prefix: string): RuleFixture => ruleFixtures.find((f) => f.signature.startsWith(prefix))!;

export interface Recording {
  network: "mainnet" | "localnet";
  inputs: Record<string, any>;
  observed: Record<string, any>;
  calls: { method: string; params: unknown; result: unknown }[];
}
export const recording = (name: "mainnet.json" | "localnet.json"): Recording => json<Recording>(`packages/core/test/fixtures/state/${name}`);

/** Replays recorded calls; an unrecorded request is an RPC error (never the network). */
export function replay(rec: Recording) {
  const map = new Map(rec.calls.map((c) => [`${c.method}:${JSON.stringify(c.params)}`, c.result]));
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown };
    const k = `${b.method}:${JSON.stringify(b.params)}`;
    if (!map.has(k)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "not recorded" } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: map.get(k) }), { status: 200 });
  }) as typeof fetch;
  const url = rec.network === "mainnet" ? "https://mainnet.helius-rpc.com/?api-key=replay" : "http://localhost:8899";
  const rpc = createRpcClient({ url, fetch: fetchFn, maxRps: 1000, sleep: async () => {} });
  return { rpc, reader: createRpcAccountReader(rpc) };
}

export async function sessionOf(base64s: string[]): Promise<Session> {
  return ingestSession(base64s.map((b) => ({ base64: b, kind: "wire" as const })));
}

export const analysisTiming = { rulesMs: 0, buildMs: 0, validateMs: 0 };

/** Runs all rules, validates the report (G4 checks) and returns it. */
export function analyze(session: Session, state: RuleState = {}): Report {
  const report = new ReportBuilder(session);
  const start = performance.now();
  runRules({ session, decoder, report, state });
  const ruled = performance.now();
  analysisTiming.rulesMs += ruled - start;
  const r = report.build();
  const built = performance.now();
  analysisTiming.buildMs += built - ruled;
  const v = validateReport(r);
  analysisTiming.validateMs += performance.now() - built;
  if (!v.ok) throw new Error(`invalid report: ${v.problems.join("; ")}`);
  return r;
}

export const byRule = (r: Report, ruleId: string) => r.claims.filter((c) => c.ruleId === ruleId);

/** Reads the state the rules use through the recorded calls (real RPC responses). */
export async function stateFrom(
  rec: Pick<Recording, "network" | "calls">,
  want: { nonces?: string[]; squads?: string[] }
): Promise<RuleState> {
  const { rpc, reader } = replay(rec as Recording);
  const state: RuleState & Required<Pick<RuleState, "nonces" | "squads">> = { nonces: {}, squads: {} };
  for (const n of want.nonces ?? []) {
    state.nonces[n] = { account: await readNonceAccount(reader, n), origin: await findAccountOrigin(rpc, n, { maxPages: 3 }), source: rec.network === "mainnet" ? "helius" : "rpc" };
  }
  for (const a of want.squads ?? []) {
    const acc = await readSquadsAccount(reader, squadsAccounts, a);
    state.squads[a] = { name: acc.name, data: acc.data };
  }
  return state;
}
export const rulesRecording = json<Pick<Recording, "network" | "calls"> & { observed: Record<string, any> }>("packages/core/test/fixtures/rules/mainnet-squads.json");

export type AnalyzeRecording = Recording & { inputs: { transactions: string[]; wallet?: string; [k: string]: any } };
export const analyzeRecording = (name: string): AnalyzeRecording => json<AnalyzeRecording>(`packages/core/test/fixtures/analyze/${name}.json`);

/** analyzeSession over a recorded real RPC run (fixtures/analyze): its report and the state it read, simulations included. */
export async function analyzedState(name: "admin-local" | "trap-local"): Promise<{ report: Report; state: RuleState; rec: AnalyzeRecording }> {
  const r = analyzeRecording(name);
  const { rpc } = replay(r);
  const out = await analyzeSession(await sessionOf(r.inputs.transactions), { decoder, squadsAccounts, rpc, ...(r.inputs.wallet ? { wallet: r.inputs.wallet } : {}) });
  return { report: out.report, state: out.state, rec: r };
}
