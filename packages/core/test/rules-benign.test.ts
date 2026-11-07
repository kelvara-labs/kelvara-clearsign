// E7 / G3: no fixture from any program reaches L4, every report validates (G4 checks), and every
// ruleId implemented so far fires on at least one real session and stays silent on at least one.
// Transactions that use lookup tables are resolved with the runtime's own meta.loadedAddresses.
import { expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { parseTransaction, RULE_IDS, type ResolvedAccount, type Session, type SessionTransaction } from "../src/index.js";
import { analyze, DRIFT_1, DRIFT_2, driftTx, manifestFixtures, recording, ruleFixtures, sessionOf, stateFrom } from "./rules-helpers.js";

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

it("G3: no fixture reaches L4; every implemented ruleId has a positive and a negative real session", async () => {
  const MAIN = recording("mainnet.json");
  const LOCAL = recording("localnet.json");
  const sessions: { name: string; session: Session; state?: Parameters<typeof analyze>[1] }[] = [];
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
  sessions.push({
    name: "admin-local approval + localnet state",
    session: await sessionOf([LOCAL.inputs.approval.wireBase64]),
    state: await stateFrom(LOCAL, { nonces: [LOCAL.inputs.nonce], squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] })
  });

  const fired = new Map<string, number>(RULE_IDS.map((id) => [id, 0]));
  const levels = new Map<string, number>();
  for (const s of sessions) {
    const r = analyze(s.session, s.state); // throws on any G4 problem
    expect(r.alert.level, s.name).not.toBe("L4");
    levels.set(r.alert.level, (levels.get(r.alert.level) ?? 0) + 1);
    for (const id of new Set(r.claims.map((c) => c.ruleId).filter((x): x is string => !!x))) {
      expect(RULE_IDS, `${s.name}: claim from unregistered ruleId ${id}`).toContain(id);
      fired.set(id, fired.get(id)! + 1);
    }
  }
  console.log(`G3 sessions: ${sessions.length}; alert levels: ${JSON.stringify(Object.fromEntries([...levels].sort()))}`);
  for (const [id, count] of fired) {
    console.log(`  ${id}: fires on ${count}/${sessions.length}`);
    expect(count, `${id} never fires`).toBeGreaterThan(0);
    expect(count, `${id} fires everywhere`).toBeLessThan(sessions.length);
  }
});
