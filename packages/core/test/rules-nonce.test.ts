// E7 / G3: lifetime.durable_nonce and nonce.staged_by_outsider on real transactions:
// Drift's attack (fixtures/tx/drift-replay) with its nonce and funder read from Helius (recorded),
// the admin-local scenario's approval with localnet state (recorded), real benign Squads nonce
// transactions (test/fixtures/rules, recorded by scripts/record-rule-fixtures.ts) and every
// manifest fixture as negatives.
import { describe, expect, it } from "vitest";
import {
  analyze,
  byRule,
  DRIFT_1,
  DRIFT_2,
  driftTx,
  manifestFixtures,
  recording,
  ruleFixture,
  rulesRecording,
  sessionOf,
  stateFrom
} from "./rules-helpers.js";

const MAIN = recording("mainnet.json");
const LOCAL = recording("localnet.json");
const NONCE = "lifetime.durable_nonce";
const STAGED = "nonce.staged_by_outsider";

describe("lifetime.durable_nonce", () => {
  it("flags both Drift attack transactions, at L3 because votes authorize an evidenced admin control grant", async () => {
    const r = analyze(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]));
    const claims = byRule(r, NONCE);
    expect(claims.map((c) => [c.kind, c.level, c.transactionIndices])).toEqual([
      ["Fact", "L3", [0]],
      ["Fact", "L3", [1]]
    ]);
    expect(claims[0]!.statement).toContain("7s7s…tAeC");
    expect(claims[1]!.statement).toContain("proposalApprove, vaultTransactionExecute");
    // Evidence: the AdvanceNonceAccount instruction at path [0] and the lifetime token.
    const ev = r.evidence.filter((e) => claims[0]!.evidenceIds.includes(e.id));
    expect(ev.find((e) => e.type === "instruction" && e.instructionPath?.[0] === 0)?.data).toMatchObject({ name: "advanceNonceAccount" });
    expect(ev.find((e) => e.type === "message")?.data).toMatchObject({ nonceAccount: MAIN.inputs.nonce });
  });

  it("is L1 when the nonce transaction carries no vote or execution (real Squads create on a nonce)", async () => {
    const r = analyze(await sessionOf([ruleFixture("49BwdDv6").transaction]));
    expect(byRule(r, NONCE).map((c) => [c.kind, c.level])).toEqual([["Fact", "L1"]]);
  });

  it("real benign nonce approvals stay below critical even with outsider funding", async () => {
    for (const prefix of ["H7jKsHbL", "37bM"]) {
      const session = await sessionOf([ruleFixture(prefix).transaction]);
      const nonce = session.transactions[0]!.instructions[0]!.accounts[0]!.address!;
      const report = analyze(session, await stateFrom(rulesRecording, {nonces:[nonce]}));
      expect(byRule(report, STAGED)[0]?.level).toBe("L2");
      expect(byRule(report, NONCE)[0]?.level).toBe("L2");
      expect(report.alert.level).not.toBe("L3");
      expect(report.alert.level).not.toBe("L4");
      expect(byRule(report, "authority.transfer")).toEqual([]);
    }
  });

  it("does not fire on any manifest fixture that does not start with AdvanceNonceAccount", async () => {
    let checked = 0;
    for (const f of manifestFixtures()) {
      if (f.loaded && f.loaded.writable.length + f.loaded.readonly.length > 0) continue; // needs lookup tables; covered by rules-benign
      const s = await sessionOf([f.base64]);
      const first = s.transactions[0]!.instructions[0]!;
      const isNonce = first.programAddress === "11111111111111111111111111111111" && first.data[0] === 4 && first.data.length === 4;
      expect(byRule(analyze(s), NONCE).length, f.path).toBe(isNonce ? 1 : 0);
      if (!isNonce) checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("nonce.staged_by_outsider", () => {
  it("Drift: the attack nonce was created by a key outside the session (Helius history, recorded)", async () => {
    const session = await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]);
    const state = await stateFrom(MAIN, { nonces: [MAIN.inputs.nonce], squads: [MAIN.inputs.multisig] });
    const r = analyze(session, state);
    const [staged, unknown] = byRule(r, STAGED);
    expect(staged).toMatchObject({ kind: "Fact", level: "L3", transactionIndices: [0] });
    expect(staged!.statement).toContain(MAIN.observed.origin.funder.slice(0, 4));
    expect(staged!.dependsOn).toEqual([byRule(r, NONCE)[0]!.id]);
    const history = r.evidence.find((e) => staged!.evidenceIds.includes(e.id) && e.type === "history");
    expect(history).toMatchObject({ source: "helius", address: MAIN.inputs.nonce, data: { funder: MAIN.observed.origin.funder, signature: MAIN.observed.origin.signature } });
    // The second attack nonce was not read: reported as Unknown, never assumed safe.
    expect(unknown).toMatchObject({ kind: "Unknown", level: "L1", transactionIndices: [1] });
    expect(r.alert.level).toBe("L3");
  });

  it("admin-local: the scenario's outsider funded Member A's nonce", async () => {
    const session = await sessionOf([LOCAL.inputs.approval.wireBase64]);
    const state = await stateFrom(LOCAL, { nonces: [LOCAL.inputs.nonce], squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] });
    const [c] = byRule(analyze(session, state), STAGED);
    expect(c).toMatchObject({ kind: "Fact", level: "L3" });
    expect(c!.statement).toContain(LOCAL.inputs.nonceFunder.slice(0, 4));
    expect(c!.statement).toContain(LOCAL.inputs.nonceAuthority.slice(0, 4));
  });

  it("real benign Squads nonces funded by a third party fire too (recorded): the rule cannot tell intent", async () => {
    // Both nonces were created by the same key, which signs none of these transactions.
    const obs = rulesRecording.observed;
    const nonce = "2pB8stGiWkiLbYnULRtEYsRZqtmvVMSLHh4WE42xULqz";
    expect(obs[nonce].origin.funder).not.toBe(obs[nonce].account.authority);
    const r = analyze(await sessionOf([ruleFixture("49BwdDv6").transaction]), await stateFrom(rulesRecording, { nonces: [nonce] }));
    // No vote in this transaction: L2, not L3.
    expect(byRule(r, STAGED).map((c) => [c.kind, c.level])).toEqual([["Fact", "L2"]]);
  });

  it("reports Unknown when the funder was not read, and nothing on transactions without a nonce", async () => {
    const r = analyze(await sessionOf([ruleFixture("H7jKsHbL").transaction]));
    expect(byRule(r, STAGED).map((c) => [c.kind, c.level])).toEqual([["Unknown", "L1"]]);
    const plain = analyze(await sessionOf([ruleFixture("2M85hTDg").transaction]));
    expect(byRule(plain, STAGED)).toEqual([]);
  });
});
