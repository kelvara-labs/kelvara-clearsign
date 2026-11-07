// E11: capability diff, alert level and capability preview on real data.
//  - Drift replay + Drift's on-chain IDL (legacy, field-name ties) -> admin-gated instructions, recovery path
//    through Drift's real upgrade authority (Helius, recorded).
//  - admin-local approval + the demo program's IDL (relations) -> "can deploy any code" first, then admin
//    instructions; no recovery path above the upgrade authority.
//  - Fallbacks: real localnet simulation of a loader SetAuthority (simulate-and-diff) and the Drift old
//    admin's real Helius history, both Conditional; neither -> Unknown, never harmless.
//  - Token-2022 trap (executed localnet ATA creation) -> Transfer and Burn on your account.
import { describe, expect, it } from "vitest";
import {
  buildAuthorityMap,
  classifyInstruction,
  levelAllowed,
  capabilityScore,
  readAuthorityHistory,
  readProgram,
  simulateTransaction,
  accountFromRpc,
  TOKEN_TAGS,
  PREVIEW_RULE_ID,
  RECOVERY_RULE_ID,
  type AnchorIdlJson,
  type AuthorityMap,
  type Report,
  type RuleState
} from "../src/index.js";
import { fromBase64 } from "../src/util/encoding.js";
import { ReportBuilder, runRules, validateReport } from "../src/index.js";
import { byRule, decoder, DRIFT_1, DRIFT_2, driftTx, json, recording, replay, sessionOf, stateFrom, type Recording } from "./rules-helpers.js";

const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const driftIdl = json<AnchorIdlJson>("packages/idls/raw/drift-v2.json");
const demoIdl = json<AnchorIdlJson>("packages/scenarios/programs/marginfi_v2.idl.json");
const manifest = json<{ idls: { name: string; verified: boolean }[] }>("packages/idls/manifest.json");
const driftMap = buildAuthorityMap(driftIdl, { programId: DRIFT, source: "packages/idls/raw/drift-v2.json", verified: manifest.idls.find((i) => i.name === "drift-v2")!.verified });
const demoMap = buildAuthorityMap(demoIdl, { source: "packages/scenarios/programs/marginfi_v2.idl.json", verified: false });

function run(session: Awaited<ReturnType<typeof sessionOf>>, state: RuleState, maps: AuthorityMap[] = []): Report {
  const report = new ReportBuilder(session);
  runRules({ session, decoder, report, state, authorityMaps: maps });
  const r = report.build();
  const v = validateReport(r);
  if (!v.ok) throw new Error(v.problems.join("; "));
  return r;
}
const claim = (r: Report, id: string) => r.claims.find((c) => c.id === id)!;

