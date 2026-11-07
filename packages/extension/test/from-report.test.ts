// X6a: kelvara-report-v1 -> ReportView. Reports are built with the engine's own ReportBuilder over
// Drift's real attack transactions (fixtures/tx/drift-replay), as in packages/core/test/report-contract.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ReportBuilder, ingestSession, reportDigest, reportSessionFrom, type Report, type Session } from "../../core/src/index.js";
import { limitReport } from "../src/license/limit.js";
import { validateWorkerVerdict, type SignRequest } from "../src/shared/protocol.js";
import { validateReportView } from "../src/shared/report-view.js";
import { DEPLOY_ANY_CODE, fromReport, type FromReport } from "../src/sw/from-report.js";
import type { EngineLike } from "../src/sw/engine-stub.js";
import { decide, messageHashes, type Sha256 } from "../src/sw/policy.js";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/tx/drift-replay");
const ATTACK_1 = "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H";
const ATTACK_2 = "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1";
const load = (sig: string): { transaction: string; label: string } =>
  JSON.parse(readFileSync(path.join(fixturesDir, `${sig}.json`), "utf8")) as { transaction: string; label: string };
const nodeSha256: Sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());

let session: Session;
let txs: string[];
let hashes: string[];
beforeAll(async () => {
  const fx = [load(ATTACK_1), load(ATTACK_2)];
  txs = fx.map((f) => f.transaction);
  session = await ingestSession(fx.map((f) => ({ base64: f.transaction, kind: "wire" as const, label: f.label })));
  hashes = await messageHashes(txs, nodeSha256);
});

/** Same shape as the core contract test's Drift report, plus a deploy-any-code preview and an L1 notice. */
function driftReport(sim: Report["simulation"] | null = null): Report {
  const b = new ReportBuilder(session);
  const ix = session.transactions.map((tx) =>
    tx.instructions.map((i) =>
      b.addEvidence({
        type: "instruction",
        source: "message",
        summary: `instruction ${i.index} calls ${i.programAddress}`,
        transactionIndex: tx.index,
        instructionPath: [i.index],
        address: i.programAddress
      })
    )
  );
  const nonce = b.addClaim({
    kind: "Fact",
    statement: "Transaction 2 starts with AdvanceNonceAccount: it uses a durable nonce and does not expire.",
    evidenceIds: [ix[1]![0]!],
    ruleId: "lifetime.durable_nonce",
    level: "L2"
  });
  const unknown = b.addClaim({ kind: "Unknown", statement: "One instruction could not be named.", evidenceIds: [ix[0]!.at(-1)!], level: "L1" });
  const derived = b.addClaim({
    kind: "Derived",
    statement: "Transaction 2 can be held and submitted at any later time.",
    dependsOn: [nonce],
    ruleId: "lifetime.durable_nonce",
    level: "L3"
  });
  const conditional = b.addClaim({
    kind: "Conditional",
    statement: "If the proposal reaches its threshold, the vault transaction executes.",
    evidenceIds: ix[0]!.slice(0, 1),
    dependsOn: [unknown],
    ruleId: "squads.threshold_met_in_session",
    assumptions: ["the multisig threshold read from chain is current"],
    level: "L3"
  });
  const program = session.transactions[0]!.instructions[0]!.programAddress;
  b.addCapability({ direction: "granted", capability: "token.freeze", class: "freeze", holder: null, target: null, claimId: conditional });
  b.addCapability({ direction: "revoked", capability: "protocol.admin", class: "admin_control", holder: program, target: program, claimId: derived });
  b.addCapability({ direction: "granted", capability: "protocol.admin", class: "admin_control", holder: null, target: program, claimId: derived });
  b.addCapability({ direction: "granted", capability: "program.upgrade", class: "code_control", holder: null, target: program, claimId: derived });
  b.addPreview({
    authority: null,
    programId: null,
    confidence: "observed",
    deployAnyCode: false,
    unlocks: [
      { instruction: "config_change", discriminator: null, changes: "configuration", class: "config" },
      { instruction: "admin_call", discriminator: "00ff", changes: "admin", class: "admin_control" }
    ],
    claimId: conditional
  });
  b.addPreview({ authority: null, programId: program, confidence: "verified", deployAnyCode: true, unlocks: [], claimId: derived });
  if (sim) b.setSimulation(sim);
  return b.build();
}

const ok = (m: FromReport) => {
  if (!m.ok) throw new Error(`expected ok, got ${m.reason}`);
  return m;
};
const failed = (m: FromReport) => {
  if (m.ok) throw new Error("expected a blocked verdict");
  return m;
};
/** Re-digest after an edit so only the edit, not the digest, is under test. */
const redigest = (r: Report): Report => ({ ...r, digest: reportDigest(r) });

