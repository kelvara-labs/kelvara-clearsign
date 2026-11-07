// X6a: kelvara-report-v1 -> ReportView. Reports are built with the engine's own ReportBuilder over
// Drift's real attack transactions (fixtures/tx/drift-replay), as in packages/core/test/report-contract.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_TEMPLATE, RULE_TEMPLATES, ReportBuilder, explainReport, ingestSession, reportDigest, reportSessionFrom, type Report, type Session } from "@kelvara/core";
import { limitReport } from "../src/license/limit.js";
import { validateWorkerVerdict, type SignRequest } from "../src/shared/protocol.js";
import { validateReportView } from "../src/shared/report-view.js";
import { DEPLOY_ANY_CODE, fromReport, type FromReport } from "../src/sw/from-report.js";
import { idlPathFor } from "../src/sw/idl-paths.js";
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

  it("level, title and summary come from the alert claims; the title is the engine's template headline", () => {
    const m = ok(fromReport(driftReport(), hashes));
    expect(m.level).toBe(3);
    expect(m.report.title).toBe(explainReport(driftReport()).headline);
    expect(m.report.title).toBe("Critical: The transaction does not expire; This signature reaches the multisig threshold");
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

  it("claims: explanation order, template title/text/advice from the engine, evidence by id", () => {
    const r = driftReport();
    const ex = explainReport(r);
    const c = ok(fromReport(r, hashes)).report.claims;
    expect(c.map((x) => x.id)).toEqual(ex.claims.map((x) => x.claimId));
    expect(c.map((x) => x.id)).toEqual(["c3", "c4", "c1", "c2"]);
    for (const [i, x] of ex.claims.entries()) {
      expect(c[i]!.title).toBe(x.title);
      expect(c[i]!.text.startsWith(x.text)).toBe(true);
      expect(c[i]!.advice).toBe(x.advice);
      expect(c[i]!.rule).toBe(x.ruleId);
      expect(c[i]!.level).toBe(x.level);
    }
    expect(c[0]!.title).toBe(RULE_TEMPLATES["lifetime.durable_nonce"]!.title);
    expect(c[0]!.text).toContain("Derived from the decoded instructions: Transaction 2 can be held and submitted at any later time.");
    expect(c[0]!.evidenceIds).toEqual([]);
    expect(c[0]!.text).toContain("Follows from c1.");
    expect(c[1]!.text).toContain("Assumes: the multisig threshold read from chain is current.");
    expect(c[3]!.title).toBe(FALLBACK_TEMPLATE.title);
    expect(c[2]!.kind).toBe("Fact");
  });

  it("evidence explorer: transaction, instruction path, address for each claim's evidence, listed once", () => {
    const v = ok(fromReport(driftReport(), hashes)).report;
    const c1 = v.claims.find((x) => x.id === "c1")!;
    expect(c1.evidenceIds).toHaveLength(1);
    const e = v.evidence.find((x) => x.id === c1.evidenceIds[0])!;
    expect(e).toMatchObject({ type: "instruction", source: "message", tx: 1, path: "0", address: "1".repeat(32), summary: "instruction 0 calls " + "1".repeat(32) });
    const referenced = new Set(v.claims.flatMap((x) => x.evidenceIds));
    expect(v.evidence.map((x) => x.id).sort()).toEqual([...referenced].sort());
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
    const v = await decide(req, { network: "mainnet", passThrough: false, heliusApiKey: "a".repeat(36) }, engine, nodeSha256);
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
    const ev = Array.from({ length: 70 }, (_, i) => b.addEvidence({ type: "message", source: "message", summary: `m${i}`, transactionIndex: 0, data: i }));
    b.addClaim({ kind: "Fact", statement: "x".repeat(5000), evidenceIds: ev, level: "L2" });
    const m = ok(fromReport(b.build(), hashes));
    expect(m.report.title.length).toBeLessThanOrEqual(200);
    expect(m.report.claims[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(m.report.claims[0]!.evidenceIds).toHaveLength(64);
    expect(m.report.claims[0]!.moreEvidence).toBe(6);
    expect(m.report.evidence).toHaveLength(64);
    expect(m.report.evidence[5]!.fields).toEqual([{ key: "value", value: "5" }]);
  });

  it("an incomplete session is never shown below L2", () => {
    const s = { ...reportSessionFrom(session), complete: false };
    const m = ok(fromReport(new ReportBuilder(s).build(), hashes));
    expect(m.level).toBe(2);
    expect(m.report.title).toMatch(/^Warning: analysis incomplete/);
    expect(m.report.claims[0]).toMatchObject({ id: "extension.session_incomplete", kind: "Unknown" });
  });
});

describe("evidence explorer (X8)", () => {
  it("IDL path: Codama root, Anchor fallback, built-in decoder, unknown program", () => {
    expect(idlPathFor("11111111111111111111111111111111", "codama")).toBe("packages/idls/roots/system.json");
    expect(idlPathFor("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", "anchor-fallback")).toBe("packages/idls/raw/squads-v4.json");
    expect(idlPathFor("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", "builtin")).toBe("built-in decoder (packages/core)");
    expect(idlPathFor("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", "none")).toBeNull();
    expect(idlPathFor("9".repeat(32), "codama")).toBeNull();
  });

  it("instruction evidence: decoded args and named accounts as rows; idl evidence keeps its IDL path; account data is the snapshot", () => {
    const b = new ReportBuilder(session);
    const ix = b.addEvidence({
      type: "instruction",
      source: "message",
      summary: "transaction 0, instruction 1: system.transferSol",
      transactionIndex: 0,
      instructionPath: [1, 0],
      address: "11111111111111111111111111111111",
      data: {
        programId: "11111111111111111111111111111111",
        program: "system",
        name: "transferSol",
        decoder: "codama",
        args: { amount: "5000", nested: { seeds: [1, 2, 3] } },
        accounts: [{ name: "source", address: "S".repeat(32), signer: true, writable: true }, { name: "destination", address: null, signer: false, writable: true }]
      }
    });
    const idl = b.addEvidence({ type: "idl", source: "idl", summary: "x.y", address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", data: { idl: "packages/idls/raw/squads-v4.json", instruction: "y" } });
    const acct = b.addEvidence({ type: "account", source: "rpc", summary: "Account snapshot", address: "A".repeat(32), data: { owner: "o", lamports: 10, data: "z".repeat(900) } });
    b.addClaim({ kind: "Fact", statement: "x", evidenceIds: [ix, idl, acct, ix], ruleId: "wallet.sweep", level: "L4" });
    const v = ok(fromReport(b.build(), hashes)).report;
    expect(v.claims[0]!.evidenceIds).toEqual([ix, idl, acct]);
    const [eIx, eIdl, eAcct] = v.evidence;
    expect(eIx).toMatchObject({ tx: 0, path: "1.0", idl: "packages/idls/roots/system.json" });
    expect(eIx!.fields).toEqual([
      { key: "program", value: "system" },
      { key: "name", value: "transferSol" },
      { key: "args.amount", value: "5000" },
      { key: "args.nested.seeds", value: "1, 2, 3" },
      { key: "accounts.source", value: `${"S".repeat(32)} (signer, writable)` },
      { key: "accounts.destination", value: "unresolved (writable)" }
    ]);
    expect(eIdl).toMatchObject({ type: "idl", idl: "packages/idls/raw/squads-v4.json", tx: null, path: null });
    expect(eAcct!.fields.map((f) => f.key)).toEqual(["owner", "lamports", "data"]);
    expect(eAcct!.fields[2]!.value.length).toBeLessThanOrEqual(200);
  });

  it("the view validator refuses a claim pointing at missing evidence, duplicate evidence ids and unknown evidence types", () => {
    const v = ok(fromReport(driftReport(), hashes)).report;
    expect(validateReportView(v)).not.toBeNull();
    const c = v.claims.find((x) => x.evidenceIds.length)!;
    expect(validateReportView({ ...v, evidence: v.evidence.filter((e) => e.id !== c.evidenceIds[0]) })).toBeNull();
    expect(validateReportView({ ...v, evidence: [...v.evidence, v.evidence[0]] })).toBeNull();
    expect(validateReportView({ ...v, evidence: v.evidence.map((e, i) => (i ? e : { ...e, type: "script" })) })).toBeNull();
    expect(validateReportView({ ...v, evidence: v.evidence.map((e, i) => (i ? e : { ...e, path: "0;alert(1)" })) })).toBeNull();
  });

  it("template text covers every engine ruleId the report can carry", () => {
    for (const rule of Object.keys(RULE_TEMPLATES)) {
      // The rubric decides which level a rule may reach: use the first one the builder accepts.
      let b!: ReportBuilder;
      const accepted = (["L1", "L2", "L3", "L4", "L0"] as const).some((level) => {
        b = new ReportBuilder(session);
        const e = b.addEvidence({ type: "message", source: "message", summary: "m", transactionIndex: 0 });
        try {
          b.addClaim({ kind: "Fact", statement: "s", evidenceIds: [e], ruleId: rule, level });
          return true;
        } catch {
          return false;
        }
      });
      expect(accepted, rule).toBe(true);
      const c = ok(fromReport(b.build(), hashes)).report.claims[0]!;
      expect(c.title).toBe(RULE_TEMPLATES[rule]!.title);
      expect(c.advice).toBe(RULE_TEMPLATES[rule]!.advice);
      expect(c.text).toContain(RULE_TEMPLATES[rule]!.why);
    }
  });
});
