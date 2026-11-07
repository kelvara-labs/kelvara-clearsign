// Capability preview and capability diff (PLAN.md M2, "Capability preview" and "Capability diff").
// Runs after the rules: reads the capabilities they granted/revoked from the report builder and adds
//  - one preview entry per granted authority: what it unlocks, from the authority map (Derived),
//    else simulate-and-diff + old-authority history (Conditional, "observed"), else Unknown;
//  - recovery paths through the program's upgrade authority (capability.recovery_path).
// Granted powers rank by damage and revoked by defensive loss in ReportBuilder.build (capability-risk-v1).
import type { Address } from "@solana/kit";
import type { CapabilityRecord, PreviewInput } from "../report/builder.js";
import { capabilityScore, type CapabilityClass } from "../report/rubrics.js";
import type { AuthorityHistory } from "../state/authority-history.js";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../state/layouts.js";
import type { ProgramState } from "../state/reads.js";
import { short } from "../rules/common.js";
import type { RuleContext } from "../rules/types.js";
import { classifyInstruction, describeInstruction, type AuthorityMap, type AuthorityMapEntry } from "./authority-map.js";

export const PREVIEW_RULE_ID = "graph.capability_preview";
export const RECOVERY_RULE_ID = "capability.recovery_path";
export const GRAPH_RULE_IDS = [PREVIEW_RULE_ID, RECOVERY_RULE_ID] as const;

type Unlock = PreviewInput["unlocks"][number];

/** Damage order under capability-risk-v1 (stable), the order ReportBuilder ranks preview lines in. */
const byDamage = (us: Unlock[]): Unlock[] => us.map((u, i) => ({ u, i })).sort((a, b) => capabilityScore(b.u.class) - capabilityScore(a.u.class) || a.i - b.i).map(({ u }) => u);

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- SPL Token / Token-2022 (curated)

/** One-byte instruction tags shared by SPL Token and Token-2022 (packages/idls/roots/token*.json). */
const T = {
  transfer: ["transfer", "03"],
  approve: ["approve", "04"],
  setAuthority: ["setAuthority", "06"],
  mintTo: ["mintTo", "07"],
  burn: ["burn", "08"],
  closeAccount: ["closeAccount", "09"],
  freezeAccount: ["freezeAccount", "0a"],
  thawAccount: ["thawAccount", "0b"],
  transferChecked: ["transferChecked", "0c"],
  mintToChecked: ["mintToChecked", "0e"],
  burnChecked: ["burnChecked", "0f"]
} as const satisfies Record<string, readonly [string, string]>;
export const TOKEN_TAGS = T;

type TokenLine = [keyof typeof T, string, CapabilityClass];
const TOKEN_PREVIEW: Record<string, TokenLine[]> = {
  "token.permanent_delegate": [
    ["transferChecked", "can call Transfer on your account and move your whole balance, at any time", "fund_movement"],
    ["transfer", "can call Transfer on your account (unchecked form)", "fund_movement"],
    ["burnChecked", "can call Burn on your account and destroy your balance", "fund_movement"],
    ["burn", "can call Burn on your account (unchecked form)", "fund_movement"]
  ],
  "token.accountOwner": [
    ["transferChecked", "can move the whole balance of the account", "fund_movement"],
    ["transfer", "can move the whole balance of the account (unchecked form)", "fund_movement"],
    ["burnChecked", "can burn the balance", "fund_movement"],
    ["closeAccount", "can close the account and take its rent", "account_control"],
    ["setAuthority", "can hand the account to anyone else", "account_control"],
    ["approve", "can approve any delegate", "bounded_spend"]
  ],
  "token.closeAccount": [["closeAccount", "can close the account and take its rent", "account_control"]],
  "token.mintTokens": [
    ["mintToChecked", "can mint new supply of this token", "mint_control"],
    ["mintTo", "can mint new supply (unchecked form)", "mint_control"]
  ],
  "token.freeze": [
    ["freezeAccount", "can call FreezeAccount on your account", "freeze"],
    ["thawAccount", "can call ThawAccount on your account", "freeze"]
  ],
  "token.default_frozen": [["thawAccount", "decides whether your new account is ever thawed (ThawAccount)", "freeze"]],
  "token.delegate": [
    ["transferChecked", "can move up to the approved amount from the account", "bounded_spend"],
    ["burnChecked", "can burn up to the approved amount", "bounded_spend"]
  ]
};
TOKEN_PREVIEW["token.permanentDelegate"] = TOKEN_PREVIEW["token.permanent_delegate"]!;
TOKEN_PREVIEW["token.freezeAccount"] = TOKEN_PREVIEW["token.freeze"]!;