describe("authority maps", () => {
  it("legacy Drift IDL: discriminators match the Codama root, admin signer tied to State.admin by field name", () => {
    const root = json<{ program: { instructions: { name: string; arguments: { name: string; defaultValue?: { data?: string } }[] }[] } }>("packages/idls/roots/drift-v2.json");
    const rootDisc = new Map(root.program.instructions.map((i) => [i.name, i.arguments.find((a) => a.name === "discriminator")?.defaultValue?.data]));
    const update = driftMap.entries.find((e) => e.instruction === "updateAdmin")!;
    expect(update.tie).toEqual({ kind: "field_name", signer: "admin", account: "state", field: "admin", accountType: "state" });
    expect(update.admin).toBe(true);
    let checked = 0;
    for (const e of driftMap.entries) {
      const d = rootDisc.get(e.instruction);
      if (d) { expect(e.discriminator, e.instruction).toBe(d); checked++; }
    }
    expect(checked).toBeGreaterThan(100);
    // Drift user calls (signer = authority of a User account) are tied but not admin.
    expect(driftMap.entries.filter((e) => e.tie.field === "admin").length).toBeGreaterThan(100);
  });

  it("0.1.0 IDL with relations: demo program admin instructions tied by has_one, user calls not admin", () => {
    const e = demoMap.entries.find((x) => x.instruction === "super_admin_withdraw")!;
    expect(e.tie).toMatchObject({ kind: "relation", signer: "admin", account: "group", field: "admin" });
    expect(e.discriminator).toBe("ca43557e688a4fc5"); // [202, 67, 85, 126, 104, 138, 79, 197]
    expect(e.class).toBe("fund_movement");
    expect(demoMap.entries.find((x) => x.instruction === "lending_account_end_flashloan")!.admin).toBe(false);
    expect(demoMap.entries.filter((x) => x.admin).length).toBeGreaterThan(20);
  });

  it("keyword classes (capability-risk-v1)", () => {
    expect(classifyInstruction("updateWithdrawGuardThreshold")).toBe("admin_control");
    expect(classifyInstruction("withdrawFromProgramVault")).toBe("fund_movement");
    expect(classifyInstruction("updatePerpMarketOracle")).toBe("admin_control");
    expect(classifyInstruction("updateExchangeStatus")).toBe("freeze");
    expect(classifyInstruction("panic_pause")).toBe("freeze");
    expect(classifyInstruction("lending_pool_close_bank")).toBe("account_control");
    expect(classifyInstruction("updatePerpFeeStructure")).toBe("config");
    expect(classifyInstruction("updateAdmin")).toBe("admin_control");
  });

  it("curated SPL Token tags match the token and Token-2022 roots", () => {
    for (const name of ["token", "token-2022"]) {
      const root = json<{ program: { instructions: { name: string; arguments: { name: string; defaultValue?: { number?: number } }[] }[] } }>(`packages/idls/roots/${name}.json`);
      for (const [ixName, tag] of Object.values(TOKEN_TAGS)) {
        const ix = root.program.instructions.find((i) => i.name === ixName)!;
        expect(ix, `${name}.${ixName}`).toBeDefined();
        expect(ix.arguments.find((a) => a.name === "discriminator")!.defaultValue!.number, `${name}.${ixName}`).toBe(parseInt(tag, 16));
      }
    }
  });
});

