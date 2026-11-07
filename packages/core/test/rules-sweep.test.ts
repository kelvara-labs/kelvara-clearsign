// E16: wallet.sweep judges the simulated outcome, so the realistic drainer shape (per mint ATA CreateIdempotent for
// the collector paid by the user + TransferChecked(all) + CloseAccount(user ATA -> collector), then SOL minus fee
// and rent) is a Fact L4; anything that leaves the user value, or a destination that signs, stays below L4.
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { RuleState, Session, SimulationResult } from "../src/index.js";
import { analyze, analyzedState, byRule, root } from "./rules-helpers.js";
import { s9SweepCase } from "./sweep-helpers.js";

const sweepClaims = (s: Session, st: RuleState) => byRule(analyze(s, st), "wallet.sweep");
const withSim = (st: RuleState, f: (s: SimulationResult) => SimulationResult): RuleState => ({ ...st, simulations: { 0: f(structuredClone(st.simulations![0]!)) } });

it("S9 devnet request (ATA create + TransferChecked + CloseAccount, SOL minus fee and rent) is a Fact L4", async () => {
  const { session, state, fx } = await s9SweepCase();
  // The meta used for full balances agrees with the request's own pre-execution simulation summary.
  const sim = state.simulations![0]!;
  expect(Object.fromEntries(sim.solChanges.map((c) => [c.address, Number(c.delta)]))).toEqual(fx.request.simulation.lamportsDelta);
  for (const t of fx.request.simulation.tokens) expect(sim.tokenChanges.find((c) => c.mint === t.mint && c.owner === fx.request.collector)?.post).toBe(BigInt(t.collectorAfter));
  const report = analyze(session, state);
  const c = byRule(report, "wallet.sweep");
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ kind: "Fact", level: "L4" });
  expect(c[0]!.statement).toContain(fx.request.collector);
  expect(c[0]!.statement).toContain("all 2 token balances");
  expect(report.alert.level).toBe("L4");
  // Without the simulation the exact-message proof cannot account for the rent: no claim, never a guess.
  expect(sweepClaims(session, { ...state, simulations: {} })).toEqual([]);
});

it("mutants of the S9 sweep stay below L4", async () => {
  const { session, state, fx, keys } = await s9SweepCase();
  const user = fx.request.user as string, collector = fx.request.collector as string;
  const mutants: [string, Session, RuleState][] = [];
  // User keeps > 1 % of its SOL: 1,000,000 of 50,000,000 lamports stay, the collector gets that much less.
  mutants.push(["keeps 2% SOL", session, withSim(state, (s) => ({ ...s, solChanges: s.solChanges.map((c) => c.address === user ? { ...c, post: 1_000_000n, delta: c.delta + 1_000_000n } : c.address === collector ? { ...c, post: c.post - 1_000_000n, delta: c.delta - 1_000_000n } : c) }))]);
  // User keeps one token balance: its first ATA keeps the amount, the collector's ATA for that mint gains nothing.
  mutants.push(["keeps one token", session, withSim(state, (s) => {
    const kept = s.tokenChanges.find((t) => t.owner === user)!;
    return { ...s, tokenChanges: s.tokenChanges.filter((t) => !(t.mint === kept.mint && t.owner === collector)).map((t) => t === kept ? { ...t, post: t.pre, delta: 0n } : t) };
  })]);
  // Value comes back: the user receives a token in a new account, or lamports.
  mutants.push(["token back", session, withSim(state, (s) => ({ ...s, tokenChanges: [...s.tokenChanges, { ...s.tokenChanges[0]!, account: keys[6]!, owner: user, pre: 0n, post: 1n, delta: 1n }] }))]);
  mutants.push(["token back into an inventory account", session, withSim(state, (s) => ({ ...s, tokenChanges: [...s.tokenChanges, { ...s.tokenChanges[0]!, account: state.walletInventory!.tokenAccounts[0]!, owner: user, pre: 0n, post: 1n, delta: 1n }] }))]);
  // A second destination gains lamports.
  mutants.push(["split destination", session, withSim(state, (s) => ({ ...s, solChanges: s.solChanges.map((c) => c.address === collector ? { ...c, post: c.post - 1n, delta: c.delta - 1n } : c).concat({ address: keys[6]!, pre: 0n, post: 1n, delta: 1n }) }))]);
  // The destination co-signs the session.
  const tx = session.transactions[0]!;
  mutants.push(["destination signs", { ...session, transactions: [{ ...tx, accounts: tx.accounts.map((a) => a.address === collector ? { ...a, signer: true } : a) }] }, state]);
  // Failed simulation, omitted accounts, incomplete inventory, inventory account the simulation does not show.
  mutants.push(["sim failed", session, withSim(state, (s) => ({ ...s, ok: false, err: { InstructionError: [0, "Custom"] } }))]);
  mutants.push(["accounts omitted", session, withSim(state, (s) => ({ ...s, accountsOmitted: [keys[9]!] }))]);
  mutants.push(["inventory incomplete", session, { ...state, walletInventory: { ...state.walletInventory!, complete: false } }]);
  mutants.push(["unread inventory account", session, { ...state, walletInventory: { complete: true, tokenAccounts: [...state.walletInventory!.tokenAccounts, keys[6]!] } }]);
  mutants.push(["no wallet", session, { ...state, wallet: undefined }]);
  for (const [name, s, st] of mutants) expect(sweepClaims(s, st).map((c) => c.level), name).not.toContain("L4");
});

// S12 localnet: both shapes of one fresh user, analyzeSession over recorded real localnet RPC (fixtures:analyze).
for (const name of ["sweep-local", "sweep-ata-local"] as const) {
  const file = path.join(root, `packages/core/test/fixtures/analyze/${name}.json`);
  it.runIf(existsSync(file))(`${name}: analyzeSession with --inventory gives wallet.sweep Fact L4`, async () => {
    const { report, rec } = await analyzedState(name);
    const c = byRule(report, "wallet.sweep");
    expect(c.map((x) => [x.kind, x.level])).toEqual([["Fact", "L4"]]);
    expect(c[0]!.statement).toContain(name === "sweep-local" ? rec.inputs.collector : rec.inputs.ataCollector);
    expect(report.alert.level).toBe("L4");
  });
}
