// Self-tests for the G8 checker on hand-written report shapes (not transactions: no fixture data).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReplay, parseReportOutput, findLevel } from "../src/replay-checks.mjs";

const claims = [
  { id: "c1", ruleId: "lifetime.durable_nonce", kind: "Derived" },
  { id: "c2", ruleId: "squads.approve_and_execute", kind: "Derived" },
  { id: "c3", ruleId: "authority.transfer", kind: "Derived", statement: "Drift v2 updateAdmin hands admin to a new key" }
];

test("critical report with all three claims passes", () => {
  const r = evaluateReplay({ level: "critical", claims });
  assert.equal(r.status, "PASS", r.detail);
});

test("nested level and L4 are accepted", () => {
  assert.equal(evaluateReplay({ session: { severity: "L4" }, transactions: [{ claims }] }).status, "PASS");
  assert.deepEqual(findLevel({ summary: { verdict: { level: "critical" } } }), { path: "summary.verdict.level", value: "critical" });
});

test("high is not critical", () => {
  const r = evaluateReplay({ level: "high", claims });
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /need critical/);
});

test("each missing claim is named", () => {
  const r = evaluateReplay({ level: "critical", claims: [claims[0]] });
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /missing claim approve-and-execute/);
  assert.match(r.detail, /missing claim UpdateAdmin/);
  assert.equal(evaluateReplay(null).status, "FAIL");
  assert.equal(evaluateReplay({ claims }).status, "FAIL");
});

test("ruleIds are matched exactly, not by keyword", () => {
  const loose = [
    { id: "x1", ruleId: "durable-nonce-approval", statement: "durable nonce" },
    { id: "x2", ruleId: "squads-approve-and-execute" },
    { id: "x3", ruleId: "authority-handoff", instruction: "UpdateAdmin" }
  ];
  const r = evaluateReplay({ level: "critical", claims: loose });
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /missing claim durable-nonce \(lifetime\.durable_nonce\)/);
});

test("authority.transfer must name updateAdmin", () => {
  const other = [claims[0], claims[1], { id: "c4", ruleId: "authority.transfer", statement: "upgrade authority moved" }];
  const r = evaluateReplay({ level: "critical", claims: other });
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /authority\.transfer does not name/);
});

test("report JSON after log lines is parsed", () => {
  assert.deepEqual(parseReportOutput('fetching...\ncache hit\n{"level":"critical"}\n'), { level: "critical" });
  assert.equal(parseReportOutput("no json here"), null);
});

test("fixture check verifies signature, network and sha256", async () => {
  const { checkTxFixture } = await import("../src/replay-checks.mjs");
  const { createHash } = await import("node:crypto");
  const { Buffer } = await import("node:buffer");
  const h = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
  const tx = Buffer.from("not a real tx, hash test only").toString("base64");
  const good = { signature: "SIG1", network: "mainnet", transaction: tx, sha256: h(tx) };
  assert.equal(checkTxFixture(good, "SIG1", h).status, "PASS");
  assert.equal(checkTxFixture({ ...good, sha256: "00" }, "SIG1", h).status, "FAIL");
  assert.equal(checkTxFixture(good, "SIG2", h).status, "FAIL");
  assert.equal(checkTxFixture({ ...good, network: "devnet" }, "SIG1", h).status, "FAIL");
});
