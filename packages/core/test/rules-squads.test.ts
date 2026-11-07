// E7 / G3: Squads rules on real transactions. Positives: Drift's attack session (fixtures/tx/drift-replay)
// with its multisig read from Helius (recorded), the admin-local scenario approval (localnet recording),
// and real mainnet config-change transactions (test/fixtures/rules). Negatives: benign Squads fixtures.
import { describe, expect, it } from "vitest";
import { describeConfigAction } from "../src/index.js";
import { analyze, byRule, DRIFT_1, DRIFT_2, driftTx, json, recording, ruleFixture, rulesRecording, sessionOf, stateFrom } from "./rules-helpers.js";

const MAIN = recording("mainnet.json");
const LOCAL = recording("localnet.json");
const SQUADS_FIXTURES = json<{ fixtures: { path: string; slug: string }[] }>("fixtures/tx/manifest.json").fixtures.filter((f) => f.path.startsWith("tx/mainnet/squads-v4/"));
const benign = (p: string): string => json<{ transaction: string }>(`fixtures/${p}`).transaction;
const fixtureBy = (prefix: string) => SQUADS_FIXTURES.find((f) => f.path.includes(`/squads-v4/${prefix}`))!.path;

async function driftReport() {
  const session = await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]);
  return analyze(session, await stateFrom(MAIN, { nonces: [MAIN.inputs.nonce], squads: [MAIN.inputs.multisig] }));
}

describe("squads.approve_and_execute", () => {
  it("Drift: the second attack transaction approves and executes the proposal on a durable nonce (G8)", async () => {
    const r = await driftReport();
    const [c] = byRule(r, "squads.approve_and_execute");
    expect(c).toMatchObject({ kind: "Fact", level: "L3", transactionIndices: [0, 1] });
    expect(c!.statement).toContain("J1w1…xti8");
    // Depends on both durable-nonce claims.
    expect(c!.dependsOn).toEqual(byRule(r, "lifetime.durable_nonce").map((n) => n.id));
    const names = r.evidence.filter((e) => c!.evidenceIds.includes(e.id)).map((e) => (e.data as { name: string }).name);
    expect(names).toEqual(["proposalApprove", "proposalApprove", "vaultTransactionExecute"]);
    expect(r.alert.level).toBe("L3");
  });

  it("is L2 without a nonce (real config bundle: create, two approvals, execute)", async () => {
    const r = analyze(await sessionOf([ruleFixture("63aqAhgv").transaction]));
    expect(byRule(r, "squads.approve_and_execute").map((c) => [c.kind, c.level])).toEqual([["Fact", "L2"]]);
  });

  it("does not fire on a lone approval or a lone execution", async () => {
    for (const p of [fixtureBy("4RRx"), fixtureBy("55Yg"), fixtureBy("63U1")]) {
      expect(byRule(analyze(await sessionOf([benign(p)])), "squads.approve_and_execute"), p).toEqual([]);
    }
    expect(byRule(analyze(await sessionOf([driftTx(DRIFT_1)])), "squads.approve_and_execute")).toEqual([]);
  });
});

describe("squads.threshold_met_in_session", () => {
  it("Drift: proposal created in the session, 2 approvals meet threshold 2 and it executes", async () => {
    const r = await driftReport();
    const [c] = byRule(r, "squads.threshold_met_in_session");
    expect(c).toMatchObject({ kind: "Derived", level: "L2" });
    expect(c!.statement).toContain(`had 0 of ${MAIN.observed.multisig.threshold} required approvals`);
    expect(c!.statement).toContain("the session executes it");
    const ms = r.evidence.find((e) => c!.evidenceIds.includes(e.id) && e.type === "account");
    expect(ms).toMatchObject({ address: MAIN.inputs.multisig, data: { threshold: 2, timeLock: 0 } });
  });

  it("Drift transaction 1 alone: one approval of a new proposal does not meet threshold 2", async () => {
    const r = analyze(await sessionOf([driftTx(DRIFT_1)]), await stateFrom(MAIN, { squads: [MAIN.inputs.multisig] }));
    expect(byRule(r, "squads.threshold_met_in_session")).toEqual([]);
  });

  it("reads threshold and time lock from an in-session multisigCreateV2 (real config bundle)", async () => {
    const r = analyze(await sessionOf([ruleFixture("63aqAhgv").transaction]));
    const [c] = byRule(r, "squads.threshold_met_in_session");
    expect(c).toMatchObject({ kind: "Derived", level: "L2" });
    // Matches the multisig read from chain afterwards.
    expect(rulesRecording.observed["CYs9k3denBsAPbcPKpTPKgVTpHESsv8uDr9LVDoUpAxR"]).toMatchObject({ threshold: 2, timeLock: 0 });
    expect(c!.statement).toContain("had 0 of 2 required approvals");
  });

  it("admin-local: proposal already executed when recorded, so prior approvals are unknown -> Conditional", async () => {
    const session = await sessionOf([LOCAL.inputs.approval.wireBase64]);
    const state = await stateFrom(LOCAL, { nonces: [LOCAL.inputs.nonce], squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] });
    const r = analyze(session, state);
    expect(byRule(r, "squads.threshold_met_in_session").map((c) => [c.kind, c.level])).toEqual([["Conditional", "L1"]]);
    // Critical overall: durable-nonce vote and outsider-funded nonce.
    expect(r.alert.level).toBe("L3");
  });

  it("Unknown when the multisig was not read", async () => {
    const r = analyze(await sessionOf([benign(fixtureBy("4RRx"))]));
    expect(byRule(r, "squads.threshold_met_in_session").map((c) => [c.kind, c.level])).toEqual([["Unknown", "L1"]]);
  });
});

