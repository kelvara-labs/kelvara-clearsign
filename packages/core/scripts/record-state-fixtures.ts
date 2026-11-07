/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// Record real RPC responses for the E13 state/simulation tests.
// Mainnet over Helius: PYUSD (Token-2022 with extensions) and USDC mints, Drift and Squads program data,
// the Drift attack's durable nonce (+ its funder) and Squads multisig.
// Localnet (scenario:admin-local and scenario:trap-local state): $SHINY mint, the outsider-funded nonce,
// the demo program, Squads accounts, a fresh SOL transfer simulation and the approval simulation.
// Usage: pnpm --filter @kelvara/core fixtures:state   (bundles this file with esbuild, then runs it)
// Reads HELIUS_API_KEY from the main checkout's .env. The key never reaches a fixture: only method,
// params and result are stored, and the result is scanned for the key before writing.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  createRpcAccountReader,
  createRpcClient,
  createSquadsDecoder,
  findAccountOrigin,
  ingestSession,
  readMints,
  readNonceAccount,
  readProgram,
  readSquadsAccount,
  rpcUrlFor,
  simulateTransaction,
  type AnchorIdlJson,
  type RpcNetwork
} from "../src/index.js";
import { fromBase58, fromBase64, toBase58, toBase64 } from "../src/util/encoding.js";

const root = execSync("git rev-parse --show-toplevel").toString().trim();
const common = execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim();
const key = readFileSync(path.join(common, "..", ".env"), "utf8").match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const outDir = path.join(root, "packages/core/test/fixtures/state");
const scenariosDir = process.env.KELVARA_LOCALNET_DIR ?? path.join(root, "../scenarios/packages/scenarios/.localnet");

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

function client(network: RpcNetwork, calls: Call[]) {
  return createRpcClient({ url: rpcUrlFor(network, key), fetch: recordingFetch(calls), maxRps: network === "mainnet" ? 5 : undefined });
}

function write(name: string, data: unknown): void {
  const text = JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
  if (text.includes(key!)) throw new Error(`refusing to write ${name}: contains the API key`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), text);
  console.log(`wrote ${name}`);
}

const squadsIdl = JSON.parse(readFileSync(path.join(root, "packages/idls/raw/squads-v4.json"), "utf8")) as AnchorIdlJson;
const squads = createSquadsDecoder(squadsIdl);

