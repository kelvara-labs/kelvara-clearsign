/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// Replays the real Helius responses of fixtures/poison (scenarios S7) plus the engine's own recording
// (test/fixtures/poison/history.json) for readTransferHistory. getSignaturesForAddress is served by
// meaning, not by exact params: each address gets the newest-first list the recordings prove, cut at the
// analysis point (the fixture's `asOf`), and a page that would run past what was recorded is an RPC
// error, so the reader reports the history as incomplete instead of the replay inventing an end.
// Anything not recorded is an RPC error, unless `live` is given (the recorder only).
import { createPublicKey, verify } from "node:crypto";
import { createRpcClient, type RpcClient } from "../src/index.js";
import { fromBase58 } from "../src/util/encoding.js";

export interface Call { method: string; params: any; result: any }
export interface PoisonFixture {
  id: string;
  kind: "poisoning" | "first-send";
  network: "mainnet" | "devnet";
  user: string;
  recipient: string;
  lookalikeOf?: string;
  match?: { prefix: number; suffix: number };
  request: null | { signature: string; slot?: number } | string;
  history: { user: string; asOf: string; includesAnchor: boolean; signatures: { signature: string; slot: number; blockTime: number | null; err: unknown }[] };
  calls: Call[];
  [k: string]: any;
}

interface SigList { list: any[]; end: boolean }

/** The analysis point: anchor signature, its slot and block time (from the recorded getTransaction). */
export function anchorOf(fx: PoisonFixture): { signature: string; slot: number; blockTime: number } {
  const sig = fx.history.asOf;
  const tx = fx.calls.find((c) => c.method === "getTransaction" && c.params[0] === sig)?.result;
  if (!tx || typeof tx.blockTime !== "number") throw new Error(`${fx.id}: anchor ${sig} not recorded`);
  return { signature: sig, slot: tx.slot, blockTime: tx.blockTime };
}

export function poisonRpc(fx: PoisonFixture, extra: Call[], live?: (method: string, params: any) => Promise<any>): RpcClient {
  const anchor = anchorOf(fx);
  const all = [...fx.calls, ...extra];
  const lists = new Map<string, SigList>();
  // The user's recorded history list (anchor included only when the fixture says so) joins the recorded pages.
  const seed: Call = { method: "getSignaturesForAddress", params: [fx.user, { limit: Infinity }], result: fx.history.signatures };
  const lists2 = (address: string): SigList | null => {
    if (lists.has(address)) return lists.get(address)!;
    const calls = [...(address === fx.user ? [seed] : []), ...all.filter((c) => c.method === "getSignaturesForAddress" && c.params[0] === address)];
    if (!calls.length) return null;
    const seen = new Map<string, any>();
    let end = false;
    for (const c of calls) {
      for (const s of c.result) seen.set(s.signature, s);
      if (c.result.length < c.params[1].limit) end = true;
    }
    // Cut at the analysis point: nothing newer than the anchor; the anchor itself only if it is history.
    const list = [...seen.values()]
      .filter((s) => s.slot < anchor.slot || (s.slot === anchor.slot && (s.signature !== anchor.signature || fx.history.includesAnchor)))
      .sort((a, b) => b.slot - a.slot || (b.transactionIndex ?? 0) - (a.transactionIndex ?? 0));
    const r = { list, end };
    lists.set(address, r);
    return r;
  };
  const exact = new Map(all.map((c) => [`${c.method}:${JSON.stringify(c.params)}`, c.result]));
  const txs = new Map(all.filter((c) => c.method === "getTransaction").map((c) => [c.params[0] as string, c.result]));

  const answer = async (method: string, params: any): Promise<{ result?: any; error?: string }> => {
    if (method === "getSignaturesForAddress") {
      const [address, cfg] = params;
      const l = lists2(address);
      if (!l) return live ? { result: await live(method, params) } : { error: "not recorded" };
      const start = cfg.before ? l.list.findIndex((s) => s.signature === cfg.before) + 1 : 0;
      if (cfg.before && start === 0) return { error: "before not recorded" };
      const page = l.list.slice(start, start + cfg.limit);
      if (page.length < cfg.limit && !l.end) return { error: "page runs past the recorded history" };
      return { result: page };
    }
    if (method === "getTransaction") {
      if (txs.has(params[0])) return { result: txs.get(params[0]) };
      return live ? { result: await live(method, params) } : { error: "not recorded" };
    }
    const k = `${method}:${JSON.stringify(params)}`;
    if (exact.has(k)) return { result: exact.get(k) };
    return live ? { result: await live(method, params) } : { error: "not recorded" };
  };
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: number; method: string; params: any };
    const a = await answer(b.method, b.params);
    const body = a.error !== undefined ? { jsonrpc: "2.0", id: b.id, error: { code: -32602, message: a.error } } : { jsonrpc: "2.0", id: b.id, result: a.result };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const host = fx.network === "mainnet" ? "mainnet.helius-rpc.com" : "devnet.helius-rpc.com";
  return createRpcClient({ url: `https://${host}/?api-key=replay`, fetch: fetchFn, maxRps: 1000, sleep: async () => {} });
}

/** compact-u16 (shortvec) length prefix. */
const shortvec = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (!n) return [...out, b];
    out.push(b | 0x80);
  }
};

/**
 * Wire bytes of the fixture's executed request: the stored base64 when the tx is also a tx fixture, or
 * the legacy message re-serialized from the recorded getTransaction (json). The first signature is then
 * verified with Ed25519 against the re-serialized message, so the bytes are exactly what was signed.
 */
export function requestWire(fx: PoisonFixture, readFixture: (p: string) => any): string {
  const req = typeof fx.request === "object" && fx.request ? fx.request : null;
  if (!req) throw new Error(`${fx.id}: no request`);
  if (req.txFixture) return readFixture(`fixtures/${req.txFixture}`).transaction as string;
  const t = fx.calls.find((c) => c.method === "getTransaction" && c.params[0] === req.signature)?.result;
  if (!t || t.version !== "legacy") throw new Error(`${fx.id}: request is not a recorded legacy tx`);
  const m = t.transaction.message;
  const msg = Buffer.from([
    m.header.numRequiredSignatures, m.header.numReadonlySignedAccounts, m.header.numReadonlyUnsignedAccounts,
    ...shortvec(m.accountKeys.length), ...m.accountKeys.flatMap((k: string) => [...fromBase58(k)]),
    ...fromBase58(m.recentBlockhash),
    ...shortvec(m.instructions.length),
    ...m.instructions.flatMap((ix: any) => {
      const data = [...fromBase58(ix.data)];
      return [ix.programIdIndex, ...shortvec(ix.accounts.length), ...ix.accounts, ...shortvec(data.length), ...data];
    })
  ]);
  const sigs: string[] = t.transaction.signatures;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(fromBase58(m.accountKeys[0]))]);
  const ok = verify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(fromBase58(sigs[0]!)));
  if (!ok) throw new Error(`${fx.id}: re-serialized message does not verify against the recorded signature`);
  return Buffer.concat([Buffer.from(shortvec(sigs.length)), ...sigs.map((s) => Buffer.from(fromBase58(s))), msg]).toString("base64");
}