describe("squads.zero_timelock_execution", () => {
  it("Drift: time lock 0, executes now -> L2", async () => {
    const r = await driftReport();
    const [c] = byRule(r, "squads.zero_timelock_execution");
    expect(c).toMatchObject({ kind: "Derived", level: "L2" });
    expect(c!.dependsOn.length).toBe(2);
  });

  it("admin-local: a vote on a time-lock-0 multisig that does not complete it -> L1", async () => {
    const session = await sessionOf([LOCAL.inputs.approval.wireBase64]);
    const r = analyze(session, await stateFrom(LOCAL, { squads: [LOCAL.inputs.multisig] }));
    expect(byRule(r, "squads.zero_timelock_execution").map((c) => [c.kind, c.level])).toEqual([["Derived", "L1"]]);
  });

  it("does not fire without the multisig state or without a vote", async () => {
    expect(byRule(analyze(await sessionOf([driftTx(DRIFT_2)])), "squads.zero_timelock_execution")).toEqual([]);
    const r = analyze(await sessionOf([ruleFixture("49BwdDv6").transaction]), await stateFrom(rulesRecording, { squads: [] }));
    expect(byRule(r, "squads.zero_timelock_execution")).toEqual([]);
  });
});

describe("squads.unknown_proposal", () => {
  it("Drift transaction 2 alone: approves and executes a proposal whose contents are not in the session", async () => {
    const r = analyze(await sessionOf([driftTx(DRIFT_2)]));
    const [c] = byRule(r, "squads.unknown_proposal");
    expect(c).toMatchObject({ kind: "Unknown", level: "L2" });
    expect(c!.statement).toContain("executes proposal J1w1…xti8");
    expect(c!.statement).toContain("was not read");
  });

  it("real configTransactionExecute alone: config actions unknown", async () => {
    const r = analyze(await sessionOf([ruleFixture("3mWtuFvE").transaction]));
    expect(byRule(r, "squads.unknown_proposal").map((c) => [c.kind, c.level])).toEqual([["Unknown", "L2"]]);
  });

  it("does not fire when the content is known: in-session create (Drift) or VaultTransaction state (admin-local)", async () => {
    expect(byRule(await driftReport(), "squads.unknown_proposal")).toEqual([]);
    const session = await sessionOf([LOCAL.inputs.approval.wireBase64]);
    const r = analyze(session, await stateFrom(LOCAL, { squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] }));
    expect(byRule(r, "squads.unknown_proposal")).toEqual([]);
    // Without the vault transaction account the same approval is Unknown.
    const blind = analyze(session, await stateFrom(LOCAL, { squads: [LOCAL.inputs.multisig] }));
    expect(byRule(blind, "squads.unknown_proposal").map((c) => c.level)).toEqual(["L2"]);
  });
});

describe("squads.config_change", () => {
  it("real proposal to add a member, created and voted in one transaction -> L2", async () => {
    const r = analyze(await sessionOf([ruleFixture("2M85hTDg").transaction]));
    const [c] = byRule(r, "squads.config_change");
    expect(c).toMatchObject({ kind: "Fact", level: "L2" });
    expect(c!.statement).toContain("proposes and approves a config change");
    expect(c!.statement).toContain("add member JDL5WDPi2tPaesFstHfs5Cut3JVmBQSShgR28UnhX2SN (initiate), a key outside this session");
  });

  it("real spending limit added and executed in one transaction", async () => {
    const r = analyze(await sessionOf([ruleFixture("63aqAhgv").transaction]));
    const [c] = byRule(r, "squads.config_change");
    expect(c!.statement).toContain("proposes and approves and executes");
    expect(c!.statement).toContain("add a spending limit of 100000000 raw units");
    expect(c!.level).toBe("L2");
  });

  it("severity map follows Watchtower: threshold 1 is critical, rent collector is minor", () => {
    const outside = () => true;
    expect(describeConfigAction({ __kind: "ChangeThreshold", newThreshold: 1 }, outside).level).toBe("L3");
    expect(describeConfigAction({ __kind: "ChangeThreshold", newThreshold: 2 }, outside).level).toBe("L2");
    expect(describeConfigAction({ SetTimeLock: { newTimeLock: 0 } }, outside).level).toBe("L2");
    expect(describeConfigAction({ __kind: "SetRentCollector", newRentCollector: null }, outside).level).toBe("L1");
    expect(describeConfigAction({ __kind: "Mystery" }, outside).text).toContain("not recognized");
  });

  it("does not fire on vault proposals or votes (Drift, benign fixtures)", async () => {
    expect(byRule(await driftReport(), "squads.config_change")).toEqual([]);
    for (const f of SQUADS_FIXTURES) expect(byRule(analyze(await sessionOf([benign(f.path)])), "squads.config_change"), f.path).toEqual([]);
  });
});
