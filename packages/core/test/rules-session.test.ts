/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// E10 rules on real data: sim.power_without_value (G6 stories through analyzeSession on recorded
// localnet RPC, which simulates them), session.dependency / session.partial_execution /
// session.ordering (the two real Drift attack transactions, in their order, reversed, and the same
// durable-nonce transaction twice), tx.foreign_fee_payer (a real mainnet transaction whose fee is paid
// by a second signer) and intent.label_mismatch (the admin-local approval memo "Q4 fee update").
import { beforeAll, describe, expect, it } from "vitest";
import { analyze, analyzedState, analyzeRecording as rec, byRule, DRIFT_1, DRIFT_2, driftTx, manifestFixtures, recording, sessionOf, stateFrom } from "./rules-helpers.js";

const E10 = ["sim.power_without_value", "session.dependency", "session.partial_execution", "session.ordering", "tx.foreign_fee_payer", "intent.label_mismatch"];
const LOCAL = recording("localnet.json");
const MAIN = recording("mainnet.json");
const fixtureByPrefix = (prefix: string) => manifestFixtures().find((f) => f.path.includes(`/${prefix}`))!;

describe("sim.power_without_value", () => {
  let admin: Awaited<ReturnType<typeof analyzedState>>, trap: Awaited<ReturnType<typeof analyzedState>>;
  beforeAll(async () => {
    admin = await analyzedState("admin-local");
    trap = await analyzedState("trap-local");
  }, 20_000);

  it("admin-local: simulation shows only the fee while the vote carries the upgrade authority hand-over", () => {
    const [c, ...rest] = byRule(admin.report, "sim.power_without_value");
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: "Derived", level: "L1" });
    expect(c!.statement).toContain("only the 0.000005 SOL fee leaves the fee payer, 0 tokens move");
    expect(c!.statement).toContain(`program.upgrade over`);
    expect(c!.statement).toContain(admin.rec.inputs.attacker);
    expect(c!.statement).toContain("a balance preview cannot show it");
    const transfer = byRule(admin.report, "authority.transfer")[0]!;
    expect(c!.dependsOn).toContain(transfer.id);
    expect(admin.report.evidence.find((e) => e.id === c!.evidenceIds[0])?.type).toBe("simulation");
    expect(admin.report.alert.level).toBe("L3");
  });

  it("trap-local: simulation shows a normal purchase while the creator keeps permanent delegate and freeze powers", () => {
    const [c, ...rest] = byRule(trap.report, "sim.power_without_value");
    expect(rest).toEqual([]);
    expect(c!.statement).toContain("only a normal purchase");
    expect(c!.statement).toContain(`receives 50000 of mint ${trap.rec.inputs.mint}`);
    expect(c!.statement).toMatch(/pays 1\.\d+ SOL/);
    expect(c!.statement).toContain(trap.rec.inputs.creator);
    const pd = byRule(trap.report, "token2022.permanent_delegate")[0]!;
    const fz = byRule(trap.report, "token.freeze_authority")[0]!;
    expect(c!.dependsOn).toEqual(expect.arrayContaining([pd.id, fz.id]));
    expect(trap.report.alert.level).toBe("L2");
  });

  it("negatives: no simulation, failed simulation, or value moving outside the purchase shape -> silent", async () => {
    // Same session and state without the simulation.
    const noSim = { ...admin.state, simulations: undefined };
    expect(byRule(analyze(await sessionOf(admin.rec.inputs.transactions), noSim), "sim.power_without_value")).toEqual([]);
    // The recorded simulation marked failed (as a simulation error would be reported).
    const failed = { ...admin.state, simulations: { 0: { ...admin.state.simulations![0]!, ok: false, err: { InstructionError: [2, "Custom"] } } } };
    expect(byRule(analyze(await sessionOf(admin.rec.inputs.transactions), failed), "sim.power_without_value")).toEqual([]);
    // Trap simulation read for a different wallet: the purchase is not that wallet's, and no trap grants.
    const other = { ...trap.state, wallet: trap.rec.inputs.seller };
    expect(byRule(analyze(await sessionOf(trap.rec.inputs.transactions), other), "sim.power_without_value")).toEqual([]);
    // Drift replay: landed transactions are never simulated.
    expect(byRule(analyze(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)])), "sim.power_without_value")).toEqual([]);
  });
});