const TOKEN_PROGRAMS = new Set<string>([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const NATIVE_PROGRAMS = new Set<string>([TOKEN_PROGRAM, TOKEN_2022_PROGRAM, SYSTEM_PROGRAM]);

// ---------------------------------------------------------------- helpers

/** The program a capability belongs to: given by the rule, or (loader targets) via ProgramData in state. */
export function capabilityProgram(cap: Pick<CapabilityRecord, "programId" | "target" | "capability">, programs: Record<string, ProgramState> = {}): ProgramState | { program: string } | null {
  if (cap.programId) return programs[cap.programId] ?? { program: cap.programId };
  if (cap.capability !== "program.upgrade" || !cap.target) return null;
  return Object.values(programs).find((p) => p.program === cap.target || p.programData === cap.target) ?? null;
}

function programEvidence(ctx: RuleContext, p: ProgramState): string {
  return ctx.report.addEvidence({
    type: "account",
    source: "rpc",
    address: p.program,
    summary: `Program ${p.program}: ${p.upgradeAuthority ? `upgrade authority ${p.upgradeAuthority}` : "immutable (no upgrade authority)"}${p.programData ? `, ProgramData ${p.programData}` : ""}`,
    data: { program: p.program, loader: p.loader, programData: p.programData, upgradeAuthority: p.upgradeAuthority, deploySlot: p.deploySlot, upgradeable: p.upgradeable }
  });
}

function idlEvidence(ctx: RuleContext, map: AuthorityMap, e: AuthorityMapEntry): string {
  const how = e.tie.kind === "relation" ? `has_one (relations) ${e.tie.account}.${e.tie.field}` : e.tie.kind === "address" ? `fixed address ${e.tie.field}` : `field name ${e.tie.account}.${e.tie.field} (legacy IDL, no relations)`;
  return ctx.report.addEvidence({
    type: "idl",
    source: "idl",
    address: map.programId,
    summary: `${map.name}.${e.instruction} (discriminator ${e.discriminator}): signer ${e.tie.signer} tied by ${how}; IDL ${map.source}${map.verified ? " (verified)" : " (unverified)"}`,
    data: { idl: map.source, verified: map.verified, instruction: e.instruction, discriminator: e.discriminator, tie: { ...e.tie } }
  });
}

/** The stored field a capability controls: "protocol.admin" -> "admin". */
const capabilityField = (capability: string): string => capability.slice(capability.lastIndexOf(".") + 1).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function mapUnlocks(ctx: RuleContext, map: AuthorityMap, cap: CapabilityRecord): { unlocks: Unlock[]; evidence: string[]; lower: boolean } {
  const field = capabilityField(cap.capability);
  const picked = cap.capability === "program.upgrade" ? map.entries.filter((e) => e.admin) : map.entries.filter((e) => e.tie.field === field);
  const seen = new Set<string>();
  const unlocks: Unlock[] = [];
  const evidence: string[] = [];
  let lower = !map.verified;
  for (const e of picked) {
    if (seen.has(e.instruction)) continue;
    seen.add(e.instruction);
    if (e.tie.kind === "field_name") lower = true;
    unlocks.push({ instruction: e.instruction, discriminator: e.discriminator, changes: e.changes, class: e.class });
    evidence.push(idlEvidence(ctx, map, e));
  }
  return { unlocks, evidence, lower };
}

function simulationUnlocks(ctx: RuleContext, cap: CapabilityRecord, txs: number[]): { unlocks: Unlock[]; evidence: string[] } {
  const unlocks: Unlock[] = [];
  const evidence: string[] = [];
  for (const t of txs) {
    const sim = ctx.state.simulations?.[t];
    if (!sim?.ok) continue;
    for (const c of sim.stateChanges) {
      if (c.after !== cap.holder || c.before === c.after) continue;
      const cls: CapabilityClass = /upgrade/i.test(c.field) ? "code_control" : /owner/i.test(c.field) ? "fund_movement" : /mint/i.test(c.field) ? "mint_control" : /freeze/i.test(c.field) ? "freeze" : /close/i.test(c.field) ? "account_control" : /delegate/i.test(c.field) ? "fund_movement" : "admin_control";
      unlocks.push({ instruction: `${c.field} of ${c.address}`, discriminator: null, changes: `simulation: ${c.field} of ${c.address} changes from ${c.before ?? "none"} to ${c.after}`, class: cls });
      evidence.push(ctx.report.addEvidence({ type: "simulation", source: "simulation", transactionIndex: t, address: c.address, summary: `Simulated transaction ${t}: ${c.field} of ${c.address} becomes ${c.after}`, data: { ...c } }));
    }
  }
  return { unlocks, evidence };
}

function historyUnlocks(ctx: RuleContext, h: AuthorityHistory): { unlocks: Unlock[]; evidence: string[] } {
  const groups = new Map<string, { name: string | null; disc: string; sigs: string[]; cpi: boolean }>();
  for (const call of h.calls) {
    const disc = hex(call.data.slice(0, Math.min(8, call.data.length)));
    let name: string | null = null;
    if (ctx.decoder) {
      const d = ctx.decoder.decodeInstruction({
        index: call.path[0]!,
        programIdIndex: 0,
        programAddress: h.programId as Address,
        accounts: call.accounts.map((a, i) => ({ index: i, address: a as Address, signer: false, writable: false, source: { kind: "static" as const } })),
        data: call.data
      });
      if (d.status === "named") name = d.name;
    }
    const key = name ?? disc;
    const g = groups.get(key) ?? { name, disc, sigs: [], cpi: false };
    if (!g.sigs.includes(call.signature)) g.sigs.push(call.signature);
    g.cpi ||= !call.topLevelSigner;
    groups.set(key, g);
  }
  const unlocks: Unlock[] = [];
  const evidence: string[] = [];
  for (const g of groups.values()) {
    const label = g.name ?? `unnamed instruction ${g.disc}`;
    const cls = g.name ? classifyInstruction(g.name) : "other";
    unlocks.push({ instruction: label, discriminator: g.disc || null, changes: `${g.name ? describeInstruction(g.name, cls) : "unknown effect"}; observed ${g.sigs.length}x from the old authority`, class: cls });
    evidence.push(
      ctx.report.addEvidence({
        type: "history",
        source: "helius",
        address: h.authority,
        summary: `Old authority ${h.authority} called ${label} on ${h.programId} in ${g.sigs.length} of ${h.transactionsRead} recent transactions${g.cpi ? " (through CPI)" : ""}`,
        data: { programId: h.programId, authority: h.authority, instruction: g.name, discriminator: g.disc, signatures: g.sigs.slice(0, 5), signaturesRead: h.signaturesRead, transactionsRead: h.transactionsRead, complete: h.complete }
      })
    );
  }
  return { unlocks, evidence };
}

// ---------------------------------------------------------------- preview

export interface CapabilityGraphOptions {
  /** Authority maps by program id (from IDLs); P0 token programs use the curated map built in. */
  maps?: readonly AuthorityMap[];
}

/** Adds preview entries for every granted authority. Returns the preview claim ids. */
export function addCapabilityPreviews(ctx: RuleContext, opts: CapabilityGraphOptions = {}): string[] {
  const maps = new Map((opts.maps ?? []).map((m) => [m.programId, m]));
  const caps = ctx.report.listCapabilities();
  const done = new Set<string>();
  const out: string[] = [];
  for (const cap of caps) {
    if (cap.direction !== "granted" || !cap.holder) continue;
    const key = `${cap.capability}|${cap.holder}|${cap.target ?? ""}`;
    if (done.has(key)) continue;
    done.add(key);
    const grant = ctx.report.getClaim(cap.claimId)!;
    const prog = capabilityProgram(cap, ctx.state.programs);
    const programId = prog?.program ?? null;
    const deployAnyCode = cap.capability === "program.upgrade";
    const holder = cap.holder;
    const target = cap.target ?? "an unresolved account";
    const base = { authority: holder, programId, deployAnyCode, claimId: "" };
    const progEv = prog && "loader" in prog ? [programEvidence(ctx, prog)] : [];

    // 1. Curated SPL Token / Token-2022 map.
    const tokenLines = programId && TOKEN_PROGRAMS.has(programId) ? TOKEN_PREVIEW[cap.capability] : undefined;
    if (tokenLines) {
      const root = programId === TOKEN_2022_PROGRAM ? "packages/idls/roots/token-2022.json" : "packages/idls/roots/token.json";
      const evidence = tokenLines.map(([k]) =>
        ctx.report.addEvidence({ type: "idl", source: "idl", address: programId, summary: `${programId === TOKEN_2022_PROGRAM ? "Token-2022" : "SPL Token"} ${T[k][0]} (tag 0x${T[k][1]}) is signed by the ${cap.capability.slice(6)} authority; IDL ${root} (curated)`, data: { idl: root, instruction: T[k][0], discriminator: T[k][1], authority: cap.capability } })
      );
      const unlocks = tokenLines.map(([k, changes, cls]) => ({ instruction: T[k][0], discriminator: T[k][1], changes, class: cls }));
      const claimId = ctx.report.addClaim({ kind: "Derived", ruleId: PREVIEW_RULE_ID, level: "L0", statement: `What ${short(holder)} can do on ${short(target)}: ${unlocks.map((u) => u.instruction).join(", ")}.`, evidenceIds: evidence, dependsOn: [cap.claimId], transactionIndices: grant.transactionIndices });
      ctx.report.addPreview({ ...base, confidence: "lower", unlocks, claimId });
      out.push(claimId);
      continue;
    }

    // 2. Authority map from the program's IDL.
    const map = programId ? maps.get(programId) : undefined;
    if (map) {
      const m = mapUnlocks(ctx, map, cap);
      const { evidence, lower } = m;
      const unlocks = byDamage(m.unlocks);
      if (unlocks.length || deployAnyCode) {
        const head = deployAnyCode ? `${short(holder)} can deploy any code to program ${programId}` : `${short(holder)} becomes ${capabilityField(cap.capability)} of ${short(target)} on ${map.name}`;
        const tail = unlocks.length ? `${deployAnyCode ? "; reachable today, for example" : " and can call"} ${unlocks.length} instruction${unlocks.length === 1 ? "" : "s"}: ${unlocks.slice(0, 8).map((u) => u.instruction).join(", ")}${unlocks.length > 8 ? ", …" : ""}` : "";
        const claimId = ctx.report.addClaim({
          kind: "Derived",
          ruleId: PREVIEW_RULE_ID,
          level: "L0",
          statement: `${head}${tail}.`,
          evidenceIds: [...progEv, ...evidence],
          dependsOn: [cap.claimId],
          assumptions: lower ? [`${map.name} IDL is not verified or ties signers by field name only; the list may be incomplete or include calls gated by other keys`] : [],
          transactionIndices: grant.transactionIndices
        });
        ctx.report.addPreview({ ...base, confidence: lower ? "lower" : "verified", unlocks, claimId });
        out.push(claimId);
        continue;
      }
    }

    // 3. Fallbacks: simulate-and-diff, then the old authority's history. Conditional.
    const old = caps.find((c) => c.direction === "revoked" && c.claimId === cap.claimId && c.capability === cap.capability)?.holder ?? null;
    const sim = simulationUnlocks(ctx, cap, grant.transactionIndices);
    const hist = programId && old ? ctx.state.authorityHistory?.[`${programId}:${old}`] : undefined;
    const h = hist ? historyUnlocks(ctx, hist) : { unlocks: [], evidence: [] };
    const unlocks = byDamage([...sim.unlocks, ...h.unlocks]);
    if (unlocks.length) {
      const claimId = ctx.report.addClaim({
        kind: "Conditional",
        ruleId: PREVIEW_RULE_ID,
        level: "L0",
        statement: `${deployAnyCode ? `${short(holder)} can deploy any code to ${programId ? `program ${programId}` : short(target)}. ` : ""}Observed capabilities of ${short(holder)} on ${short(target)} (no authority map): ${unlocks.slice(0, 8).map((u) => u.instruction).join(", ")}${unlocks.length > 8 ? ", …" : ""}.`,
        evidenceIds: [...progEv, ...sim.evidence, ...h.evidence],
        dependsOn: [cap.claimId],
        assumptions: [
          "observed from simulation and the old authority's recent history, not from the program's code: the new authority may be able to call more",
          ...(hist && !hist.complete ? [`history window capped (${hist.transactionsRead} transactions read)`] : [])
        ],
        transactionIndices: grant.transactionIndices
      });
      ctx.report.addPreview({ ...base, confidence: "observed", unlocks, claimId });
      out.push(claimId);
      continue;
    }

    // 4. Unknown, never harmless.
    const claimId = ctx.report.addClaim({
      kind: "Unknown",
      ruleId: PREVIEW_RULE_ID,
      level: "L0",
      statement: `${deployAnyCode ? `${short(holder)} can deploy any code to ${programId ? `program ${programId}` : `the program behind ${short(target)}`}; ` : ""}what ${short(holder)} can call as ${cap.capability} on ${short(target)} is unknown (no authority map, simulation diff or authority history). Treat it as full control.`,
      evidenceIds: progEv,
      dependsOn: [cap.claimId],
      transactionIndices: grant.transactionIndices
    });
    ctx.report.addPreview({ ...base, confidence: "unknown", unlocks: [], claimId });
    out.push(claimId);
  }
  return out;
}

// ---------------------------------------------------------------- recovery paths

/**
 * Recovery paths through the upgrade authority: whoever can redeploy the program that enforces a
 * granted power can undo its misuse. Only for program-governed powers (not native token/system).
 */
export function addRecoveryPaths(ctx: RuleContext): string[] {
  const caps = ctx.report.listCapabilities();
  const out: string[] = [];
  const done = new Set<string>();
  const upgradeGrants = caps.filter((c) => c.direction === "granted" && c.capability === "program.upgrade");
  for (const cap of caps) {
    if (cap.direction !== "granted" || !cap.holder) continue;
    const prog = capabilityProgram(cap, ctx.state.programs);
    const programId = prog?.program ?? cap.programId;
    if (!programId && cap.capability !== "program.upgrade") continue;
    if (programId && NATIVE_PROGRAMS.has(programId)) continue;
    const key = `${programId ?? cap.target}|${cap.capability}|${cap.target ?? ""}`;
    if (done.has(key)) continue;
    done.add(key);
    const grant = ctx.report.getClaim(cap.claimId)!;
    const base = { ruleId: RECOVERY_RULE_ID, level: "L0" as const, dependsOn: [cap.claimId], transactionIndices: grant.transactionIndices };
    const what = `${cap.capability} on ${short(cap.target)}`;
    if (cap.capability === "program.upgrade") {
      out.push(ctx.report.addClaim({ ...base, kind: "Derived", statement: `No recovery path: the upgrade authority itself passes to ${short(cap.holder)}; nothing above it can undo what it deploys.` }));
      continue;
    }
    if (!prog || !("loader" in prog)) {
      out.push(ctx.report.addClaim({ ...base, kind: "Unknown", statement: `Recovery path for ${what} unknown: the upgrade authority of program ${programId} was not read.` }));
      continue;
    }
    const ev = [programEvidence(ctx, prog)];
    const lost = upgradeGrants.find((u) => u.target === prog.programData || u.target === prog.program);
    if (lost) {
      out.push(ctx.report.addClaim({ ...base, kind: "Derived", evidenceIds: ev, dependsOn: [cap.claimId, lost.claimId], statement: `No independent recovery path for ${what}: this session also hands the upgrade authority of ${prog.program} to ${short(lost.holder)}.` }));
    } else if (!prog.upgradeAuthority) {
      out.push(ctx.report.addClaim({ ...base, kind: "Derived", evidenceIds: ev, statement: `No recovery path for ${what}: program ${prog.program} is immutable, so no new code can undo it.` }));
    } else if (prog.upgradeAuthority === cap.holder) {
      out.push(ctx.report.addClaim({ ...base, kind: "Derived", evidenceIds: ev, statement: `No independent recovery path for ${what}: ${short(cap.holder)} already holds the upgrade authority of ${prog.program}.` }));
    } else {
      out.push(
        ctx.report.addClaim({
          ...base,
          kind: "Derived",
          evidenceIds: ev,
          assumptions: ["the upgrade authority is willing and able to act before the power is misused", "upgrade authority as read at analysis time"],
          statement: `Recovery path for ${what}: the upgrade authority ${short(prog.upgradeAuthority)} of ${prog.program} can deploy code that reverses it.`
        })
      );
    }
  }
  return out;
}

/** Capability preview + recovery paths. Call after the rules (runRules does this). */
export function runCapabilityGraph(ctx: RuleContext, opts: CapabilityGraphOptions = {}): { previewClaims: string[]; recoveryClaims: string[] } {
  return { previewClaims: addCapabilityPreviews(ctx, opts), recoveryClaims: addRecoveryPaths(ctx) };
}
