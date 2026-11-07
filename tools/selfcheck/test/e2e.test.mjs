// Self-tests for the G7 report classifier (tools/selfcheck/src/e2e-checks.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReport, gateVerdict } from "../src/e2e-checks.mjs";

const spec = (title, status, annotations = [], extra = {}) => ({
  title,
  file: "x.spec.ts",
  tests: [{ status: extra.testStatus ?? (status === "passed" ? "expected" : status === "skipped" ? "skipped" : "unexpected"), annotations, results: [{ status, annotations, errors: extra.errors ?? [] }] }]
});
const report = (...specs) => ({ suites: [{ title: "x.spec.ts", specs, suites: [] }], errors: [] });
const P = [{ type: "pending", description: "report UI not landed: x" }];

test("all passed -> PASS", () => {
  const r = classifyReport(report(spec("a", "passed"), spec("b", "passed")));
  assert.equal(gateVerdict(r), "PASS");
});
test("skipped with a pending annotation -> PENDING with its reason", () => {
  const r = classifyReport(report(spec("a", "passed"), spec("b", "skipped", P)));
  assert.equal(gateVerdict(r), "PENDING");
  assert.equal(r.cases[1].detail, "report UI not landed: x");
});
test("plain skip -> FAIL", () => {
  assert.equal(gateVerdict(classifyReport(report(spec("a", "skipped")))), "FAIL");
});
test("failure beats pending", () => {
  const r = classifyReport(report(spec("a", "skipped", P), spec("b", "failed", [], { errors: [{ message: "\u001b[31mexpected 0\u001b[39m\nmore" }] })));
  assert.equal(gateVerdict(r), "FAIL");
  assert.equal(r.cases[1].detail, "expected 0 | more");
});
test("timedOut and flaky -> FAIL", () => {
  assert.equal(gateVerdict(classifyReport(report(spec("a", "timedOut")))), "FAIL");
  assert.equal(gateVerdict(classifyReport(report(spec("a", "passed", [], { testStatus: "flaky" })))), "FAIL");
});
test("no tests or a global error -> FAIL", () => {
  assert.equal(gateVerdict(classifyReport({ suites: [], errors: [] })), "FAIL");
  assert.equal(gateVerdict(classifyReport({ ...report(spec("a", "passed")), errors: [{ message: "webServer failed" }] })), "FAIL");
});
test("nested describe titles are joined", () => {
  const r = classifyReport({ suites: [{ title: "f.spec.ts", specs: [], suites: [{ title: "group", specs: [spec("case", "passed")] }] }], errors: [] });
  assert.equal(r.cases[0].name, "x.spec.ts: group › case");
});
