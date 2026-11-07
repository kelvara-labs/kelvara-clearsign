/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// Record every real RPC response analyzeSession reads (E14), so the online pipeline is tested offline:
//  - localnet, admin-local: Member A's unsigned approval (packages/scenarios/.localnet/admin), fresh setup
//    (proposal Active, nothing executed);
//  - localnet, trap-local: the seller-signed $SHINY buy (packages/scenarios/.localnet/trap), wallet = user;
//  - mainnet over Helius: the Drift replay session (fixtures/tx/drift-replay), simulation off (landed txs).
// Usage: pnpm --filter @kelvara/core fixtures:analyze   (needs scenario:admin-local + scenario:trap-local on a
// running localnet; KELVARA_LOCALNET_DIR overrides the scenario dir; HELIUS_API_KEY from the main checkout's .env).
// Only method, params and result are stored; the file is scanned for the key before writing.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RootNode } from "@codama/nodes";
import { analyzeSession, buildAuthorityMap, createDecoder, createRpcAccountReader, createRpcClient, createSquadsDecoder, ingestSession, rpcUrlFor, type AnchorIdlJson, type RpcNetwork } from "../src/index.js";

const root = execSync("git rev-parse --show-toplevel").toString().trim();
const common = execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim();
const key = readFileSync(path.join(common, "..", ".env"), "utf8").match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const local = process.env.KELVARA_LOCALNET_DIR ?? path.join(root, "packages/scenarios/.localnet");
const outDir = path.join(root, "packages/core/test/fixtures/analyze");
const json = (p: string): any => JSON.parse(readFileSync(path.isAbsolute(p) ? p : path.join(root, p), "utf8"));

interface Call { method: string; params: unknown; result: unknown }
function recordingFetch(calls: Call[]): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { result?: unknown };
      if (res.ok && j && "result" in j) calls.push({ method: body.method, params: body.params, result: j.result });
    } catch { /* not JSON: the client reports it */ }
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

const manifest = json("packages/idls/manifest.json") as { idls: { name: string; programId: string; format: string; verified: boolean }[] };
const decoder = createDecoder(manifest.idls.map((e) => ({ name: e.name, programId: e.programId, root: json(`packages/idls/roots/${e.name}.json`) as RootNode, ...(e.format.startsWith("anchor") ? { idl: json(`packages/idls/raw/${e.name}.json`) as AnchorIdlJson } : {}) })));
const squadsAccounts = createSquadsDecoder(json("packages/idls/raw/squads-v4.json"));
const authorityMaps = [
  buildAuthorityMap(json("packages/idls/raw/drift-v2.json"), { programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", source: "packages/idls/raw/drift-v2.json", verified: false }),
  buildAuthorityMap(json("packages/scenarios/programs/marginfi_v2.idl.json"), { source: "packages/scenarios/programs/marginfi_v2.idl.json", verified: false })
];

async function record(name: string, network: RpcNetwork, transactions: string[], opts: { wallet?: string; simulate?: boolean }, extra: Record<string, unknown>) {
  const calls: Call[] = [];
  const rpc = createRpcClient({ url: rpcUrlFor(network, network === "localnet" ? undefined : key), fetch: recordingFetch(calls) });
  const session = await ingestSession(transactions.map((base64) => ({ base64, kind: "wire" as const })), { reader: createRpcAccountReader(rpc) });
  const { report, reads } = await analyzeSession(session, { decoder, squadsAccounts, authorityMaps, rpc, ...opts });
  const failed = reads.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${name}: reads failed: ${JSON.stringify(failed)}`);
  const out = {
    description: `Real ${network} RPC responses read by analyzeSession for ${name} (E14). Replay by method + params.`,
    recordedAt: new Date().toISOString(),
    network,
    inputs: { transactions, ...opts, ...extra },
    observed: { alertLevel: report.alert.level, ruleIds: [...new Set(report.claims.map((c) => c.ruleId))], simulation: report.simulation.summary, reads: reads.length },
    calls
  };
  const text = JSON.stringify(out, null, 1) + "\n";
  if (text.includes(key!) || /api-key=/i.test(text)) throw new Error("refusing to write: the key is in the recording");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${name}.json`), text);
  console.log(`${name}: ${report.alert.level}, ${calls.length} calls -> ${path.relative(root, path.join(outDir, `${name}.json`))}`);
}

const admin = json(path.join(local, "admin/scenario.json"));
await record("admin-local", "localnet", [readFileSync(path.join(local, "admin/approval.unsigned.b64"), "utf8").trim()], {}, {
  multisig: admin.multisig, proposal: admin.proposal, vaultTransaction: admin.vaultTransaction, demoProgram: json(path.join(local, "state.json")).demo.programId,
  programData: admin.programData, attacker: admin.attacker, nonce: admin.nonce
});
const trap = json(path.join(local, "trap/scenario.json"));
await record("trap-local", "localnet", [readFileSync(path.join(local, "trap/buy.partial.b64"), "utf8").trim()], { wallet: trap.user }, {
  mint: trap.token?.mint ?? trap.token, creator: trap.creator, seller: trap.seller, user: trap.user
});
const sigs = ["2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H", "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1"];
await record("drift-replay-mainnet", "mainnet", sigs.map((s) => json(`fixtures/tx/drift-replay/${s}.json`).transaction), { simulate: false }, { signatures: sigs });