describe("fromReport: Drift session", () => {
  it("message hashes: the engine's base58 hashes equal the worker's own over the same bytes", () => {
    expect(session.transactions.map((t) => t.messageHash)).toEqual(hashes);
    expect(ok(fromReport(driftReport(), hashes)).report.messageHashes).toEqual(hashes);
  });

  it("level, title and summary come from the alert claims", () => {
    const m = ok(fromReport(driftReport(), hashes));
    expect(m.level).toBe(3);
    expect(m.report.title).toBe("Critical: Transaction 2 can be held and submitted at any later time.");
    expect(m.report.summary).toContain("If the proposal reaches its threshold");
    expect(m.report.summary).toContain("4 claim(s), 3 granted and 1 revoked capability change(s).");
    expect(m.report.limited).toBe(false);
    expect(validateReportView(m.report)).not.toBeNull();
  });

  it("capabilities: one ranking, code control first, granted before revoked at equal score", () => {
    const caps = ok(fromReport(driftReport(), hashes)).report.capabilities;
    expect(caps.map((c) => [c.rank, c.change, c.authority.split(" ")[0], c.risk])).toEqual([
      [1, "granted", "program.upgrade", "critical"],
      [2, "granted", "protocol.admin", "critical"],
      [3, "revoked", "protocol.admin", "critical"],
      [4, "granted", "token.freeze", "medium"]
    ]);
    expect(caps[0]!.holder).toBe("unknown");
    expect(caps[3]!.authority).toBe("token.freeze of an unknown target");
  });

  it("authorizes lists granted and revoked powers; simulation null when not run", () => {
    const r = ok(fromReport(driftReport(), hashes)).report;
    expect(r.authorizes).toMatch(/^Grants program\.upgrade of 1{32}; protocol\.admin of 1{32}; token\.freeze of an unknown target\. Revokes protocol\.admin of 1{32} \(holder 1{32}\)\.$/);
    expect(r.simulation).toBeNull();
  });

  it("simulation line: ok shows the summary, failed says so", () => {
    expect(ok(fromReport(driftReport({ status: "ok", summary: "0 SOL leaves your wallet.", evidenceIds: [] }), hashes)).report.simulation).toBe(
      "0 SOL leaves your wallet."
    );
    expect(ok(fromReport(driftReport({ status: "failed", summary: "custom program error 0x1", evidenceIds: [] }), hashes)).report.simulation).toBe(
      "Simulation failed: custom program error 0x1"
    );
  });

  it("preview: deploy-any-code entry first, unlocks in rubric order", () => {
    const p = ok(fromReport(driftReport(), hashes)).report.preview;
    expect(p[0]!.can[0]!.name).toBe(DEPLOY_ANY_CODE);
    expect(p[0]!.confidence).toBe("verified");
    expect(p[0]!.authority).toContain("over ");
    expect(p[1]!.confidence).toBe("observed");
    expect(p[1]!.can.map((c) => c.name)).toEqual(["admin_call", "config_change"]);
  });

  it("claims: highest level first, each with its evidence lines", () => {
    const c = ok(fromReport(driftReport(), hashes)).report.claims;
    expect(c.map((x) => x.id)).toEqual(["c3", "c4", "c1", "c2"]);
    expect(c[0]!.evidence).toEqual([]);
    expect(c[0]!.text).toContain("Follows from c1.");
    expect(c[1]!.text).toContain("Assumes: the multisig threshold read from chain is current.");
    expect(c[2]!.kind).toBe("Fact");
    expect(c[2]!.evidence[0]).toMatch(/^e\d+ · instruction from message · tx 2 · ix 0 · 1{32}: instruction 0 calls 1{32}$/);
  });

  it("an empty report is L0 Clear", () => {
    const m = ok(fromReport(new ReportBuilder(session).build(), hashes));
    expect(m.level).toBe(0);
    expect(m.report.title).toBe("Clear: no finding reaches a notice level");
  });

  it("license limiter still applies after mapping: top finding is the upgrade authority", () => {
    const l = limitReport(ok(fromReport(driftReport(), hashes)).report);
    expect(l.limited).toBe(true);
    expect(l.capabilities.map((c) => c.authority.split(" ")[0])).toEqual(["program.upgrade"]);
    expect(l.messageHashes).toEqual(hashes);
  });

  it("slots into decide() as an engine: L3 holds", async () => {
    const engine: EngineLike = {
      async analyze() {
        const m = ok(fromReport(driftReport(), hashes));
        const view: Partial<typeof m.report> = { ...m.report };
        delete view.messageHashes;
        delete view.limited;
        return { level: m.level, ...(view as Omit<typeof m.report, "messageHashes" | "limited">) };
      }
    };
    const req = { txs, chain: "solana:mainnet" } as unknown as SignRequest;
    const v = await decide(req, { network: "mainnet", passThrough: false, heliusApiKey: "a".repeat(36) }, engine, nodeSha256, async () => true);
    expect(v.allow).toBe(false);
    expect(v.hold).toBe(true);
    expect(v.level).toBe(3);
    expect(v.report!.title).toMatch(/^Critical:/);
  });
});

