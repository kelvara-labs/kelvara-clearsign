// Record real mainnet Squads v4 transactions for the E7 rule tests (config changes and benign votes).
// Signatures were found by walking getSignaturesForAddress on the Squads v4 program over Helius and
// decoding each transaction with our own decoder. Stores the wire bytes (none uses a lookup table)
// and the raw RPC calls for the state the rules read (nonce accounts + funders, multisigs, proposals).
// Usage: pnpm --filter @kelvara/core fixtures:rules   (reads HELIUS_API_KEY from the main checkout's .env)
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createDecoder,
  createRpcAccountReader,
  createRpcClient,
  createSquadsDecoder,
  findAccountOrigin,
  ingestSession,
  readNonceAccount,
  readSquadsAccount,
  rpcUrlFor,
  SQUADS_V4_PROGRAM,
  type AnchorIdlJson,
  type ProgramEntry
} from "../src/index.js";

const root = execSync("git rev-parse --show-toplevel").toString().trim();
const common = execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim();
const key = readFileSync(path.join(common, "..", ".env"), "utf8").match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");

/** signature -> why it is in the set. */
const SIGNATURES: Record<string, string> = JSON.parse(readFileSync(path.join(root, "packages/core/scripts/rule-fixture-signatures.json"), "utf8")) as Record<string, string>;

interface RpcTx {
  slot: number;
  blockTime: number | null;
  transaction: [string, string];
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } };
}

interface Call { method: string; params: unknown; result: unknown }

function recordingFetch(calls: Call[]): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { result?: unknown };
      if (res.ok && json && "result" in json) calls.push({ method: body.method, params: body.params, result: json.result });
    } catch { /* not JSON: the client reports it */ }
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(root, p), "utf8")) as T;

async function main(): Promise<void> {
  const plain = createRpcClient({ url: rpcUrlFor("mainnet", key!), maxRps: 5 });
  const transactions: { signature: string; transaction: string }[] = [];
  for (const [signature, why] of Object.entries(SIGNATURES)) {
    const t = await plain.call<RpcTx | null>("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
    if (!t) throw new Error(`transaction not found: ${signature}`);
    if (t.meta.err) throw new Error(`transaction failed on chain: ${signature}`);
    if (t.meta.loadedAddresses && t.meta.loadedAddresses.writable.length + t.meta.loadedAddresses.readonly.length > 0) throw new Error(`${signature} uses lookup tables; record them too before adding it`);
    transactions.push({ signature, slot: t.slot, blockTime: t.blockTime, why, transaction: t.transaction[0] } as never);
  }

  // State the rules read, recorded as raw calls so tests replay the real responses: each durable
  // nonce and its oldest transaction (funder), and each Squads multisig and proposal named in the
  // transactions. Read at record time, i.e. after the transactions landed.
  const calls: Call[] = [];
  const rpc = createRpcClient({ url: rpcUrlFor("mainnet", key!), fetch: recordingFetch(calls), maxRps: 5 });
  const reader = createRpcAccountReader(rpc);
  const manifest = json<{ idls: { name: string; programId: string; format: string }[] }>("packages/idls/manifest.json");
  const entries: ProgramEntry[] = manifest.idls.map((e) => ({ name: e.name, programId: e.programId, root: json(`packages/idls/roots/${e.name}.json`), ...(e.format.startsWith("anchor") ? { idl: json<AnchorIdlJson>(`packages/idls/raw/${e.name}.json`) } : {}) }));
  const decoder = createDecoder(entries);
  const squads = createSquadsDecoder(json<AnchorIdlJson>("packages/idls/raw/squads-v4.json"));
  const nonces = new Set<string>(), multisigs = new Set<string>(), proposals = new Set<string>();
  for (const t of transactions) {
    const session = await ingestSession([{ base64: t.transaction, kind: "wire" }]);
    const ixs = decoder.decodeSession(session)[0]!;
    if (ixs[0]?.name === "advanceNonceAccount" && ixs[0].accounts[0]?.address) nonces.add(ixs[0].accounts[0].address);
    for (const ix of ixs) {
      if (ix.programAddress !== SQUADS_V4_PROGRAM) continue;
      for (const a of ix.accounts) {
        if (a.name === "multisig" && a.address) multisigs.add(a.address);
        if (a.name === "proposal" && a.address) proposals.add(a.address);
      }
    }
  }
  const observed: Record<string, unknown> = {};
  for (const n of [...nonces].sort()) {
    const account = await readNonceAccount(reader, n).catch((e: Error) => ({ error: e.message }));
    const origin = await findAccountOrigin(rpc, n, { maxPages: 3 });
    observed[n] = { kind: "nonce", account, origin };
  }
  for (const m of [...multisigs].sort()) {
    const ms = await readSquadsAccount(reader, squads, m, "Multisig").catch((e: Error) => ({ error: e.message }));
    observed[m] = { kind: "multisig", threshold: "data" in ms ? ms.data.threshold : null, timeLock: "data" in ms ? ms.data.timeLock : null };
  }
  for (const p of [...proposals].sort()) {
    const pr = await readSquadsAccount(reader, squads, p, "Proposal").catch((e: Error) => ({ error: e.message }));
    observed[p] = { kind: "proposal", status: "data" in pr ? (pr.data.status as { __kind: string }).__kind : (pr as { error: string }).error };
  }
  const text =
    JSON.stringify(
      { schema: "kelvara.fixture.rules/v1", network: "mainnet", source: "Helius mainnet RPC via packages/core/scripts/record-rule-fixtures.ts", recordedAt: new Date().toISOString(), transactions, observed, calls },
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
      2
    ) + "\n";
  if (text.includes(key!)) throw new Error("refusing to write: contains the API key");
  const out = path.join(root, "packages/core/test/fixtures/rules");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "mainnet-squads.json"), text);
  console.log(`wrote ${transactions.length} transactions, ${calls.length} state calls`);
}

await main();