describe("session.dependency, session.partial_execution, session.ordering", () => {
  it("Drift: transaction 1 executes the proposal transaction 0 creates; transaction 0 can land alone", async () => {
    const r = analyze(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]), await stateFrom(MAIN, { nonces: [MAIN.inputs.nonce], squads: [MAIN.inputs.multisig] }));
    const [dep, ...more] = byRule(r, "session.dependency");
    expect(more).toEqual([]);
    expect(dep).toMatchObject({ kind: "Fact", level: "L0", transactionIndices: [0, 1] });
    expect(dep!.statement).toMatch(/^Transaction 1 uses 3 accounts that transaction 0 writes: /);
    expect(dep!.statement).toContain("J1w1…");
    expect(dep!.statement).toContain("(created by its proposalCreate)");
    expect(dep!.statement).toContain("(created by its vaultTransactionCreate)");
    expect(dep!.statement).toContain("until transaction 0 lands, 2QmM…DAwc and J1w1…xti8 do not exist, so transaction 1 only works after it");
    const [partial, ...p2] = byRule(r, "session.partial_execution");
    expect(p2).toEqual([]);
    expect(partial).toMatchObject({ kind: "Derived", level: "L1", transactionIndices: [0, 1] });
    expect(partial!.statement).toContain("transaction 0 (advanceNonceAccount, vaultTransactionCreate, proposalCreate, proposalApprove) can land even if transaction 1 fails");
    expect(partial!.statement).toContain("Durable nonces keep these transactions valid");
    expect(partial!.dependsOn).toContain(dep!.id);
    expect(byRule(r, "session.ordering")).toEqual([]);
    expect(r.alert.level).toBe("L3");
  });

  it("Drift in reverse order: the execute comes before the creation -> ordering claim", async () => {
    const r = analyze(await sessionOf([driftTx(DRIFT_2), driftTx(DRIFT_1)]));
    const ord = byRule(r, "session.ordering");
    expect(ord).toHaveLength(1);
    expect(ord[0]).toMatchObject({ kind: "Fact", level: "L1", transactionIndices: [0, 1] });
    expect(ord[0]!.statement).toContain("transaction 0 comes before transaction 1, but it uses");
    expect(ord[0]!.statement).toContain("(created by its proposalCreate)");
    expect(ord[0]!.statement).toContain("do not exist yet");
  });

  it("the same durable-nonce transaction twice: both advance one nonce from one value -> at most one lands", async () => {
    const r = analyze(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_1)]));
    const nonce = byRule(r, "session.ordering").filter((c) => c.statement.includes("durable nonce account"));
    expect(nonce).toHaveLength(1);
    expect(nonce[0]!.statement).toContain("at most one of them can land");
    expect(nonce[0]!.dependsOn).toHaveLength(2);
    // Different nonce accounts (the real pair) never get this claim.
    const real = analyze(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]));
    expect(byRule(real, "session.ordering").filter((c) => c.statement.includes("durable nonce account"))).toEqual([]);
  });

  it("single-transaction sessions and unrelated pairs never get session claims", async () => {
    const a = fixtureByPrefix("memo/2TiSETW"), b = fixtureByPrefix("memo/39dPFsd");
    for (const s of [[driftTx(DRIFT_1)], [LOCAL.inputs.approval.wireBase64], [a.base64], [a.base64, b.base64]]) {
      const r = analyze(await sessionOf(s));
      for (const id of ["session.dependency", "session.partial_execution", "session.ordering"]) expect(byRule(r, id), id).toEqual([]);
    }
  });
});

describe("tx.foreign_fee_payer", () => {
  // Real mainnet transfer with a memo, signed by two keys: the fee payer and the token owner.
  const fx = fixtureByPrefix("memo/2TiSETW");
  it("wallet signs, someone else pays the fee -> Fact L2; wallet is the fee payer, not a signer, or unknown -> silent", async () => {
    const s = await sessionOf([fx.base64]);
    const signers = s.transactions[0]!.accounts.filter((x) => x.signer).map((x) => x.address!);
    expect(signers).toHaveLength(2);
    const [payer, cosigner] = signers as [string, string];
    const r = analyze(s, { wallet: cosigner });
    const [c, ...rest] = byRule(r, "tx.foreign_fee_payer");
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: "Fact", level: "L2" });
    expect(c!.statement).toContain(`paid for by ${payer}`);
    expect(r.alert.level).toBe("L2");
    expect(byRule(analyze(s, { wallet: payer }), "tx.foreign_fee_payer")).toEqual([]);
    expect(byRule(analyze(s), "tx.foreign_fee_payer")).toEqual([]);
    expect(byRule(analyze(s, { wallet: LOCAL.inputs.attacker ?? DRIFT_1.slice(0, 44) }), "tx.foreign_fee_payer")).toEqual([]);
  });

  it("trap-local buy: the user pays its own fee -> silent", async () => {
    const r = rec("trap-local");
    const s = await sessionOf(r.inputs.transactions);
    expect(s.transactions[0]!.accounts[0]!.address).toBe(r.inputs.wallet);
    expect(byRule(analyze(s, { wallet: r.inputs.wallet }), "tx.foreign_fee_payer")).toEqual([]);
  });
});

describe("intent.label_mismatch", () => {
  it("admin-local: memo 'Q4 fee update' on a vote whose proposal hands over the upgrade authority -> Derived L2", async () => {
    const session = await sessionOf([LOCAL.inputs.approval.wireBase64]);
    const r = analyze(session, await stateFrom(LOCAL, { nonces: [LOCAL.inputs.nonce], squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] }));
    const [c, ...rest] = byRule(r, "intent.label_mismatch");
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: "Derived", level: "L2" });
    expect(c!.statement).toContain('labeled "Q4 fee update" (memo, memo of proposalApprove)');
    expect(c!.statement).toContain("a proposal that, once executed, gives program.upgrade");
    expect(c!.statement).toContain("The label does not mention that power.");
    expect(c!.dependsOn).toContain(byRule(r, "authority.transfer")[0]!.id);
    expect(r.evidence.filter((e) => c!.evidenceIds.includes(e.id)).map((e) => (e.data as any).name).sort()).toEqual(["memo", "proposalApprove"]);
  });

  it("negatives: same approval with the proposal content not read, and real memo transfers with no power granted", async () => {
    const session = await sessionOf([LOCAL.inputs.approval.wireBase64]);
    expect(byRule(analyze(session), "intent.label_mismatch")).toEqual([]);
    const memos = manifestFixtures().filter((f) => f.path.includes("/memo/"));
    expect(memos.length).toBeGreaterThan(3);
    for (const f of memos) expect(byRule(analyze(await sessionOf([f.base64])), "intent.label_mismatch"), f.path).toEqual([]);
  });
});

it("every E10 ruleId is registered", async () => {
  const { ALL_RULE_IDS } = await import("../src/index.js");
  for (const id of E10) expect(ALL_RULE_IDS).toContain(id);
});