describe("fromReport: fail closed", () => {
  const expectBlocked = (m: FromReport, reason: RegExp) => {
    const f = failed(m);
    expect(f.reason).toMatch(reason);
    expect(validateWorkerVerdict(f.verdict)).not.toBeNull();
    expect(f.verdict).toMatchObject({ allow: false, hold: false, level: null });
    expect(f.verdict.report!.title).toBe("Blocked: request could not be analyzed");
    return f;
  };

  it("non-reports and schema violations", () => {
    for (const bad of [null, undefined, 42, "report", [], {}, { schemaVersion: "kelvara-report-v1" }]) expectBlocked(fromReport(bad, hashes), /failed validation/);
    const r = driftReport();
    expectBlocked(fromReport({ ...r, schemaVersion: "kelvara-report-v2" }, hashes), /failed validation/);
    expectBlocked(fromReport({ ...r, extra: 1 }, hashes), /failed validation/);
    expectBlocked(fromReport(redigest({ ...r, alert: { ...r.alert, level: "L1" } }), hashes), /failed validation/);
    expectBlocked(fromReport(redigest({ ...r, claims: r.claims.map((c) => ({ ...c, evidenceIds: [...c.evidenceIds, "e999"] })) }), hashes), /failed validation/);
  });

  it("tampered content without a matching digest", () => {
    const r = driftReport();
    const t = structuredClone(r);
    t.claims[0]!.statement = "Nothing to see here.";
    expectBlocked(fromReport(t, hashes), /failed validation/);
  });

  it("report over other bytes than the request", () => {
    const r = driftReport();
    const f = expectBlocked(fromReport(r, [hashes[1]!, hashes[0]!]), /different transactions/);
    expect(f.verdict.report!.messageHashes).toEqual([hashes[1], hashes[0]]);
    expectBlocked(fromReport(r, hashes.slice(0, 1)), /different transactions/);
    expectBlocked(fromReport(r, [...hashes, hashes[0]!]), /different transactions/);
  });

  it("more claims than the view can show is blocked, not truncated", () => {
    const b = new ReportBuilder(session);
    const e = b.addEvidence({ type: "message", source: "message", summary: "m", transactionIndex: 0 });
    for (let i = 0; i < 65; i++) b.addClaim({ kind: "Fact", statement: `claim ${i}`, evidenceIds: [e], level: "L2" });
    expectBlocked(fromReport(b.build(), hashes), /too large/);
  });

  it("more preview entries than the view can show is blocked", () => {
    const b = new ReportBuilder(session);
    const e = b.addEvidence({ type: "message", source: "message", summary: "m", transactionIndex: 0 });
    const c = b.addClaim({ kind: "Fact", statement: "x", evidenceIds: [e], level: "L2" });
    for (let i = 0; i < 17; i++) b.addPreview({ authority: null, programId: null, confidence: "unknown", deployAnyCode: false, unlocks: [], claimId: c });
    expectBlocked(fromReport(b.build(), hashes), /too large/);
  });

  it("long text is shortened to fit, many evidence items end in a count", () => {
    const b = new ReportBuilder(session);
    const ev = Array.from({ length: 40 }, (_, i) => b.addEvidence({ type: "message", source: "message", summary: `m${i}`, transactionIndex: 0, data: i }));
    b.addClaim({ kind: "Fact", statement: "x".repeat(5000), evidenceIds: ev, level: "L2" });
    const m = ok(fromReport(b.build(), hashes));
    expect(m.report.title.length).toBeLessThanOrEqual(200);
    expect(m.report.claims[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(m.report.claims[0]!.evidence).toHaveLength(32);
    expect(m.report.claims[0]!.evidence[31]).toMatch(/^and 9 more evidence items \(e32, .*e40\)$/);
  });

  it("an incomplete session is never shown below L2", () => {
    const s = { ...reportSessionFrom(session), complete: false };
    const m = ok(fromReport(new ReportBuilder(s).build(), hashes));
    expect(m.level).toBe(2);
    expect(m.report.title).toMatch(/^Warning: analysis incomplete/);
    expect(m.report.claims[0]).toMatchObject({ id: "extension.session_incomplete", kind: "Unknown" });
  });
});
