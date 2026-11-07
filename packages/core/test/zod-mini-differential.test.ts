// E17: the report schema moved from full zod to zod/mini (named outside report-*.test.ts so G4 stays fast). The kelvara-report-v1 contract must not change,
// so the old full-zod schema (report-schema-full.ts, test only) and the new one must give the same verdict
// (accept/reject), the same parsed output and the same issue paths and codes on:
//  - every report the engine makes from recorded real data: analyzeSession on all recorded analyze
//    scenarios (real localnet/Helius RPC) and the offline rule pass over every fixture session;
//  - mutants of those reports: every node replaced by each value of a hostile set (wrong types, null,
//    NaN, infinities, unsafe and fractional numbers, bad strings), every object key deleted, an extra
//    key on every object, a bad element appended to every array;
//  - top-level junk. The 24 G4 mutants are checked the same way in report-contract.test.ts.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSession, type Report } from "../src/index.js";
import { schemaCompare, schemaDifference } from "./report-schema-full.js";
import { analyze, decoder, json, manifestFixtures, replay, root, ruleFixtures, sessionOf, squadsAccounts } from "./rules-helpers.js";

type Node = Record<string, unknown> | unknown[];
const HOSTILE: unknown[] = [null, true, 0, -1, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, "", "x", "c0", "e01", "L5", "1".repeat(45), [], {}];

/** Calls `check` on every mutant of a report, mutated in place and restored afterwards. */
function forEachMutant(report: Report, check: (what: string, mutant: unknown) => void): void {
  const visit = (parent: Node, key: string | number, p: string) => {
    const obj = parent as Record<string | number, unknown>;
    const node = obj[key];
    for (const v of HOSTILE) {
      obj[key] = v;
      check(`${p} = ${String(v)}`, report);
    }
    obj[key] = node;
    if (!Array.isArray(parent)) {
      const entries = Object.entries(parent);
      delete obj[key];
      check(`delete ${p}`, report);
      for (const k of Object.keys(parent)) delete obj[k];
      for (const [k, v] of entries) obj[k] = v; // original key order
    }
    if (node && typeof node === "object") {
      if (Array.isArray(node)) {
        node.push("bad");
        check(`extend ${p}`, report);
        node.pop();
      } else {
        (node as Record<string, unknown>).extra = 1;
        check(`extend ${p}`, report);
        delete (node as Record<string, unknown>).extra;
      }
      if (Array.isArray(node)) node.forEach((_x, i) => visit(node, i, `${p}.${i}`));
      else for (const k of Object.keys(node)) visit(node as Node, k, `${p}.${k}`);
    }
  };
  for (const k of Object.keys(report)) visit(report as unknown as Node, k, k);
}

async function recordedReports(): Promise<[string, Report][]> {
  const out: [string, Report][] = [];
  const dir = path.join(root, "packages/core/test/fixtures/analyze");
  for (const f of readdirSync(dir).sort()) {
    const r = json(`packages/core/test/fixtures/analyze/${f}`);
    const { rpc } = replay(r);
    const opts = { decoder, squadsAccounts, rpc, ...(r.inputs.wallet ? { wallet: r.inputs.wallet } : {}), ...(r.inputs.inventory ? { inventory: true } : {}), ...(r.inputs.simulate === false ? { simulate: false } : {}) };
    out.push([`analyze/${f}`, (await analyzeSession(await sessionOf(r.inputs.transactions), opts)).report]);
  }
  for (const f of manifestFixtures()) {
    if (f.loaded && f.loaded.writable.length + f.loaded.readonly.length > 0) continue; // needs runtime tables; covered by G3
    out.push([f.path, analyze(await sessionOf([f.base64]))]);
  }
  for (const f of ruleFixtures) out.push([`rules/${f.signature}`, analyze(await sessionOf([f.transaction]))]);
  return out;
}

describe("E17: zod/mini report schema == full zod report schema", () => {
  it("same verdict, output and issues on every recorded report and its mutants", async () => {
    const reports = await recordedReports();
    expect(reports.length).toBeGreaterThan(50);
    let checked = 0, rejected = 0;
    const diffs: string[] = [];
    for (const [name, report] of reports) {
      const d = schemaDifference(report);
      if (d) diffs.push(`${name}: ${d}`);
      checked++;
      // Every 5th mutant of the two demo stories (admin-local, trap-local), every 13th of the other analyzed
      // scenarios, every 37th elsewhere (strides coprime with the 18 mutations per node, so every kind of
      // mutation lands on every part of the report). KELVARA_FULL_DIFF=1 checks every mutant (~155k inputs, ~65 s).
      const full = name.startsWith("analyze/");
      const stride = process.env.KELVARA_FULL_DIFF === "1" ? 1 : name.includes("admin-local") || name.includes("trap-local") ? 5 : full ? 13 : 37;
      const before = JSON.stringify(report);
      let i = 0;
      forEachMutant(report, (what, m) => {
        if (i++ % stride) return;
        const { difference, accepted } = schemaCompare(m);
        if (difference) diffs.push(`${name} ${what}: ${difference}`);
        checked++;
        if (!accepted) rejected++;
      });
      expect(JSON.stringify(report), `${name} restored`).toBe(before);
    }
    for (const junk of [undefined, null, 0, "report", [], {}, { schemaVersion: "kelvara-report-v1" }]) {
      const d = schemaDifference(junk);
      if (d) diffs.push(`junk ${String(junk)}: ${d}`);
    }
    console.log(`E17 schema differential: ${reports.length} reports, ${checked} inputs, ${rejected} mutants rejected by both`);
    expect(diffs.slice(0, 20)).toEqual([]);
    expect(rejected).toBeGreaterThan(1000);
  }, 120_000);
});