async function mainnet(): Promise<void> {
  const calls: Call[] = [];
  const rpc = client("mainnet", calls);
  const reader = createRpcAccountReader(rpc);
  const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
  const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
  // Drift attack tx 1/2: AdvanceNonce names the nonce, vaultTransactionCreate names the multisig.
  const fx = JSON.parse(readFileSync(path.join(root, "fixtures/tx/drift-replay/2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H.json"), "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
  const session = await ingestSession([{ base64: fx.transaction }], { reader });
  const tx = session.transactions[0]!;
  const advance = tx.instructions.find((ix) => ix.programAddress === "11111111111111111111111111111111" && ix.data[0] === 4);
  const create = tx.instructions.find((ix) => ix.programAddress === SQUADS);
  if (!advance || !create) throw new Error("drift tx: AdvanceNonce or Squads call not found");
  const nonce = advance.accounts[0]!.address!;
  const multisig = create.accounts[0]!.address!;

  const mints = await readMints(reader, [PYUSD, USDC]);
  const drift = await readProgram(reader, DRIFT);
  const squadsProgram = await readProgram(reader, SQUADS);
  const nonceState = await readNonceAccount(reader, nonce);
  const origin = await findAccountOrigin(rpc, nonce, { maxPages: 3 });
  const ms = await readSquadsAccount(reader, squads, multisig, "Multisig");
  write("mainnet.json", {
    schema: "kelvara.fixture.rpc/v1",
    network: "mainnet",
    source: "Helius mainnet RPC via packages/core/scripts/record-state-fixtures.ts",
    recordedAt: new Date().toISOString(),
    inputs: { PYUSD, USDC, DRIFT, SQUADS, driftAttackTx: "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H", nonce, multisig },
    observed: { mints, drift, squadsProgram, nonceState, origin, multisig: { threshold: ms.data.threshold, timeLock: ms.data.timeLock } },
    calls
  });
}

async function localnet(): Promise<void> {
  const calls: Call[] = [];
  const rpc = client("localnet", calls);
  const reader = createRpcAccountReader(rpc);
  const admin = JSON.parse(readFileSync(path.join(scenariosDir, "admin/scenario.json"), "utf8")) as Record<string, any>;
  const trap = JSON.parse(readFileSync(path.join(scenariosDir, "trap/scenario.json"), "utf8")) as Record<string, any>;

  const [shiny] = await readMints(reader, [trap.token.mint]);
  const nonceState = await readNonceAccount(reader, admin.nonce.account);
  const origin = await findAccountOrigin(rpc, admin.nonce.account);
  const demo = await readProgram(reader, admin.demoProgram);
  const ms = await readSquadsAccount(reader, squads, admin.multisig, "Multisig");
  const proposal = await readSquadsAccount(reader, squads, admin.proposal, "Proposal");
  const vtx = await readSquadsAccount(reader, squads, admin.vaultTransaction, "VaultTransaction");

  // Fresh SOL transfer: fund a throwaway payer (setup, not recorded), then simulate an unsigned transfer.
  const payer = randomBytes(32), to = randomBytes(32);
  const raw = (method: string, params: unknown[]) => fetch("http://localhost:8899", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<any>);
  const airdrop = await raw("requestAirdrop", [toBase58(payer), 2_000_000_000, { commitment: "confirmed" }]);
  for (let i = 0; i < 60; i++) {
    const st = await raw("getSignatureStatuses", [[airdrop.result]]);
    if (st.result?.value?.[0]?.confirmationStatus === "confirmed" || st.result?.value?.[0]?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const bh = (await raw("getLatestBlockhash", [{ commitment: "confirmed" }])).result.value.blockhash as string;
  const lamports = 123_456_789n;
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  const system = new Uint8Array(32);
  const message = new Uint8Array([1, 0, 1, 3, ...payer, ...to, ...system, ...fromBase58(bh), 1, 2, 2, 0, 1, data.length, ...data]);
  const wire = new Uint8Array([1, ...new Uint8Array(64), ...message]);
  const transfer = await simulateTransaction(rpc, wire, { reader, accounts: [toBase58(payer), toBase58(to)] });

  // The scenario's approval (nonce already advanced and proposal executed since): exercises auto blockhash replacement.
  const approvalB64 = readFileSync(path.join(scenariosDir, "admin/approval.unsigned.b64"), "utf8").trim();
  const approval = await simulateTransaction(rpc, fromBase64(approvalB64), { reader, accounts: [admin.members.A, admin.proposal, admin.nonce.account] });

  write("localnet.json", {
    schema: "kelvara.fixture.rpc/v1",
    network: "localnet",
    source: "solana-test-validator after pnpm scenario:admin-local and scenario:trap-local, via packages/core/scripts/record-state-fixtures.ts",
    recordedAt: new Date().toISOString(),
    inputs: {
      shinyMint: trap.token.mint,
      trapCreator: trap.creator,
      nonce: admin.nonce.account,
      nonceAuthority: admin.nonce.authority,
      nonceFunder: admin.nonce.funder,
      demoProgram: admin.demoProgram,
      programData: admin.programData,
      upgradeAuthorityAfterAttack: JSON.parse(readFileSync(path.join(scenariosDir, "admin/attack.json"), "utf8")).upgradeAuthorityAfter,
      multisig: admin.multisig,
      threshold: admin.threshold,
      timeLock: admin.timeLock,
      members: admin.members,
      proposal: admin.proposal,
      vaultTransaction: admin.vaultTransaction,
      transfer: { wireBase64: toBase64(wire), from: toBase58(payer), to: toBase58(to), lamports: lamports.toString() },
      approval: { wireBase64: approvalB64, accounts: [admin.members.A, admin.proposal, admin.nonce.account] }
    },
    observed: {
      shiny,
      nonceState,
      origin,
      demo,
      multisig: { threshold: ms.data.threshold, timeLock: ms.data.timeLock },
      proposal: { status: proposal.data.status },
      vaultTransactionIndex: vtx.data.index,
      transfer: { ok: transfer.ok, solChanges: transfer.solChanges, blockhashReplaced: transfer.blockhashReplaced },
      approval: { ok: approval.ok, err: approval.err, blockhashReplaced: approval.blockhashReplaced }
    },
    calls
  });
}

const which = process.argv[2] ?? "all";
if (which === "all" || which === "mainnet") await mainnet();
if (which === "all" || which === "localnet") await localnet();
