/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// E14: analyzeSession end to end on recorded real RPC responses (packages/core/test/fixtures/analyze,
// `pnpm --filter @kelvara/core fixtures:analyze`): the G6 stories on localnet and the Drift replay on
// Helius mainnet; offline mode; failed reads stay "not read"; simulated inner instructions in decoded form.
import { describe, expect, it } from "vitest";
import { analyzeSession, buildAuthorityMap, createRpcClient, squadsTransactionPda, type AnchorIdlJson, type Report } from "../src/index.js";
import { byRule, decoder, DRIFT_1, DRIFT_2, driftTx, json, replay, sessionOf, squadsAccounts, type Recording } from "./rules-helpers.js";

const authorityMaps = [
  buildAuthorityMap(json<AnchorIdlJson>("packages/idls/raw/drift-v2.json"), { programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", source: "packages/idls/raw/drift-v2.json", verified: false }),
  buildAuthorityMap(json<AnchorIdlJson>("packages/scenarios/programs/marginfi_v2.idl.json"), { source: "packages/scenarios/programs/marginfi_v2.idl.json", verified: false })
];
type AnalyzeRecording = Recording & { inputs: { transactions: string[]; wallet?: string; simulate?: boolean; [k: string]: any } };
const rec = (name: string): AnalyzeRecording => json<AnalyzeRecording>(`packages/core/test/fixtures/analyze/${name}.json`);

async function runRecorded(name: string) {
  const r = rec(name);
  const { rpc } = replay(r);
  const session = await sessionOf(r.inputs.transactions);
  const out = await analyzeSession(session, {
    decoder,
    squadsAccounts,
    authorityMaps,
    rpc,
    ...(r.inputs.wallet ? { wallet: r.inputs.wallet } : {}),
    ...(r.inputs.simulate === false ? { simulate: false } : {})
  });
  return { ...out, rec: r };
}
const ruleIds = (r: Report) => new Set(r.claims.map((c) => c.ruleId));

describe("analyzeSession on recorded real RPC", () => {
  it("G6 admin-local: Member A's approval is critical: inner SetAuthority, durable nonce, outsider funder, zero time lock; simulation shows only the fee", async () => {
    const { report, reads, rec: r } = await runRecorded("admin-local");
    expect(reads.filter((x) => !x.ok)).toEqual([]);
    expect(report.alert).toMatchObject({ level: "L3", label: "Critical" });
    const t = byRule(report, "authority.transfer")[0]!;
    expect(t).toMatchObject({ level: "L3", kind: "Fact" });
    expect(t.statement).toContain("setAuthority");
    expect(t.statement).toContain(r.inputs.attacker);
    expect(byRule(report, "lifetime.durable_nonce")[0]!.level).toBe("L3");
    const outsider = byRule(report, "nonce.staged_by_outsider")[0]!;
    expect(outsider).toMatchObject({ kind: "Fact", level: "L3" });
    expect(outsider.statement).toContain(r.inputs.nonce.funder.slice(0, 4));
    expect(byRule(report, "squads.zero_timelock_execution")).toHaveLength(1);
    expect(byRule(report, "squads.unknown_proposal")).toEqual([]); // content read via the transaction PDA
    // The proposal names no transaction account; the PDA derived from (multisig, index) is the scenario's.
    expect(await squadsTransactionPda(r.inputs.multisig, 1n)).toBe(r.inputs.vaultTransaction);
    expect(report.preview.find((p) => p.deployAnyCode)?.programId).toBe(r.inputs.demoProgram);
    expect(report.simulation.status).toBe("ok");
    expect(report.simulation.summary).toMatch(/^Simulation shows: Transaction 0: \w+ -0\.000005 SOL$/);
    expect(report.simulation.evidenceIds.every((id) => report.evidence.find((e) => e.id === id)?.type === "simulation")).toBe(true);
  });

  it("G6 trap-local: the $SHINY buy is L2 Warning with permanent delegate and freeze authority; simulation shows the normal purchase", async () => {
    const { report, reads, rec: r } = await runRecorded("trap-local");
    expect(reads.filter((x) => !x.ok)).toEqual([]);
    expect(report.alert).toMatchObject({ level: "L2", label: "Warning" });
    for (const id of ["token2022.permanent_delegate", "token.freeze_authority"]) {
      const c = byRule(report, id)[0]!;
      expect(c, id).toMatchObject({ kind: "Fact", level: "L2" });
      expect(c.statement).toContain(r.inputs.creator);
    }
    expect(report.simulation.status).toBe("ok");
    expect(report.simulation.summary).toContain(`${r.inputs.user} -1.`);
    expect(report.simulation.summary).toContain(`${r.inputs.user} +50000 of mint ${r.inputs.mint}`);
    expect(report.claims.every((c) => c.level !== "L4")).toBe(true);
  });

  it("G8 Drift replay on recorded Helius state: critical with durable nonce, approve-and-execute, updateAdmin, outsider-funded nonces", async () => {
    const { report, reads } = await runRecorded("drift-replay-mainnet");
    expect(reads.filter((x) => !x.ok)).toEqual([]);
    expect(report.alert.level).toBe("L3");
    const ids = ruleIds(report);
    for (const id of ["lifetime.durable_nonce", "squads.approve_and_execute", "authority.transfer", "nonce.staged_by_outsider", "squads.zero_timelock_execution"]) expect(ids.has(id), id).toBe(true);
    expect(byRule(report, "authority.transfer").some((c) => /updateAdmin/.test(c.statement))).toBe(true);
    expect(report.simulation.status).toBe("not_run");
  });
});

describe("analyzeSession offline and on failure", () => {
  it("offline Drift replay: still critical with the three G8 claims; unread facts are Unknown, never safe", async () => {
    const session = await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]);
    const { report, reads } = await analyzeSession(session, { decoder, squadsAccounts, authorityMaps });
    expect(reads).toEqual([]);
    expect(report.alert.level).toBe("L3");
    expect(byRule(report, "lifetime.durable_nonce").length).toBe(2);
    expect(byRule(report, "squads.approve_and_execute").length).toBe(1);
    expect(byRule(report, "authority.transfer")[0]!.statement).toMatch(/updateAdmin/);
    expect(byRule(report, "nonce.staged_by_outsider").every((c) => c.kind === "Unknown")).toBe(true);
  });

  it("an RPC that fails every call: reads are noted as failed, the report is still built and validated", async () => {
    const fetchFn = (async () => new Response("down", { status: 400 })) as typeof fetch;
    const rpc = createRpcClient({ url: "http://localhost:8899", fetch: fetchFn, maxRps: 1000, sleep: async () => {}, maxRetries: 0 } as any);
    const r = rec("admin-local");
    const { report, reads } = await analyzeSession(await sessionOf(r.inputs.transactions), { decoder, squadsAccounts, authorityMaps, rpc });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((x) => !x.ok)).toBe(true);
    expect(report.simulation.status).toBe("not_run");
    expect(byRule(report, "lifetime.durable_nonce")[0]!.level).not.toBe("L0");
    expect(byRule(report, "squads.unknown_proposal")[0]!.kind).toBe("Unknown");
  });

  it("simulated inner instructions in Agave's parsed and partially decoded forms are kept, not a crash", async () => {
    const r = rec("trap-local");
    const sim = r.calls.find((c) => c.method === "simulateTransaction" && (c.result as any).value.innerInstructions)!;
    const inner = (sim.result as any).value.innerInstructions as { instructions: any[] }[];
    expect(inner.flatMap((g) => g.instructions).some((ix) => ix.programIdIndex === undefined)).toBe(true); // recorded decoded form
    const { state } = await runRecorded("trap-local");
    const ixs = state.simulations![0]!.innerInstructions;
    expect(ixs.length).toBeGreaterThan(0);
    for (const ix of ixs) expect(ix.programId ?? ix.programIdIndex).not.toBeNull();
    expect(ixs.some((ix) => ix.parsed !== null && ix.data === null)).toBe(true);
    expect(state.simulations![0]!.blockhashReplaced).toBe(true); // stated in the summary
    expect((await runRecorded("trap-local")).report.simulation.summary).toContain("replaced blockhash");
  });
});
