// E23: L0 facts for benign transactions, on real mainnet fixtures. Facts are descriptive: kind Fact, level L0,
// never in alert.claimIds, never change the level. Explicit synthetic mutations are marked as such.
import { describe, expect, it } from "vitest";
import {
  addSimulationSummary,
  decodeComputeBudgetInstruction,
  explainReport,
  FACT_RULE_IDS,
  ReportBuilder,
  runRules,
  transactionFeeFacts,
  type DecodedInstruction,
  type Report,
  type RuleState,
  type Session
} from "../src/index.js";
import type { SimulationResult } from "../src/simulate/index.js";
import { analyze, decoder, manifestFixtures, sessionFromRuntime, sessionOf } from "./rules-helpers.js";

const budget = (...bytes: number[]) => new Uint8Array(bytes);
const u32 = (tag: number, v: number) => budget(tag, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
const fx = (part: string) => manifestFixtures().find((f) => f.path.includes(part))!;
const facts = (r: Report, id: string) => r.claims.filter((c) => c.ruleId === id);

function build(session: Session, decoded: DecodedInstruction[][], state: RuleState = {}): Report {
  const report = new ReportBuilder(session);
  runRules({ session, decoded, decoder, report, state });
  return report.build();
}

describe("Compute Budget decoder", () => {
  it("names the four settings with exact lengths and leaves everything else unknown", () => {
    expect(decodeComputeBudgetInstruction(u32(1, 65536))).toMatchObject({ name: "requestHeapFrame", args: { bytes: 65536 }, accountNames: [] });
    expect(decodeComputeBudgetInstruction(u32(2, 200000))).toMatchObject({ name: "setComputeUnitLimit", args: { units: 200000 } });
    expect(decodeComputeBudgetInstruction(budget(3, 0xa0, 0x86, 1, 0, 0, 0, 0, 0))).toMatchObject({ name: "setComputeUnitPrice", args: { microLamports: 100000n } });
    expect(decodeComputeBudgetInstruction(u32(4, 64000))).toMatchObject({ name: "setLoadedAccountsDataSizeLimit", args: { bytes: 64000 } });
    expect(decodeComputeBudgetInstruction(budget(2, 1, 2, 3))).toBeNull();
    expect(decodeComputeBudgetInstruction(budget(2, 1, 2, 3, 4, 5))).toBeNull();
    expect(decodeComputeBudgetInstruction(budget(3, 1, 0, 0, 0))).toBeNull();
    expect(decodeComputeBudgetInstruction(u32(0, 1))).toBeNull();
    expect(decodeComputeBudgetInstruction(budget())).toBeNull();
  });

  it("names every real mainnet Compute Budget instruction", async () => {
    let seen = 0;
    for (const f of manifestFixtures().filter((x) => x.path.includes("/compute-budget/"))) {
      for (const ix of decoder.decodeSession(await sessionOf([f.base64])).flat().filter((i) => i.programAddress === "ComputeBudget111111111111111111111111111111")) {
        expect(ix.status, f.path).toBe("named");
        expect(ix.decoder).toBe("builtin");
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(4);
  });
});

describe("benign facts on real fixtures", () => {
  it("SOL transfer with Compute Budget: transfer, priority fee, network fee, no permission change; routine intent", async () => {
    const f = manifestFixtures().filter((x) => x.path.includes("/first-send/") || x.path.includes("/memo/"));
    let checked = 0;
    for (const x of f) {
      const session = await sessionOf([x.base64]);
      const decoded = decoder.decodeSession(session);
      const flat = decoded.flat();
      if (flat.length !== 3 || flat[2]!.name !== "transferSol" || flat[0]!.programAddress !== "ComputeBudget111111111111111111111111111111" || flat[1]!.programAddress !== "ComputeBudget111111111111111111111111111111") continue;
      const r = analyze(session);
      const fee = transactionFeeFacts(session, decoded)[0]!;
      const transfer = facts(r, "fact.sol_transfer");
      expect(transfer).toHaveLength(1);
      expect(transfer[0]!.statement).toMatch(/^Transaction 0 sends [\d.]+ SOL \(\d+ lamports\) from \w+ to \w+\.$/);
      const prio = facts(r, "fact.priority_fee");
      expect(prio).toHaveLength(1);
      if (fee.maxPriorityFee && fee.maxPriorityFee > 0n) expect(prio[0]!.statement).toContain(`${fee.maxPriorityFee} lamports`);
      expect(prio[0]!.statement).toContain(fee.feePayer);
      expect(facts(r, "fact.network_fee")[0]!.statement).toContain("1 signature × 5000 lamports");
      expect(facts(r, "fact.no_permission_change")).toHaveLength(1);
      expect(explainReport(r).headline).toMatch(/^No risks found · /);
      for (const c of r.claims.filter((c) => c.ruleId?.startsWith("fact."))) {
        expect(c).toMatchObject({ kind: "Fact", level: "L0" });
        expect(c.evidenceIds.length).toBeGreaterThan(0);
        expect(r.alert.claimIds).not.toContain(c.id);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("token transfer states amount with decimals and the mint", async () => {
    const x = fx("/memo/39dPFsd");
    const r = analyze(await sessionOf([x.base64]));
    const t = facts(r, "fact.token_transfer");
    expect(t).toHaveLength(1);
    expect(t[0]!.statement).toContain("sends 0.000409 of token mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(t[0]!.statement).toContain("owner of token account");
    expect(facts(r, "fact.memo")[0]!.statement).toContain('"fn1:order:ord_01a1b4fd-b6ea-7867-9637-9a8f9cdbd21d:fee-custody:usdc"');
  });

  it("memo-only transaction (instruction subset of a real memo transaction): signs a memo, no risks found", async () => {
    const session = await sessionOf([fx("/memo/39dPFsd").base64]);
    const all = decoder.decodeSession(session);
    const memoOnly = [all[0]!.filter((ix) => ix.name === "memo")];
    expect(memoOnly[0]).toHaveLength(1);
    const r = build(session, memoOnly);
    expect(r.claims.map((c) => c.ruleId)).toEqual(["fact.memo", "fact.network_fee", "fact.no_permission_change"]);
    expect(r.alert.level).toBe("L0");
    expect(explainReport(r).headline).toBe("No risks found · signs a memo");
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("never claims 'no permission change' with an unknown instruction or a granted capability", async () => {
    const session = await sessionOf([fx("/memo/39dPFsd").base64]);
    const [ixs] = decoder.decodeSession(session);
    const unknown: DecodedInstruction = { ...ixs!.find((i) => i.name === "memo")!, status: "unknown", name: null, args: null };
    const r = build(session, [[...ixs!, unknown]]);
    expect(facts(r, "fact.no_permission_change")).toEqual([]);
    expect(explainReport(r).headline).toContain("Can't fully verify this transaction");
  });

  it("memo text is bounded, quoted and plain", async () => {
    const session = await sessionOf([fx("/memo/39dPFsd").base64]);
    const [ixs] = decoder.decodeSession(session);
    const memo = ixs!.find((i) => i.name === "memo")!;
    const long = { ...memo, args: { memo: `a"b\nc\u202e${"x".repeat(300)}` } };
    const r = build(session, [[long]]);
    const s = facts(r, "fact.memo")[0]!.statement;
    expect(s).not.toMatch(/[\n\u202e]/);
    expect(s).toContain("(first 200 of ");
  });

  it("is deterministic: three identical digests", async () => {
    const session = await sessionOf([fx("/memo/39dPFsd").base64]);
    const digests = [1, 2, 3].map(() => analyze(session).digest);
    expect(new Set(digests).size).toBe(1);
  });

  it("every fact ruleId has an explain template", async () => {
    const { RULE_TEMPLATES } = await import("../src/explain/index.js");
    for (const id of FACT_RULE_IDS) expect(RULE_TEMPLATES[id], id).toBeDefined();
  });
});

describe("human simulation text", () => {
  it("splits the fee payer's change into network and priority fee when it adds up", async () => {
    const session = await sessionOf([fx("/memo/46TqVDd").base64]);
    const decoded = decoder.decodeSession(session);
    const fee = transactionFeeFacts(session, decoded)[0]!;
    // Explicit synthetic simulation result: the payer loses exactly base fee + priority fee.
    const total = fee.baseFee + fee.maxPriorityFee!;
    const sim = { ok: true, err: null, logs: [], unitsConsumed: null, slot: 1, blockhashReplaced: false, innerInstructions: [], accounts: [], accountsOmitted: [], solChanges: [{ address: fee.feePayer, delta: -total }], tokenChanges: [], stateChanges: [] } as unknown as SimulationResult;
    const b = new ReportBuilder(session);
    addSimulationSummary(b, { 0: sim }, 1, [fee], fee.feePayer);
    const built = b.build();
    expect(built.simulation.summary).toBe(`Simulation shows: Transaction 0: Your SOL balance changes by -0.00001002 SOL (network fee 0.00001 SOL + priority fee up to 0.00000002 SOL)`);
    const ev = built.evidence.find((e) => e.type === "simulation")!;
    expect((ev.data as { solChanges: { delta: string }[] }).solChanges[0]!.delta).toBe(String(-total));
  });
});

describe("Jupiter v6 swaps on real mainnet fixtures", () => {
  // Every fixture resolves offline: v0 transactions use the runtime's own meta.loadedAddresses (as G3 does).
  const EXCLUDED: string[] = [];
  const SWAP_NAMES = ["route", "routeV2", "sharedAccountsRoute", "sharedAccountsRouteV2", "exactOutRoute", "exactOutRouteV2", "sharedAccountsExactOutRoute", "sharedAccountsExactOutRouteV2"];

  it("names every Jupiter instruction and states each swap as an L0 fact without claiming 'no permission change'", async () => {
    const excluded: string[] = [];
    const seen = new Set<string>();
    let swapsStated = 0;
    const included = manifestFixtures().filter((f) => f.path.includes("/jupiter-v6/"));
    expect(included.length).toBeGreaterThan(0);
    for (const x of included) {
      const session = await (x.loaded ? Promise.resolve(sessionFromRuntime(x.base64, x.loaded)) : sessionOf([x.base64])).catch(() => null);
      if (!session) { excluded.push(x.path); continue; }
      const jup = decoder.decodeSession(session).flat().filter((i) => i.programName === "jupiter-v6");
      expect(jup.length, x.path).toBeGreaterThan(0);
      for (const ix of jup) {
        expect(ix.status, `${x.path} ix ${ix.index}`).toBe("named");
        seen.add(ix.name!);
      }
      const r = analyze(session);
      const swaps = facts(r, "fact.swap");
      expect(swaps.length, x.path).toBe(jup.filter((i) => SWAP_NAMES.includes(i.name!)).length);
      for (const c of swaps) {
        expect(c.level).toBe("L0");
        expect(c.statement).toMatch(/swaps up to .* for (at least|exactly) .* via Jupiter/);
        expect(r.alert.claimIds).not.toContain(c.id);
        swapsStated++;
      }
      expect(facts(r, "fact.no_permission_change"), x.path).toEqual([]);
    }
    expect(excluded).toEqual(EXCLUDED);
    expect([...seen]).toEqual(expect.arrayContaining(["route", "routeV2"]));
    expect(swapsStated).toBeGreaterThan(0);
  });
});

describe("program labels (E25)", () => {
  it("adds the name to evidence of an instruction on a program ClearSign cannot decode; level and claims do not change", async () => {
    // First real fixture with an instruction on a program that has no decoder (any program not in the registry).
    let found: { session: Awaited<ReturnType<typeof sessionOf>>; program: string } | null = null;
    for (const x of manifestFixtures()) {
      const session = x.loaded ? sessionFromRuntime(x.base64, x.loaded) : await sessionOf([x.base64]);
      const u = decoder.decodeSession(session).flat().find((i) => i.status === "unknown" && i.reason === "program_not_in_registry");
      if (u) { found = { session, program: u.programAddress }; break; }
    }
    expect(found).not.toBeNull();
    const { session, program } = found!;
    const labels = { source: "Helius program catalog (test)", names: { [program]: "Test Program" } };
    const plain = analyze(session);
    const named = analyze(session, { programLabels: labels });
    const onProgram = (r: Report) => r.evidence.filter((e) => e.type === "instruction" && (e.data as { programId?: string }).programId === program);
    expect(onProgram(plain).length).toBeGreaterThan(0);
    for (const e of onProgram(plain)) expect(e.data).not.toHaveProperty("programLabel");
    expect(onProgram(named).length).toBe(onProgram(plain).length);
    for (const e of onProgram(named)) expect(e.data).toMatchObject({ programLabel: "Test Program", labelSource: labels.source, name: null });
    expect(named.alert.level).toBe(plain.alert.level);
    expect(named.claims.map((c) => [c.ruleId, c.level])).toEqual(plain.claims.map((c) => [c.ruleId, c.level]));
  });

  it("never labels a decoded instruction", async () => {
    const x = fx("/memo/39dPFsd");
    const r = analyze(await sessionOf([x.base64]), { programLabels: { source: "t", names: { MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Wrong" } } });
    for (const e of r.evidence.filter((e) => e.type === "instruction")) expect(e.data).not.toHaveProperty("programLabel");
  });
});
