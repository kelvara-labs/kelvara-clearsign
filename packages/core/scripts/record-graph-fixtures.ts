/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// Record real RPC responses for the E11 capability-graph fallbacks:
//  - mainnet over Helius: the Drift old admin's recent history (getSignaturesForAddress + getTransaction),
//    the admin Drift's updateAdmin takes the power from (read from the replayed attack session);
//  - localnet (scenario:admin-local state): the demo program's Program/ProgramData and a simulation of
//    an unsigned loader SetAuthority on it (sigVerify off, so no key is needed and nothing executes).
// Usage: pnpm --filter @kelvara/core fixtures:graph   (bundles this file with esbuild, then runs it)
// Reads HELIUS_API_KEY from the main checkout's .env. Only method, params and result are stored, and
// the output is scanned for the key before writing.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RootNode } from "@codama/nodes";
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  AccountRole,
  type Address,
  type Blockhash
} from "@solana/kit";
import {
  createDecoder,
  createRpcAccountReader,
  createRpcClient,
  ingestSession,
  readAuthorityHistory,
  readProgram,
  ReportBuilder,
  rpcUrlFor,
  runRules,
  simulateTransaction,
  type AnchorIdlJson,
  type RpcNetwork
} from "../src/index.js";
import { fromBase64 } from "../src/util/encoding.js";

const root = execSync("git rev-parse --show-toplevel").toString().trim();
const common = execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim();
const key = readFileSync(path.join(common, "..", ".env"), "utf8").match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const outDir = path.join(root, "packages/core/test/fixtures/graph");
const json = (p: string): any => JSON.parse(readFileSync(path.join(root, p), "utf8"));

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
const client = (network: RpcNetwork, calls: Call[]) => createRpcClient({ url: rpcUrlFor(network, key), fetch: recordingFetch(calls), maxRps: network === "mainnet" ? 5 : undefined });

function write(name: string, data: unknown): void {
  const text = JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v), 2) + "\n";
  if (text.includes(key!)) throw new Error(`refusing to write ${name}: contains the API key`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), text);
  console.log(`wrote ${name} (${text.length} bytes)`);
}

const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;

async function mainnet(): Promise<void> {
  const manifest = json("packages/idls/manifest.json") as { idls: { name: string; programId: string; format: string }[] };
  const decoder = createDecoder(manifest.idls.map((e) => ({ name: e.name, programId: e.programId, root: json(`packages/idls/roots/${e.name}.json`) as RootNode, ...(e.format.startsWith("anchor") ? { idl: json(`packages/idls/raw/${e.name}.json`) as AnchorIdlJson } : {}) })));
  const sigs = ["2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H", "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1"];
  const session = await ingestSession(sigs.map((s) => ({ base64: json(`fixtures/tx/drift-replay/${s}.json`).transaction as string })));
  const report = new ReportBuilder(session);
  runRules({ session, decoder, report, graph: false });
  const old = report.listCapabilities().find((c) => c.direction === "revoked" && c.capability === "protocol.admin")?.holder;
  if (!old) throw new Error("Drift replay: no revoked protocol.admin holder");
  const calls: Call[] = [];
  const history = await readAuthorityHistory(client("mainnet", calls), { authority: old, programId: DRIFT, limit: 100, maxTransactions: 40 });
  console.log(`Drift old admin ${old}: ${history.signaturesRead} signatures, ${history.transactionsRead} transactions, ${history.calls.length} Drift calls`);
  write("drift-old-admin-history.json", { network: "mainnet", inputs: { program: DRIFT, authority: old, limit: 100, maxTransactions: 40 }, observed: { signaturesRead: history.signaturesRead, transactionsRead: history.transactionsRead, calls: history.calls.length }, calls });
}

async function localnet(): Promise<void> {
  const state = json("packages/core/test/fixtures/state/localnet.json");
  const program = state.inputs.demoProgram as Address;
  const calls: Call[] = [];
  const rpc = client("localnet", calls);
  const reader = createRpcAccountReader(rpc);
  const prog = await readProgram(reader, program);
  if (!prog.programData || !prog.upgradeAuthority) throw new Error("demo program is not upgradeable on localnet");
  const payer = state.inputs.members.A as Address;
  const next = state.inputs.members.B as Address;
  const { value } = await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  // Upgradeable loader SetAuthority: u32 LE 4; accounts [ProgramData (w), current authority (signer), new authority].
  const ix = {
    programAddress: LOADER,
    accounts: [
      { address: prog.programData as Address, role: AccountRole.WRITABLE },
      { address: prog.upgradeAuthority as Address, role: AccountRole.READONLY_SIGNER },
      { address: next, role: AccountRole.READONLY }
    ],
    data: new Uint8Array([4, 0, 0, 0])
  };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: value.blockhash as Blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstruction(ix, m)
  );
  const wireBase64 = getBase64EncodedWireTransaction(compileTransaction(msg));
  const sim = await simulateTransaction(rpc, fromBase64(wireBase64), { accounts: [prog.programData], reader });
  console.log(`localnet SetAuthority simulation ok=${sim.ok}; state changes: ${JSON.stringify(sim.stateChanges)}`);
  if (!sim.ok) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}`);
  // ProgramData is the whole 10 MiB program: keep only its 45-byte loader header (all the diff reads),
  // in both the pre-state read and the simulated post-state. Every other byte is as returned.
  const trim = (acc: any) => {
    if (acc && Array.isArray(acc.data) && acc.data[1] === "base64") acc.data[0] = Buffer.from(acc.data[0], "base64").subarray(0, 45).toString("base64");
  };
  for (const c of calls) {
    const addrs: string[] = c.method === "getMultipleAccounts" ? (c.params as any)[0] : c.method === "simulateTransaction" ? (c.params as any)[1].accounts.addresses : [];
    const values: any[] = c.method === "getMultipleAccounts" ? (c.result as any).value : c.method === "simulateTransaction" ? (c.result as any).value.accounts ?? [] : [];
    addrs.forEach((a, i) => { if (a === prog.programData) trim(values[i]); });
  }
  write("localnet-set-authority-sim.json", { network: "localnet", trimmed: `account data of ProgramData ${prog.programData} cut to its 45-byte header in getMultipleAccounts and simulateTransaction results`, inputs: { program, programData: prog.programData, currentAuthority: prog.upgradeAuthority, newAuthority: next, feePayer: payer, wireBase64 }, observed: { stateChanges: sim.stateChanges }, calls });
}

const which = process.argv[2] ?? "all";
if (which === "all" || which === "localnet") await localnet();
if (which === "all" || which === "mainnet") await mainnet();
