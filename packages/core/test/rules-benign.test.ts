// E7 / G3: no fixture from any program reaches L4, every report validates (G4 checks), and every
// ruleId implemented so far (rules plus the E11 capability graph: preview, recovery paths) fires on at least one real session and stays silent on at least one.
// Transactions that use lookup tables are resolved with the runtime's own meta.loadedAddresses.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { accountFromRpc, ALL_RULE_IDS as RULE_IDS, type RuleState, type Session } from "../src/index.js";
import { poisonManifest, requestCase } from "./address-helpers.js";
const devnet = poisonManifest.cases.find((c) => c.kind === "poisoning" && c.network === "devnet")!;
import { decoder, sessionFromRuntime, analysisTiming, analyze, analyzedState, json, DRIFT_1, DRIFT_2, driftTx, manifestFixtures, recording, root, ruleFixtures, sessionOf, stateFrom } from "./rules-helpers.js";
import { s9SweepCase } from "./sweep-helpers.js";

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
  // E16: the realistic sweep shape is an attack (L4): the S9 devnet request with its pre-execution simulation,
  // and S12's two localnet shapes through analyzeSession (recorded real RPC, --inventory).
  const s9 = await s9SweepCase();
  poisonSessions.push({ name: "S9 devnet sweep request (simulated)", session: s9.session, state: s9.state, expectedL4: true });
  for (const name of ["sweep-local", "sweep-ata-local"] as const) {
    if (!existsSync(path.join(root, `packages/core/test/fixtures/analyze/${name}.json`))) continue;
    const a = await analyzedState(name);
    poisonSessions.push({ name: `${name} analyzed (simulated)`, session: await sessionOf(a.rec.inputs.transactions), state: a.state, expectedL4: true });
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
  // E27: real Velocity transactions (Ed25519 signature checks, oracle and twap updates), recorded over Helius.
  const velocityDir = path.join(root, "packages/core/test/fixtures/velocity");
  for (const name of readdirSync(velocityDir).filter((n) => n.endsWith(".json")).sort()) {
    const fx = json<{ transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } }>(`packages/core/test/fixtures/velocity/${name}`);
    sessions.push({ name: `velocity/${name.slice(0, 8)}`, session: sessionFromRuntime(fx.transaction, fx.meta.loadedAddresses ?? { writable: [], readonly: [] }) });
  }
  sessions.push(...poisonSessions);
  const prepared = performance.now();
  const fired = new Map<string, number>(RULE_IDS.map((id) => [id, 0]));
  const levels = new Map<string, number>();
  for (const s of sessions) {
    const r = analyze(s.session, s.state); // throws on any G4 problem
    if(s.expectedL4) expect(r.alert.level,s.name).toBe("L4");
    else expect(r.alert.level, s.name).not.toBe("L4");
    // E23: facts are descriptive L0 claims; they never move the alert or its claim list.
    const facts = r.claims.filter((c) => c.ruleId?.startsWith("fact."));
    for (const c of facts) {
      expect(c, `${s.name}: ${c.ruleId}`).toMatchObject({ kind: "Fact", level: "L0" });
      expect(r.alert.claimIds, `${s.name}: ${c.id} in alert`).not.toContain(c.id);
    }
    const riskLevel = r.claims.filter((c) => !c.ruleId?.startsWith("fact.")).reduce((m, c) => Math.max(m, Number(c.level.slice(1))), 0);
    expect(r.alert.level, `${s.name}: facts changed the level`).toBe(`L${riskLevel}`);
    if (facts.some((c) => c.ruleId === "fact.no_permission_change")) {
      expect(r.capabilities.granted.length + r.capabilities.revoked.length, `${s.name}: no_permission_change with capabilities`).toBe(0);
      expect(decoder.decodeSession(s.session).flat().every((ix) => ix.status === "named"), `${s.name}: no_permission_change with an unknown instruction`).toBe(true);
    }
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
    // E23 facts are informational L0 claims; the network fee is on every transaction by design.
    if (!id.startsWith("fact.") || id === "fact.no_permission_change") expect(count, `${id} fires everywhere`).toBeLessThan(sessions.length);
  }
}, 5_000);
