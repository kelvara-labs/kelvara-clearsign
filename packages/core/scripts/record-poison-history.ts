// Records the real Helius responses readTransferHistory needs on top of fixtures/poison (S7): each
// poisoning recipient's signature list back to the 30-day window (or its first transaction), the
// transactions it shares with the user that S7 did not record, and the DAS getAssetBatch call for the
// mints involved. Output: packages/core/test/fixtures/poison/history.json ({ cases: { <id>: Call[] } }).
/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads */
// Usage: pnpm --filter @kelvara/core fixtures:poison-history   (reads HELIUS_API_KEY from the main checkout's .env)
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RootNode } from "@codama/nodes";
import {
  createDecoder,
  createRpcAccountReader,
  createRpcClient,
  HISTORY_DAYS,
  ingestSession,
  readAddressRuleState,
  readTokenRuleState,
  readTransferHistory,
  requestTransfers,
  rpcUrlFor,
  type AnchorIdlJson
} from "../src/index.js";
import { anchorOf, poisonRpc, requestWire, type Call, type PoisonFixture } from "../test/poison-replay.js";

const root = execSync("git rev-parse --show-toplevel").toString().trim();
const common = execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim();
const key = readFileSync(path.join(common, "..", ".env"), "utf8").match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(root, p), "utf8")) as T;

const idls = json<{ idls: { name: string; programId: string; format: string }[] }>("packages/idls/manifest.json");
const decoder = createDecoder(
  idls.idls.map((e) => ({
    name: e.name,
    programId: e.programId,
    root: json<RootNode>(`packages/idls/roots/${e.name}.json`),
    ...(e.format.startsWith("anchor") ? { idl: json<AnchorIdlJson>(`packages/idls/raw/${e.name}.json`) } : {})
  }))
);

async function main(): Promise<void> {
  const manifest = json<{ cases: { path: string; kind: string }[] }>("fixtures/poison/manifest.json");
  const out: Record<string, Call[]> = {};
  for (const c of manifest.cases) {
    const fx = json<PoisonFixture>(`fixtures/${c.path}`);
    const rpc = createRpcClient({ url: rpcUrlFor(fx.network, key!), maxRps: 5 });
    const anchor = anchorOf(fx);
    const since = anchor.blockTime - HISTORY_DAYS * 86_400;
    const calls: Call[] = [];
    // Signatures newest first, until older than the window, its first transaction or 1,000 entries.
    const record = async (address: string, start?: string): Promise<Set<string>> => {
      const got = new Set<string>();
      let before = start;
      for (let page = 0; page < 20; page++) {
        const params = [address, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }];
        const result = await rpc.call<{ signature: string; slot: number; blockTime: number | null }[]>("getSignaturesForAddress", params);
        calls.push({ method: "getSignaturesForAddress", params, result });
        for (const s of result) got.add(s.signature);
        const last = result.at(-1);
        if (result.length < 1000 || !last || (last.blockTime !== null && last.blockTime < since) || got.size >= 1000) break;
        before = last.signature;
      }
      return got;
    };
    // The user's list before the analysis point (S7 recorded at most 50).
    await record(fx.user, anchor.signature);
    const searched = new Set<string>();
    // S7 already proves a first-send recipient had no earlier transaction; poisoners are recorded here.
    if (fx.kind === "poisoning") for (const s of await record(fx.recipient)) searched.add(s);
    // Live only for account snapshots, shared transactions and DAS; everything else must come from above.
    const live = async (method: string, params: any) => {
      if (method === "getTransaction" && !searched.has(params[0])) throw new Error("user tx not shared: leave unread");
      if (!["getTransaction", "getAssetBatch", "getAccountInfo"].includes(method)) throw new Error(`unexpected live ${method}`);
      const result = await rpc.call(method, params);
      calls.push({ method, params, result });
      return result;
    };
    let h;
    if (fx.request) {
      const session = await ingestSession([{ base64: requestWire(fx, json), kind: "wire" }]);
      const decoded = decoder.decodeSession(session);
      const replay = poisonRpc(fx, calls, live);
      const state = await readTokenRuleState(createRpcAccountReader(replay), session, fx.user);
      // Destination token accounts of the request are searched too: record their lists first.
      for (const t of requestTransfers({ session, decoded, state }, fx.user)) if (t.tokenAccount) for (const s of await record(t.tokenAccount)) searched.add(s);
      h = (await readAddressRuleState(poisonRpc(fx, calls, live), session, decoded, state, { now: anchor.blockTime, pageSize: 100 })).history;
      if (!h) {
        console.log(`${fx.id}: no wallet transfer with a resolved recipient in the request (${requestTransfers({ session, decoded, state }, fx.user).length} transfers)`);
        out[fx.id] = calls;
        continue;
      }
    } else {
      h = await readTransferHistory(poisonRpc(fx, calls, live), { wallet: fx.user, counterparties: [{ address: fx.recipient }], now: anchor.blockTime, pageSize: 100 });
    }
    const cp = h.counterparties[fx.recipient];
    console.log(`${fx.id}: user sigs ${h.signatures.length} (${h.reach}), recipient sigs ${cp?.signatures}, shared ${cp?.shared.length}, complete ${cp?.complete}, assets ${Object.keys(h.assets).length}, recorded ${calls.length} calls`);
    out[fx.id] = calls;
  }
  const text = JSON.stringify({ schema: "kelvara.core.poison-history/v1", source: "helius", recordedAt: new Date().toISOString(), cases: out });
  if (text.includes(key!)) throw new Error("refusing to write: the API key appears in the recording");
  const file = path.join(root, "packages/core/test/fixtures/poison/history.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text + "\n");
  console.log(`wrote ${path.relative(root, file)}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).replace(/api-key=[^&\s"]+/g, "api-key=REDACTED"));
  process.exit(1);
});
