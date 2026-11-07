// E6 / G4: the report contract. Schema valid, every reference resolves, counts match, ranks
// follow capability-risk-v1, no Fact without evidence, no Derived claim without a ruleId,
// levels follow alert-levels-v1, canonical JSON and digest are stable.
// Reports here are built from Drift's real attack transactions (fixtures/tx/drift-replay);
// claim wording is contract scaffolding, not rule output (rules land in E7-E11).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ALERT_LEVELS_V1,
  CAPABILITY_RISK_V1,
  ENGINE_VERSION,
  REPORT_SCHEMA_VERSION,
  ReportBuilder,
  ReportError,
  canonicalDigest,
  canonicalJson,
  capabilityScore,
  ingestSession,
  levelAllowed,
  maxLevel,
  reportDigest,
  toJsonValue,
  validateReport,
  type Report,
  type Session
} from "../src/index.js";
import { toBase64 } from "../src/util/encoding.js";
import { schemaDifference } from "./report-schema-full.js";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/tx/drift-replay");
const ATTACK_1 = "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H";
const ATTACK_2 = "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1";
const SYSTEM = "11111111111111111111111111111111";
const load = (sig: string): { transaction: string; label: string } =>
  JSON.parse(readFileSync(path.join(fixturesDir, `${sig}.json`), "utf8")) as { transaction: string; label: string };

let session: Session;
beforeAll(async () => {
  const fx = [load(ATTACK_1), load(ATTACK_2)];
  session = await ingestSession(fx.map((f) => ({ base64: f.transaction, kind: "wire" as const, label: f.label })));
});

/** A report over the real Drift session exercising every part of the contract. */
function driftReport(): Report {
  const b = new ReportBuilder(session);
  const ixEvidence = session.transactions.map((tx) =>
    tx.instructions.map((ix) =>
      b.addEvidence({
        type: "instruction",
        source: "message",
        summary: `instruction ${ix.index} calls ${ix.programAddress}`,
        transactionIndex: tx.index,
        instructionPath: [ix.index],
        address: ix.programAddress,
        data: { programId: ix.programAddress, accounts: ix.accounts.map((a) => a.address), data: ix.data }
      })
    )
  );
  const tx2 = session.transactions[1]!;
  const first = tx2.instructions[0]!;
  // System AdvanceNonceAccount = u32 LE 4 as the first instruction: the transaction uses a durable nonce.
  expect(first.programAddress).toBe(SYSTEM);
  expect(Array.from(first.data.slice(0, 4))).toEqual([4, 0, 0, 0]);
  const nonce = b.addClaim({
    kind: "Fact",
    statement: "Transaction 2 starts with AdvanceNonceAccount: it uses a durable nonce and does not expire.",
    evidenceIds: [ixEvidence[1]![0]!],
    ruleId: "lifetime.durable_nonce",
    level: "L2"
  });
  const msg = b.addEvidence({
    type: "message",
    source: "message",
    summary: "message hashes of the session",
    data: session.transactions.map((t) => t.messageHash)
  });
  const all = b.addClaim({
    kind: "Fact",
    statement: "The session holds two transactions.",
    evidenceIds: [msg],
    scope: "session"
  });
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
    evidenceIds: ixEvidence[0]!.slice(0, 1),
    dependsOn: [all],
    ruleId: "squads.threshold_met_in_session",
    assumptions: ["the multisig threshold read from chain is current"],
    level: "L3"
  });
  b.addClaim({ kind: "Unknown", statement: "One instruction could not be named.", evidenceIds: [ixEvidence[0]!.at(-1)!], level: "L1" });
  // Unreferenced evidence is pruned from the report.
  b.addEvidence({ type: "history", source: "helius", summary: "unused", data: null });

  b.addCapability({ direction: "granted", capability: "token.freeze", class: "freeze", holder: null, target: null, claimId: conditional });
  b.addCapability({ direction: "granted", capability: "protocol.admin", class: "admin_control", holder: null, target: null, claimId: derived });
  b.addCapability({ direction: "granted", capability: "program.upgrade", class: "code_control", holder: null, target: null, claimId: derived });
  b.addCapability({ direction: "revoked", capability: "protocol.admin", class: "admin_control", holder: null, target: null, claimId: derived });
  b.addPreview({
    authority: null,
    programId: null,
    confidence: "unknown",
    deployAnyCode: false,
    unlocks: [
      { instruction: "config_change", discriminator: null, changes: "configuration", class: "config" },
      { instruction: "admin_call", discriminator: "00ff", changes: "admin", class: "admin_control" }
    ],
    claimId: conditional
  });
  b.setSimulation({ status: "not_run", summary: "Simulation was not run in this test.", evidenceIds: [] });
  return b.build();
}