describe("capability preview and diff", () => {
  it("Drift replay: the new admin's admin-gated Drift instructions from the IDL, ranked by damage; recovery via Drift's upgrade authority", async () => {
    const { reader } = replay(recording("mainnet.json"));
    const drift = await readProgram(reader, DRIFT);
    const r = run(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]), { programs: { [DRIFT]: drift } }, [driftMap]);
    expect(r.alert.level).toBe("L3");
    const p = r.preview.find((x) => x.programId === DRIFT)!;
    expect(p).toBeDefined();
    expect(p.deployAnyCode).toBe(false);
    expect(p.confidence).toBe("lower"); // manifest: not verified yet (M3), and legacy IDL ties by field name
    const names = p.unlocks.map((u) => u.instruction);
    for (const n of ["updateAdmin", "updatePerpMarketOracle", "withdrawFromProgramVault", "updateExchangeStatus"]) expect(names).toContain(n);
    // capability-risk-v1: admin_control (90) ranks above fund_movement (80); ranks 1..n by score.
    expect(p.unlocks[0]!.class).toBe("admin_control");
    p.unlocks.forEach((u, i) => {
      expect(u.rank).toBe(i + 1);
      if (i) expect(capabilityScore(p.unlocks[i - 1]!.class)).toBeGreaterThanOrEqual(capabilityScore(u.class));
    });
    expect(p.unlocks.find((u) => u.instruction === "withdrawFromProgramVault")!.class).toBe("fund_movement");
    const c = claim(r, p.claimId);
    expect(c).toMatchObject({ kind: "Derived", ruleId: PREVIEW_RULE_ID, level: "L0" });
    expect(c.assumptions.length).toBeGreaterThan(0);
    // Evidence behind every line: one IDL evidence per unlock, plus the program read.
    const idlEv = c.evidenceIds.map((id) => r.evidence.find((e) => e.id === id)!).filter((e) => e.type === "idl");
    expect(idlEv.length).toBe(p.unlocks.length);
    expect(r.claims.find((x) => x.id === c.dependsOn[0])!.ruleId).toBe("authority.transfer");
    // Capability diff: granted admin_control to the attacker, revoked from the old admin.
    expect(r.capabilities.granted.find((k) => k.capability === "protocol.admin")).toMatchObject({ class: "admin_control", rank: 1 });
    expect(r.capabilities.revoked.find((k) => k.capability === "protocol.admin")!.holder).toBe("AiLGdNitMjv8n5HMS7HAdV2kaeJZZFd4jdfn5xp1PKrW");
    const rec = byRule(r, RECOVERY_RULE_ID);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ kind: "Derived", level: "L0" });
    expect(rec[0]!.statement).toContain("Recovery path");
    expect(drift.upgradeAuthority).toBe("8jj7zJgdr5bDndc7evM74FMGwzLPmd4u4QxNzFi1BMai");
  });

  it("admin-local: \"can deploy any code\" first, then the demo program's admin instructions; no recovery path above the upgrade authority", async () => {
    const local = recording("localnet.json");
    const state = await stateFrom(local, { squads: [local.inputs.multisig, local.inputs.proposal, local.inputs.vaultTransaction] });
    const { reader } = replay(local);
    state.programs = { [local.inputs.demoProgram]: await readProgram(reader, local.inputs.demoProgram) };
    const r = run(await sessionOf([local.inputs.approval.wireBase64]), state, [demoMap]);
    expect(r.alert.level).toBe("L3");
    const p = r.preview.find((x) => x.deployAnyCode)!;
    expect(p.programId).toBe(local.inputs.demoProgram);
    expect(p.confidence).toBe("lower");
    const c = claim(r, p.claimId);
    expect(c.statement).toMatch(/can deploy any code to program MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA; reachable today, for example/);
    const names = p.unlocks.map((u) => u.instruction);
    for (const n of ["super_admin_withdraw", "lending_pool_configure_bank_oracle", "marginfi_group_configure"]) expect(names).toContain(n);
    expect(names).not.toContain("lending_account_withdraw");
    expect(r.capabilities.granted[0]).toMatchObject({ capability: "program.upgrade", class: "code_control", rank: 1 });
    const rec = byRule(r, RECOVERY_RULE_ID);
    expect(rec.map((x) => x.statement)).toEqual([expect.stringContaining("No recovery path: the upgrade authority itself passes")]);
  });

  it("fallback 1: real localnet simulation of a loader SetAuthority -> Conditional, observed", async () => {
    const rec = json<Recording & { inputs: Record<string, string> }>("packages/core/test/fixtures/graph/localnet-set-authority-sim.json");
    const { rpc, reader } = replay(rec);
    const sim = await simulateTransaction(rpc, fromBase64(rec.inputs.wireBase64!), { accounts: [rec.inputs.programData!], reader });
    expect(sim.stateChanges).toEqual([{ address: rec.inputs.programData, field: "upgradeAuthority", before: rec.inputs.currentAuthority, after: rec.inputs.newAuthority }]);
    const program = await readProgram(reader, rec.inputs.program!);
    const r = run(await sessionOf([rec.inputs.wireBase64!]), { programs: { [program.program]: program }, simulations: { 0: sim } });
    const p = r.preview[0]!;
    expect(p).toMatchObject({ deployAnyCode: true, confidence: "observed", authority: rec.inputs.newAuthority, programId: rec.inputs.program });
    expect(p.unlocks).toEqual([expect.objectContaining({ instruction: `upgradeAuthority of ${rec.inputs.programData}`, class: "code_control", discriminator: null })]);
    const c = claim(r, p.claimId);
    expect(c.kind).toBe("Conditional");
    expect(c.evidenceIds.some((id) => r.evidence.find((e) => e.id === id)!.type === "simulation")).toBe(true);
  });

  it("fallback 2: the Drift old admin's real Helius history -> Conditional, observed; neither -> Unknown", async () => {
    const rec = json<Recording & { inputs: { program: string; authority: string; limit: number; maxTransactions: number } }>("packages/core/test/fixtures/graph/drift-old-admin-history.json");
    const { rpc } = replay(rec);
    const history = await readAuthorityHistory(rpc, { authority: rec.inputs.authority, programId: rec.inputs.program, limit: rec.inputs.limit, maxTransactions: rec.inputs.maxTransactions });
    expect(history.calls.length).toBeGreaterThan(0);
    expect(history.complete).toBe(true);
    const session = await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]);
    const r = run(session, { authorityHistory: { [`${DRIFT}:${rec.inputs.authority}`]: history } });
    const p = r.preview.find((x) => x.programId === DRIFT)!;
    expect(p.confidence).toBe("observed");
    expect(p.unlocks.length).toBeGreaterThan(0);
    expect(p.unlocks.every((u) => u.instruction.length > 0)).toBe(true);
    const c = claim(r, p.claimId);
    expect(c.kind).toBe("Conditional");
    const hist = c.evidenceIds.map((id) => r.evidence.find((e) => e.id === id)!).filter((e) => e.type === "history");
    expect(hist.length).toBe(p.unlocks.length);
    for (const e of hist) expect((e.data as { signatures: string[] }).signatures.length).toBeGreaterThan(0);

    const bare = run(session, {});
    const u = bare.preview.find((x) => x.programId === DRIFT)!;
    expect(u).toMatchObject({ confidence: "unknown", unlocks: [] });
    expect(claim(bare, u.claimId)).toMatchObject({ kind: "Unknown", ruleId: PREVIEW_RULE_ID });
    expect(claim(bare, u.claimId).statement).toContain("Treat it as full control");
    expect(byRule(bare, RECOVERY_RULE_ID)[0]).toMatchObject({ kind: "Unknown" });
  });

  it("Token-2022 trap: permanent delegate can call Transfer and Burn on your account", async () => {
    const f = json<{ cases: any[] }>("packages/core/test/fixtures/rules/e8-localnet.json").cases.find((c) => c.name === "receive-permanent")!; // eslint-disable-line @typescript-eslint/no-explicit-any
    const state: RuleState = { wallet: f.wallet, accounts: Object.fromEntries(Object.entries(f.accounts).map(([a, raw]) => [a, accountFromRpc(a, raw as Parameters<typeof accountFromRpc>[1])])), fees: { 0: BigInt(f.fee) } };
    const r = run(await sessionOf([f.transaction]), state);
    const p = r.preview.find((x) => x.unlocks.some((u) => u.instruction === "transferChecked"))!;
    expect(p.programId).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(p.unlocks.map((u) => [u.instruction, u.discriminator])).toEqual([["transferChecked", "0c"], ["transfer", "03"], ["burnChecked", "0f"], ["burn", "08"]]);
    expect(p.unlocks[0]!.changes).toContain("can call Transfer on your account");
    expect(claim(r, p.claimId).kind).toBe("Derived");
    expect(byRule(r, RECOVERY_RULE_ID)).toEqual([]); // native token program: no upgrade-authority recovery path
  });
});

describe("alert-levels-v1", () => {
  it("graph claims never raise the level; L4 only from Fact claims of the scam list", async () => {
    const { reader } = replay(recording("mainnet.json"));
    const r = run(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]), { programs: { [DRIFT]: await readProgram(reader, DRIFT) } }, [driftMap]);
    for (const c of r.claims.filter((x) => x.ruleId === PREVIEW_RULE_ID || x.ruleId === RECOVERY_RULE_ID)) expect(c.level).toBe("L0");
    const top = r.claims.reduce((m, c) => (Number(c.level[1]) > m ? Number(c.level[1]) : m), 0);
    expect(r.alert.level).toBe(`L${top}`);
    expect(levelAllowed("Fact", "wallet.sweep", "L4")).toBe(true);
    expect(levelAllowed("Derived", "wallet.sweep", "L4")).toBe(false);
    expect(levelAllowed("Conditional", "address.poisoning", "L4")).toBe(false);
    expect(levelAllowed("Fact", "authority.transfer", "L4")).toBe(false);
    expect(levelAllowed("Fact", PREVIEW_RULE_ID, "L4")).toBe(false);
  });
});
