// E7 / G3: no fixture from any program reaches L4, every report validates (G4 checks), and every
// ruleId implemented so far (rules plus the E11 capability graph: preview, recovery paths) fires on at least one real session and stays silent on at least one.
// Transactions that use lookup tables are resolved with the runtime's own meta.loadedAddresses.
import { beforeAll, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { accountFromRpc, parseTransaction, ALL_RULE_IDS as RULE_IDS, type ResolvedAccount, type RuleState, type Session, type SessionTransaction } from "../src/index.js";
import { poisonManifest, requestCase } from "./address-helpers.js";
const devnet = poisonManifest.cases.find((c) => c.kind === "poisoning" && c.network === "devnet")!;
import { analysisTiming, analyze, analyzedState, json, DRIFT_1, DRIFT_2, driftTx, manifestFixtures, recording, ruleFixtures, sessionOf, stateFrom } from "./rules-helpers.js";

/** A one-transaction session resolved from the runtime's loaded addresses (real RPC meta). */
function sessionFromRuntime(base64: string, loaded: { writable: string[]; readonly: string[] }): Session {
  const p = parseTransaction({ base64, kind: "wire" });
  const h = p.header;
  const n = p.staticAccounts.length;
  const staticWritable = (i: number) => (i < h.numSignerAccounts ? i < h.numSignerAccounts - h.numReadonlySignerAccounts : i < n - h.numReadonlyNonSignerAccounts);
  const accounts: ResolvedAccount[] = [
    ...p.staticAccounts.map((address, index) => ({ index, address, signer: index < h.numSignerAccounts, writable: staticWritable(index), source: { kind: "static" as const } })),
    ...[...loaded.writable, ...loaded.readonly].map((address, j) => ({
      index: n + j,
      address: address as Address,
      signer: false,
      writable: j < loaded.writable.length,
      source: { kind: "static" as const }
    }))
  ];
  const tx: SessionTransaction = {
    ...p,
    index: 0,
    compiledInstructions: p.instructions,
    accounts,
    instructions: p.instructions.map((ix, index) => ({
      index,
      programIdIndex: ix.programIdIndex,
      programAddress: accounts[ix.programIdIndex]!.address!,
      accounts: ix.accountIndices.map((i) => accounts[i]!),
      data: ix.data
    })),
    lookupProblems: [],
    complete: true
  };
  return { id: p.messageHash, transactions: [tx], lookupTables: {}, complete: true };
}

// E9: the executed devnet poisoning send (L4), the same send with no real payment read (dust sender,
// L3) and 23 real first-time transfers (first-send notice, never L4), all with real history state read
// through the replayed Helius responses. Read here, outside the 5 s corpus budget, which bounds the rules.
// Only the newest 10 user transactions are read (rules-address.test.ts reads the default 100).
const poisonSessions: { name: string; session: Session; state: RuleState; expectedL4?: boolean }[] = [];
beforeAll(async () => {
  poisonSessions.push({ name: "poison devnet send", ...(await requestCase(devnet, { maxTransactions: 10 })), expectedL4: true });
  poisonSessions.push({ name: "poison devnet send, payment not read", ...(await requestCase(devnet, { maxTransactions: 0 })) });
  for (const c of poisonManifest.cases.filter((x) => x.kind === "first-send")) poisonSessions.push({ name: `first-send ${c.id}`, ...(await requestCase(c, { maxTransactions: 10 })) });
  // E10: the G6 stories with the state analyzeSession reads over recorded localnet RPC, simulations included.
  for (const name of ["admin-local", "trap-local"] as const) {
    const a = await analyzedState(name);
    poisonSessions.push({ name: `${name} analyzed (simulated)`, session: await sessionOf(a.rec.inputs.transactions), state: a.state });
  }
}, 20_000);

it("G3: no fixture reaches L4; every implemented ruleId has a positive and a negative real session", async () => {
  const started = performance.now();
  const MAIN = recording("mainnet.json");
  const LOCAL = recording("localnet.json");
  const sessions: { name: string; session: Session; state?: Parameters<typeof analyze>[1]; expectedL4?: boolean }[] = [];
  for (const f of manifestFixtures()) {
    const usesTables = !!f.loaded && f.loaded.writable.length + f.loaded.readonly.length > 0;
    sessions.push({ name: f.path, session: usesTables ? sessionFromRuntime(f.base64, f.loaded!) : await sessionOf([f.base64]) });
  }
  for (const f of ruleFixtures) sessions.push({ name: `rules/${f.signature}`, session: await sessionOf([f.transaction]) });
  sessions.push({
    name: "drift session + Helius state",
    session: await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]),
    state: await stateFrom(MAIN, { nonces: [MAIN.inputs.nonce], squads: [MAIN.inputs.multisig] })
  });
  // E10: the Drift pair in reverse order (execute before creation) and a real fee-sponsored mainnet transfer.
  sessions.push({ name: "drift session reversed", session: await sessionOf([driftTx(DRIFT_2), driftTx(DRIFT_1)]) });
  const sponsored = manifestFixtures().find((f) => f.path.includes("/memo/2TiSETW"))!;
  const sponsoredSession = await sessionOf([sponsored.base64]);
  sessions.push({ name: "sponsored fee, wallet = co-signer", session: sponsoredSession, state: { wallet: sponsoredSession.transactions[0]!.accounts[1]!.address! } });
  sessions.push({
    name: "admin-local approval + localnet state",
    session: await sessionOf([LOCAL.inputs.approval.wireBase64]),
    state: await stateFrom(LOCAL, { nonces: [LOCAL.inputs.nonce], squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] })
  });

  // Executed attack fixtures have explicit expectations; all prior corpus expectations stay intact.
  for (const f of json("packages/core/test/fixtures/rules/e8-localnet.json").cases) {
    sessions.push({name:f.name,session:await sessionOf([f.transaction]),expectedL4:["owner-takeover","close-authority-takeover","assign-takeover","sweep"].includes(f.name),state:{wallet:f.wallet,accounts:Object.fromEntries(Object.entries(f.accounts).map(([a,r])=>[a,accountFromRpc(a,r as Parameters<typeof accountFromRpc>[1])])),fees:{0:BigInt(f.fee)},walletInventory:f.inventory?{complete:true,tokenAccounts:f.inventory.map((a:{pubkey:string})=>a.pubkey)}:undefined}});
  }
  sessions.push(...poisonSessions);
  const prepared = performance.now();
  const fired = new Map<string, number>(RULE_IDS.map((id) => [id, 0]));
  const levels = new Map<string, number>();
  for (const s of sessions) {
    const r = analyze(s.session, s.state); // throws on any G4 problem
    if(s.expectedL4) expect(r.alert.level,s.name).toBe("L4");
    else expect(r.alert.level, s.name).not.toBe("L4");
    levels.set(r.alert.level, (levels.get(r.alert.level) ?? 0) + 1);
    for (const id of new Set(r.claims.map((c) => c.ruleId).filter((x): x is string => !!x))) {
      expect(RULE_IDS, `${s.name}: claim from unregistered ruleId ${id}`).toContain(id);
      fired.set(id, fired.get(id)! + 1);
    }
  }
  console.log(`G3 timing: prepare=${(prepared-started).toFixed(0)}ms, rules+decode=${analysisTiming.rulesMs.toFixed(0)}ms, build=${analysisTiming.buildMs.toFixed(0)}ms, validate=${analysisTiming.validateMs.toFixed(0)}ms`);
  console.log(`G3 sessions: ${sessions.length}; alert levels: ${JSON.stringify(Object.fromEntries([...levels].sort()))}`);
  for (const [id, count] of fired) {
    console.log(`  ${id}: fires on ${count}/${sessions.length}`);
    expect(count, `${id} never fires`).toBeGreaterThan(0);
    expect(count, `${id} fires everywhere`).toBeLessThan(sessions.length);
  }
}, 5_000);