describe("canonical JSON", () => {
  it("sorts keys, drops whitespace and matches known digests", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
    expect(canonicalDigest({})).toBe("sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    // Key order is by UTF-16 code unit, as in RFC 8785.
    expect(canonicalJson({ "é": 1, z: 2, A: 3, "😀": 4 })).toBe('{"A":3,"z":2,"é":1,"😀":4}');
    expect(canonicalJson({ n: 1e21, f: 0.1, s: " \n\"" })).toBe('{"f":0.1,"n":1e+21,"s":" \\n\\""}');
  });

  it("rejects values that are not plain JSON", () => {
    for (const bad of [{ a: 1n }, { a: undefined }, { a: NaN }, [Infinity], { a: () => 1 }, new Map(), { d: new Date(0) }]) {
      expect(() => canonicalJson(bad)).toThrow();
    }
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(/cycle/);
  });

  it("converts decoder output to plain JSON", () => {
    const v = toJsonValue({ amount: 18446744073709551615n, bytes: new Uint8Array([1, 2, 3]), m: new Map([[1, "x"]]), skip: undefined, arr: [undefined] });
    expect(v).toEqual({ amount: "18446744073709551615", bytes: { base64: toBase64(new Uint8Array([1, 2, 3])) }, m: { "1": "x" }, arr: [null] });
  });
});

describe("rubrics", () => {
  it("alert-levels-v1: L4 only from Fact claims of the scam-rule list", () => {
    for (const rule of ALERT_LEVELS_V1.l4Rules) {
      expect(levelAllowed("Fact", rule, "L4")).toBe(true);
      for (const kind of ["Derived", "Conditional", "Unknown"] as const) expect(levelAllowed(kind, rule, "L4")).toBe(false);
    }
    expect(levelAllowed("Fact", "lifetime.durable_nonce", "L4")).toBe(false);
    expect(levelAllowed("Fact", null, "L4")).toBe(false);
    expect(levelAllowed("Unknown", null, "L3")).toBe(true);
    expect(maxLevel([])).toBe("L0");
    expect(maxLevel(["L1", "L3", "L2"])).toBe("L3");
  });

  it("capability-risk-v1: code control outranks everything", () => {
    const scores = Object.values(CAPABILITY_RISK_V1.classes).map((c) => c.score);
    expect(new Set(scores).size).toBe(scores.length);
    expect(Math.max(...scores)).toBe(capabilityScore("code_control"));
  });
});

describe("evidence ledger and claim builder", () => {
  it("dedupes identical evidence and keeps ids stable", () => {
    const b = new ReportBuilder(session);
    const a = b.addEvidence({ type: "account", source: "rpc", summary: "s", address: SYSTEM, data: { x: 1n } });
    const a2 = b.addEvidence({ type: "account", source: "rpc", summary: "s", address: SYSTEM, data: { x: 1n } });
    const c = b.addEvidence({ type: "account", source: "rpc", summary: "s", address: SYSTEM, data: { x: 2n } });
    expect([a, a2, c]).toEqual(["e1", "e1", "e2"]);
    expect(() => b.addEvidence({ type: "account", source: "rpc", summary: "s", transactionIndex: 2 })).toThrow(ReportError);
  });

  it("rejects claims that break the contract", () => {
    const b = new ReportBuilder(session);
    const e = b.addEvidence({ type: "message", source: "message", summary: "m", transactionIndex: 0 });
    expect(() => b.addClaim({ kind: "Fact", statement: "no evidence" })).toThrow(/Fact without evidence/);
    expect(() => b.addClaim({ kind: "Derived", statement: "no rule", evidenceIds: [e] })).toThrow(/Derived without ruleId/);
    expect(() => b.addClaim({ kind: "Derived", statement: "nothing", ruleId: "a.b" })).toThrow(/neither evidence nor dependsOn/);
    expect(() => b.addClaim({ kind: "Fact", statement: "dangling", evidenceIds: ["e9"] })).toThrow(/e9 does not resolve/);
    expect(() => b.addClaim({ kind: "Unknown", statement: "forward", dependsOn: ["c5"] })).toThrow(/not an earlier claim/);
    expect(() => b.addClaim({ kind: "Derived", statement: "L4", evidenceIds: [e], ruleId: "wallet.sweep", level: "L4" })).toThrow(/cannot reach L4/);
    expect(() => b.addClaim({ kind: "Fact", statement: "L4", evidenceIds: [e], ruleId: "authority.transfer", level: "L4" })).toThrow(/cannot reach L4/);
    expect(() => b.addCapability({ direction: "granted", capability: "x", class: "other", holder: null, target: null, claimId: "c1" })).toThrow(ReportError);
    const c = b.addClaim({ kind: "Fact", statement: "ok", evidenceIds: [e] });
    expect(c).toBe("c1");
    expect(b.getClaim(c)).toMatchObject({ scope: "transaction", transactionIndices: [0], level: "L0", ruleId: null, assumptions: [] });
  });

  it("an empty report is L0 and valid", () => {
    const r = new ReportBuilder(session).build();
    expect(r.alert).toEqual({ level: "L0", label: "Clear", action: "pass", claimIds: [] });
    expect(validateReport(r).ok).toBe(true);
  });
});

