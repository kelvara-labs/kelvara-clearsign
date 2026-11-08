/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// G9 (M7 / E15): three runs of the full analysis on recorded real RPC give identical report and
// explanation digests; templates cover every ruleId and keep the template rules (no numbers, no
// addresses, no "will"). The AI-output validator half of G9 is cut with on-device AI (coordinator, E15).
import { describe, expect, it, vi } from "vitest";
import {
  ALL_RULE_IDS,
  analyzeSession,
  buildAuthorityMap,
  canonicalJson,
  explainReport,
  FALLBACK_TEMPLATE,
  reportDigest,
  RULE_TEMPLATES,
  validateReport,
  type AnchorIdlJson,
  type Report
} from "../src/index.js";
import { decoder, json, replay, sessionOf, squadsAccounts, type Recording } from "./rules-helpers.js";

const authorityMaps = [
  buildAuthorityMap(json<AnchorIdlJson>("packages/idls/raw/drift-v2.json"), { programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", source: "packages/idls/raw/drift-v2.json", verified: false }),
  buildAuthorityMap(json<AnchorIdlJson>("packages/scenarios/programs/marginfi_v2.idl.json"), { source: "packages/scenarios/programs/marginfi_v2.idl.json", verified: false })
];
type AnalyzeRecording = Recording & { recordedAt: string; inputs: { transactions: string[]; wallet?: string; simulate?: boolean; [k: string]: any } };

/** One fresh run: new replayed RPC client (empty cache), new session parse, full analysis. */
async function run(name: string): Promise<Report> {
  const r = json<AnalyzeRecording>(`packages/core/test/fixtures/analyze/${name}.json`);
  const { rpc } = replay(r);
  const session = await sessionOf(r.inputs.transactions);
  // History window time is an analysis input: replay the recorded clock, not wall-clock seconds.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(r.recordedAt));
  try {
    const { report } = await analyzeSession(session, {
      decoder,
      squadsAccounts,
      authorityMaps,
      rpc,
      ...(r.inputs.wallet ? { wallet: r.inputs.wallet } : {}),
      ...(r.inputs.simulate === false ? { simulate: false } : {})
    });
    return report;
  } finally { clock.mockRestore(); }
}

const SCENARIOS = ["admin-local", "trap-local", "drift-replay-mainnet"];

describe("G9 determinism", () => {
  for (const name of SCENARIOS) {
    it(`${name}: three runs give identical report and explanation digests`, async () => {
      const reports: Report[] = [];
      for (let i = 0; i < 3; i++) reports.push(await run(name));
      const digests = reports.map((r) => r.digest);
      expect(new Set(digests).size, digests.join(" ")).toBe(1);
      const bytes = reports.map((r) => canonicalJson(r));
      expect(bytes[1]).toBe(bytes[0]);
      expect(bytes[2]).toBe(bytes[0]);
      for (const r of reports) {
        expect(validateReport(r).problems).toEqual([]);
        expect(reportDigest(JSON.parse(JSON.stringify(r)))).toBe(r.digest); // survives a JSON round trip
      }
      const ex = reports.map(explainReport);
      expect(new Set(ex.map((e) => e.digest)).size).toBe(1);
      expect(ex[0]!.reportDigest).toBe(digests[0]);
      // Every claim is explained, by its own template, alert claims first.
      expect(ex[0]!.claims.map((c) => c.claimId).sort()).toEqual(reports[0]!.claims.map((c) => c.id).sort());
      expect(ex[0]!.claims.filter((c) => c.ruleId && c.source !== "template")).toEqual([]);
      expect(ex[0]!.claims.slice(0, reports[0]!.alert.claimIds.length).map((c) => c.claimId)).toEqual(reports[0]!.alert.claimIds);
    });
  }

  it("explanations carry the claim statement verbatim and the headline names the alert claims", async () => {
    const report = await run("admin-local");
    const ex = explainReport(report);
    for (const c of ex.claims) expect(c.text).toContain(report.claims.find((k) => k.id === c.claimId)!.statement.trim());
    expect(ex.headline.startsWith(`${report.alert.label}: `)).toBe(true);
    expect(ex.headline).toContain(RULE_TEMPLATES["authority.transfer"]!.title);
  });
});

describe("G9 templates", () => {
  it("cover every ruleId exactly (no missing, no stale)", () => {
    expect(ALL_RULE_IDS.length).toBeGreaterThan(0);
    expect(Object.keys(RULE_TEMPLATES).sort()).toEqual([...ALL_RULE_IDS].sort());
  });

  it("carry no numbers, no addresses and never say 'will' (specifics come from claims; consequences stay 'can'/'may')", () => {
    for (const [id, t] of [...Object.entries(RULE_TEMPLATES), ["fallback", FALLBACK_TEMPLATE] as const]) {
      for (const text of [t.title, t.why, t.advice]) {
        expect(text.trim().length, id).toBeGreaterThan(0);
        expect(text, id).not.toMatch(/[0-9]/);
        expect(text, id).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
        expect(text, id).not.toMatch(/\bwill\b|\bwon't\b/i);
      }
    }
  });
});
