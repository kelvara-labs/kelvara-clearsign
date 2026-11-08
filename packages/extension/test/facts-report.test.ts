// X19: E23 facts rendered as plain language, on reports built by the engine's own rules over real fixtures.
import { describe, expect, it } from "vitest";
import { ReportBuilder, ingestSession } from "@kelvara/core";
import { validateReportView } from "../src/shared/report-view.js";
import { fromReport } from "../src/sw/from-report.js";
import { humanSimulation, solText } from "../src/sw/facts-text.js";
import { analyze, analyzedState, manifestFixtures, sessionOf } from "../../core/test/rules-helpers.js";

const hashesOf = (r: { session: { transactions: { messageHash: string }[] } }) => r.session.transactions.map((t) => t.messageHash);
const view = (r: Parameters<typeof hashesOf>[0] & Parameters<typeof fromReport>[0]) => {
  const m = fromReport(r, hashesOf(r as never));
  if (!m.ok) throw new Error(m.reason);
  expect(validateReportView(m.report)).not.toBeNull();
  return m;
};
async function fixtureReport(dir: string, pick: (names: string[]) => boolean) {
  for (const f of manifestFixtures().filter((x) => x.path.includes(dir))) {
    const session = await sessionOf([f.base64]);
    const r = analyze(session);
    const names = r.claims.map((c) => c.ruleId ?? "");
    if (pick(names)) return r;
  }
  throw new Error(`no fixture in ${dir}`);
}

describe("L0 facts as readable text", () => {
  it("memo + token transfer + priority fee (real mainnet): lines, summary and title", async () => {
    const r = await fixtureReport("/memo/", (n) => n.includes("fact.memo") && n.includes("fact.priority_fee"));
    const m = view(r);
    expect(m.level).toBe(0);
    expect(m.report.title).toMatch(/^No risks found · /);
    expect(m.report.authorizes).toContain("Signs a memo: “pumpfun-b9aad98d-72cb-4802-bb81-f656104bf552”.");
    expect(m.report.authorizes).toContain("Sends 50000000 base units (decimals not read) to token account B73ttuVCWzLmTHr5D2MGxMGYVzL4zj8MmSPLvqE8d9qV.");
    expect(m.report.authorizes).toContain("Fees: 0.00001 SOL network + up to 0.000000006 SOL priority.");
    expect(m.report.authorizes).toContain("Fees: 0.00001 SOL network");
    expect(m.report.authorizes).toMatch(/No authority, delegate, owner or upgrade permission changes\.\nFees: [^.]+\.[0-9]+ SOL network \+ up to [0-9.]+ SOL priority\.$/);
    expect(m.report.authorizes).not.toContain("Unknown");
    expect(m.report.summary).toBe("This transaction signs a memo and sends tokens. No authority, delegate, owner or upgrade permission changes.");
    expect(m.report.summary).not.toMatch(/claim\(s\)|change\(s\)/);
  });

  it("SOL transfer + priority fee (real mainnet)", async () => {
    const r = await fixtureReport("/first-send/", (n) => n.includes("fact.sol_transfer") && n.includes("fact.priority_fee"));
    const m = view(r);
    expect(m.report.authorizes).toMatch(/^Sends [\d.]+ SOL to \w+\.\nNo authority, delegate, owner or upgrade permission changes\.\nFees: 0\.000005 SOL network \+ up to [\d.]+ SOL priority\.$/);
    expect(m.report.summary).toMatch(/^This transaction sends [\d.]+ SOL\. No authority/);
    expect(m.report.claims.filter((c) => c.rule?.startsWith("fact.")).length).toBe(4);
  });

  it("admin L3 (recorded localnet run): grants first, then the facts; no 'no permission change' line", async () => {
    const { report } = await analyzedState("admin-local");
    const m = view(report);
    expect(m.level).toBe(3);
    expect(m.report.authorizes!.startsWith("Grants ")).toBe(true);
    expect(m.report.authorizes).toMatch(/Signs a memo: “/);
    expect(m.report.authorizes).not.toContain("No authority, delegate, owner or upgrade permission changes.");
    expect(m.report.title).toBe("Hands program upgrade control to another key");
    expect(m.report.moreRisks).toBe(2);
    expect(m.report.fullTitle).toMatch(/^Critical: /);
    expect(m.report.simulation).toMatch(/^The SOL balance of fee payer \w+ changes by −0\.000005 SOL \(network fee 0\.000005 SOL\)$/);
    expect(m.report.summary).not.toMatch(/claim\(s\)|change\(s\)/);
    expect(m.report.keyRisks!.map((k) => k.headline)).toEqual(["Hands program upgrade control to another key", "Never expires, so it can be submitted later", "Set up by an outside account"]);
  });

  it("trap L2 (recorded localnet run): risk claims stay, facts describe the transfers", async () => {
    const { report } = await analyzedState("trap-local");
    const m = view(report);
    expect(m.level).toBe(2);
    expect(m.report.authorizes).toMatch(/Sends 1 SOL to \w+\./);
    expect(m.report.authorizes).toMatch(/Sends 0\.00005 of token mint|Sends .*token/);
    expect(m.report.claims.map((c) => c.rule)).toEqual(expect.arrayContaining(["token2022.permanent_delegate", "fact.sol_transfer"]));
    expect(m.report.simulation).toContain("(simulated with a replaced blockhash)");
    expect(m.report.simulation).toContain("−1.00208408 SOL");
  });

  it("old reports without facts still render: Unknown names the instructions; empty report is L0", async () => {
    const session = await ingestSession([{ base64: manifestFixtures().find((f) => f.path.includes("/memo/"))!.base64, kind: "wire" }]);
    const empty = new ReportBuilder(session).build();
    const m = view(empty);
    expect(m.level).toBe(0);
    expect(m.report.authorizes).toBeNull();
    expect(m.report.summary).toContain("could not describe");
  });
});

describe("simulation text", () => {
  it.each([
    ["Simulation shows: Transaction 0: Your SOL balance changes by -0.000008864 SOL (network fee 0.000005 SOL + priority fee up to 0.000003864 SOL)", 1, "Your SOL balance changes by −0.000008864 SOL (network fee 0.000005 SOL + priority fee up to 0.000003864 SOL)"],
    ["Simulation shows: Transaction 0 (simulated with a replaced blockhash): A -1 SOL; B +1 SOL", 1, "(simulated with a replaced blockhash) A −1 SOL; B +1 SOL"],
    ["Simulation shows: Transaction 0 of 2: A -1 SOL; Transaction 1 of 2: fails ({})", 2, "Transaction 0 of 2: A −1 SOL; Transaction 1 of 2: fails ({})"]
  ])("%s", (text, n, expected) => expect(humanSimulation(text, n)).toBe(expected));
  it("sol amounts", () => {
    expect(solText("16972958")).toBe("0.016972958 SOL");
    expect(solText(1_000_000_000n)).toBe("1 SOL");
    expect(solText("x")).toBeNull();
  });
});