describe("G4: report over the Drift attack session", () => {
  it("validates against the schema and every contract check", () => {
    const r = driftReport();
    const v = validateReport(r);
    expect(v.problems).toEqual([]);
    expect(r.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(r.session.transactions.map((t) => t.messageHash)).toEqual(session.transactions.map((t) => t.messageHash));
    expect(r.session.id).toBe(session.id);
  });

  it("sets the alert level to the highest claim level", () => {
    const r = driftReport();
    expect(r.alert).toEqual({ level: "L3", label: "Critical", action: "hold_block_default", claimIds: ["c3", "c4"] });
  });

  it("ranks capabilities and preview unlocks under capability-risk-v1", () => {
    const r = driftReport();
    expect(r.capabilities.granted.map((c) => [c.rank, c.class, c.score])).toEqual([
      [1, "code_control", 100],
      [2, "admin_control", 90],
      [3, "freeze", 50]
    ]);
    expect(r.capabilities.revoked.map((c) => c.rank)).toEqual([1]);
    expect(r.preview[0]!.unlocks.map((u) => [u.rank, u.instruction])).toEqual([
      [1, "admin_call"],
      [2, "config_change"]
    ]);
  });

  it("counts match and unreferenced evidence is pruned", () => {
    const r = driftReport();
    expect(r.counts).toMatchObject({ claims: 5, granted: 3, revoked: 1, preview: 1, byKind: { Fact: 2, Derived: 1, Conditional: 1, Unknown: 1 }, byLevel: { L0: 1, L1: 1, L2: 1, L3: 2, L4: 0 } });
    expect(r.counts.evidence).toBe(r.evidence.length);
    expect(r.evidence.some((e) => e.summary === "unused")).toBe(false);
    const refs = new Set(r.claims.flatMap((c) => c.evidenceIds));
    expect(r.evidence.every((e) => refs.has(e.id))).toBe(true);
  });

  it("derives transactionIndices and scope from evidence and dependencies", () => {
    const r = driftReport();
    const byId = new Map(r.claims.map((c) => [c.id, c]));
    expect(byId.get("c1")).toMatchObject({ scope: "transaction", transactionIndices: [1] });
    expect(byId.get("c2")).toMatchObject({ scope: "session", transactionIndices: [] });
    expect(byId.get("c3")).toMatchObject({ dependsOn: ["c1"], transactionIndices: [1] });
  });

  it("is deterministic: three builds give byte-identical canonical JSON and digest", () => {
    const runs = [driftReport(), driftReport(), driftReport()];
    expect(new Set(runs.map((r) => canonicalJson(r))).size).toBe(1);
    expect(new Set(runs.map((r) => r.digest)).size).toBe(1);
    expect(runs[0]!.digest).toBe(reportDigest(runs[0]!));
  });

  it("survives a JSON round trip unchanged", () => {
    const r = driftReport();
    const back = JSON.parse(JSON.stringify(r)) as unknown;
    expect(validateReport(back).ok).toBe(true);
    expect(canonicalJson(back)).toBe(canonicalJson(r));
  });
});

describe("G4: the validator rejects broken reports", () => {
  /** Mutate a valid report and recompute the digest unless the mutation targets it. */
  const broken = (mutate: (r: Report) => void, keepDigest = false) => {
    const r = structuredClone(driftReport());
    mutate(r);
    if (!keepDigest) r.digest = reportDigest(r);
    return validateReport(r);
  };
  const cases: [string, (r: Report) => void, RegExp][] = [
    ["schema: extra field", (r) => Object.assign(r.claims[0]!, { extra: 1 }), /schema/],
    ["schema: unknown kind", (r) => Object.assign(r.claims[0]!, { kind: "Opinion" }), /schema/],
    ["schema: wrong rubric id", (r) => Object.assign(r.rubrics, { alertLevels: "alert-levels-v0" }), /schema/],
    ["dangling evidence", (r) => r.claims[0]!.evidenceIds.push("e999"), /e999 does not resolve/],
    ["dangling dependsOn", (r) => r.claims[2]!.dependsOn.push("c99"), /c99 does not resolve/],
    ["forward dependsOn (cycle)", (r) => r.claims[0]!.dependsOn.push("c3"), /not an earlier claim/],
    ["dangling capability claim", (r) => (r.capabilities.granted[0]!.claimId = "c42"), /c42 does not resolve/],
    ["dangling preview claim", (r) => (r.preview[0]!.claimId = "c42"), /c42 does not resolve/],
    ["dangling simulation evidence", (r) => r.simulation.evidenceIds.push("e77"), /e77 does not resolve/],
    ["tx index out of range", (r) => r.claims[0]!.transactionIndices.push(5), /out of range/],
    ["claim count", (r) => (r.counts.claims += 1), /counts.claims/],
    ["evidence count", (r) => (r.counts.evidence -= 1), /counts.evidence/],
    ["kind count", (r) => (r.counts.byKind.Fact += 1), /counts.byKind.Fact/],
    ["level count", (r) => (r.counts.byLevel.L3 -= 1), /counts.byLevel.L3/],
    ["rank swap", (r) => r.capabilities.granted.reverse(), /rank|rubric order/],
    ["score off rubric", (r) => (r.capabilities.granted[0]!.score = 99), /does not match code_control/],
    ["preview rank", (r) => r.preview[0]!.unlocks.reverse(), /rank|rubric order/],
    ["Fact without evidence", (r) => (r.claims[0]!.evidenceIds = []), /Fact without evidence/],
    ["Derived without ruleId", (r) => (r.claims[2]!.ruleId = null), /Derived without ruleId/],
    ["Derived claim at L4", (r) => (r.claims[2]!.level = "L4"), /cannot reach L4/],
    ["alert level too low", (r) => (r.alert.level = "L2"), /alert.level/],
    ["alert claims", (r) => r.alert.claimIds.pop(), /alert.claimIds/],
    ["orphan evidence", (r) => (r.simulation.evidenceIds = [], r.claims.forEach((c) => (c.evidenceIds = c.evidenceIds.filter((e) => e !== r.evidence[0]!.id)))), /not referenced|Fact without/],
    ["duplicate claim id", (r) => (r.claims[1]!.id = r.claims[0]!.id), /duplicate id|not ascending/]
  ];
  it.each(cases)("%s", (_name, mutate, problem) => {
    const v = broken(mutate);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(problem);
  });

  // E17: the zod/mini schema decides every mutant exactly like the full-zod schema it replaced.
  it("full zod and zod/mini agree on the report and every mutant", () => {
    expect(schemaDifference(driftReport())).toBeNull();
    for (const [name, mutate] of cases) {
      const r = structuredClone(driftReport());
      mutate(r);
      r.digest = reportDigest(r);
      expect(schemaDifference(r), name).toBeNull();
    }
  });

  it("detects a tampered statement through the digest", () => {
    const v = broken((r) => (r.claims[0]!.statement = "Nothing to see here."), true);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(/digest/);
  });

  it("rejects non-objects", () => {
    for (const x of [null, 1, "report", [], {}]) expect(validateReport(x).ok).toBe(false);
  });
});
