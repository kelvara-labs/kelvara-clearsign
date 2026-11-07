// Evidence ledger and claim builder. Rules add evidence and claims; build() assembles the
// report: prunes unreferenced evidence, ranks capabilities under capability-risk-v1, sets the
// alert level under alert-levels-v1, fills counts and the digest, then runs the G4 checks.
import type { Session } from "../ingest/types.js";
import { ENGINE_VERSION } from "../version.js";
import { canonicalJson, toJsonValue } from "./canonical.js";
import {
  ALERT_LEVELS,
  ALERT_LEVELS_V1,
  CAPABILITY_RISK_V1,
  CLAIM_KINDS,
  capabilityScore,
  levelAllowed,
  maxLevel,
  type AlertLevel,
  type CapabilityClass,
  type ClaimKind
} from "./rubrics.js";
import { REPORT_SCHEMA_VERSION, type Capability, type Claim, type ClaimScope, type Evidence, type PreviewEntry, type Report } from "./schema.js";
import { compareCapabilities, reportDigest, validateReport } from "./validate.js";

export class ReportError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(problems.length ? `${message}: ${problems.join("; ")}` : message);
    this.name = "ReportError";
  }
}

export interface EvidenceInput {
  type: Evidence["type"];
  source: Evidence["source"];
  summary: string;
  transactionIndex?: number | null;
  instructionPath?: number[] | null;
  address?: string | null;
  /** Any decoder output; bigint, Uint8Array and Map are converted to plain JSON. */
  data?: unknown;
}

/** Append-only evidence store. Identical evidence (same content) gets the same id. */
export class EvidenceLedger {
  private readonly items: Evidence[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, Evidence>();

  constructor(private readonly txCount: number) {}

  add(input: EvidenceInput): string {
    if (!input.summary) throw new ReportError("evidence needs a summary");
    const ti = input.transactionIndex ?? null;
    if (ti !== null && !(Number.isInteger(ti) && ti >= 0 && ti < this.txCount)) throw new ReportError(`evidence transactionIndex ${ti} out of range`);
    const body = {
      type: input.type,
      source: input.source,
      summary: input.summary,
      transactionIndex: ti,
      instructionPath: input.instructionPath ? [...input.instructionPath] : null,
      address: input.address ?? null,
      data: toJsonValue(input.data ?? null)
    };
    const key = canonicalJson(body);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = `e${this.items.length + 1}`;
    const ev: Evidence = { id, ...body };
    this.items.push(ev);
    this.byKey.set(key, id);
    this.byId.set(id, ev);
    return id;
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): readonly Evidence[] {
    return this.items;
  }
}

export interface ClaimInput {
  kind: ClaimKind;
  statement: string;
  evidenceIds?: string[];
  dependsOn?: string[];
  ruleId?: string | null;
  assumptions?: string[];
  /** Defaults to "transaction" when the claim touches one transaction, else "session". */
  scope?: ClaimScope;
  /** Defaults to the transactions named by its evidence and the claims it depends on. */
  transactionIndices?: number[];
  /** Defaults to L0. */
  level?: AlertLevel;
}

export interface CapabilityInput {
  direction: Capability["direction"];
  capability: string;
  class: CapabilityClass;
  holder: string | null;
  target: string | null;
  claimId: string;
}

export interface PreviewInput {
  authority: string | null;
  programId: string | null;
  confidence: PreviewEntry["confidence"];
  deployAnyCode: boolean;
  unlocks: { instruction: string; discriminator: string | null; changes: string; class: CapabilityClass }[];
  claimId: string;
}

export interface ReportSessionInput {
  id: string;
  complete: boolean;
  transactions: { index: number; messageHash: string; version: "legacy" | 0 | 1; label?: string | null }[];
}

export function reportSessionFrom(session: Session): ReportSessionInput {
  return {
    id: session.id,
    complete: session.complete,
    transactions: session.transactions.map((t) => ({ index: t.index, messageHash: t.messageHash, version: t.version, label: t.label ?? null }))
  };
}

const uniqSorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);

export class ReportBuilder {
  readonly evidence: EvidenceLedger;
  private readonly session: Report["session"];
  private readonly claims: Claim[] = [];
  private readonly claimById = new Map<string, Claim>();
  private readonly caps: Omit<Capability, "rank">[] = [];
  private readonly previews: PreviewInput[] = [];
  private simulation: Report["simulation"] = { status: "not_run", summary: "Simulation was not run.", evidenceIds: [] };

  constructor(session: ReportSessionInput | Session, private readonly engineVersion = ENGINE_VERSION) {
    const s = "lookupTables" in session ? reportSessionFrom(session) : session;
    this.session = {
      id: s.id,
      complete: s.complete,
      transactions: s.transactions.map((t) => ({ index: t.index, messageHash: t.messageHash, version: t.version, label: t.label ?? null }))
    };
    this.evidence = new EvidenceLedger(this.session.transactions.length);
  }

  addEvidence(input: EvidenceInput): string {
    return this.evidence.add(input);
  }

  addClaim(input: ClaimInput): string {
    const id = `c${this.claims.length + 1}`;
    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    const ruleId = input.ruleId ?? null;
    const level = input.level ?? "L0";
    const problems: string[] = [];
    for (const e of evidenceIds) if (!this.evidence.has(e)) problems.push(`evidence ${e} does not resolve`);
    for (const d of dependsOn) if (!this.claimById.has(d)) problems.push(`dependsOn ${d} is not an earlier claim`);
    if (input.kind === "Fact" && evidenceIds.length === 0) problems.push("Fact without evidence");
    if (input.kind === "Derived" && ruleId === null) problems.push("Derived without ruleId");
    if (input.kind === "Derived" && evidenceIds.length === 0 && dependsOn.length === 0) problems.push("Derived with neither evidence nor dependsOn");
    if (!levelAllowed(input.kind, ruleId, level)) problems.push(`${input.kind} claim from ${ruleId ?? "no rule"} cannot reach ${level}`);
    if (problems.length) throw new ReportError(`claim "${input.statement}" rejected`, problems);

    const tx =
      input.transactionIndices ??
      [
        ...evidenceIds.flatMap((e) => {
          const t = this.evidence.get(e)!.transactionIndex;
          return t === null ? [] : [t];
        }),
        ...dependsOn.flatMap((d) => this.claimById.get(d)!.transactionIndices)
      ];
    const transactionIndices = uniqSorted(tx);
    const claim: Claim = {
      id,
      kind: input.kind,
      statement: input.statement,
      evidenceIds,
      dependsOn,
      ruleId,
      assumptions: [...(input.assumptions ?? [])],
      scope: input.scope ?? (transactionIndices.length === 1 ? "transaction" : "session"),
      transactionIndices,
      level
    };
    this.claims.push(claim);
    this.claimById.set(id, claim);
    return id;
  }

  getClaim(id: string): Readonly<Claim> | undefined {
    return this.claimById.get(id);
  }

  addCapability(input: CapabilityInput): string {
    if (!this.claimById.has(input.claimId)) throw new ReportError(`capability claim ${input.claimId} does not resolve`);
    const id = `k${this.caps.length + 1}`;
    this.caps.push({ id, ...input, score: capabilityScore(input.class) });
    return id;
  }

  addPreview(input: PreviewInput): string {
    if (!this.claimById.has(input.claimId)) throw new ReportError(`preview claim ${input.claimId} does not resolve`);
    this.previews.push({ ...input, unlocks: input.unlocks.map((u) => ({ ...u })) });
    return `p${this.previews.length}`;
  }

  setSimulation(sim: Report["simulation"]): void {
    for (const e of sim.evidenceIds) if (!this.evidence.has(e)) throw new ReportError(`simulation evidence ${e} does not resolve`);
    this.simulation = { status: sim.status, summary: sim.summary, evidenceIds: [...new Set(sim.evidenceIds)] };
  }

  build(): Report {
    const referenced = new Set([...this.claims.flatMap((c) => c.evidenceIds), ...this.simulation.evidenceIds]);
    const evidence = this.evidence.list().filter((e) => referenced.has(e.id)).map((e) => structuredClone(e));
    const rank = (dir: Capability["direction"]): Capability[] =>
      this.caps
        .filter((c) => c.direction === dir)
        .sort(compareCapabilities)
        .map((c, i) => ({ ...c, rank: i + 1 }));
    const preview: PreviewEntry[] = this.previews.map((p, i) => ({
      id: `p${i + 1}`,
      authority: p.authority,
      programId: p.programId,
      confidence: p.confidence,
      deployAnyCode: p.deployAnyCode,
      unlocks: p.unlocks
        .map((u, j) => ({ u, j }))
        .sort((a, b) => capabilityScore(b.u.class) - capabilityScore(a.u.class) || a.j - b.j)
        .map(({ u }, j) => ({ ...u, rank: j + 1 })),
      claimId: p.claimId
    }));
    const claims = this.claims.map((c) => structuredClone(c));
    const level = maxLevel(claims.map((c) => c.level));
    const rubric = ALERT_LEVELS_V1.levels[level];
    const granted = rank("granted");
    const revoked = rank("revoked");
    const count = <K extends string>(keys: readonly K[], f: (c: Claim) => K) =>
      Object.fromEntries(keys.map((k) => [k, claims.filter((c) => f(c) === k).length])) as Record<K, number>;

    const body: Omit<Report, "digest"> = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      engineVersion: this.engineVersion,
      rubrics: { alertLevels: ALERT_LEVELS_V1.id, capabilityRisk: CAPABILITY_RISK_V1.id },
      session: structuredClone(this.session),
      alert: {
        level,
        label: rubric.label,
        action: rubric.action,
        claimIds: level === "L0" ? [] : claims.filter((c) => c.level === level).map((c) => c.id)
      },
      simulation: structuredClone(this.simulation),
      claims,
      evidence,
      capabilities: { granted, revoked },
      preview,
      counts: {
        claims: claims.length,
        evidence: evidence.length,
        granted: granted.length,
        revoked: revoked.length,
        preview: preview.length,
        byKind: count(CLAIM_KINDS, (c) => c.kind),
        byLevel: count(ALERT_LEVELS, (c) => c.level)
      }
    };
    const report: Report = { ...body, digest: reportDigest(body) };
    const v = validateReport(report);
    if (!v.ok) throw new ReportError("report failed contract checks", v.problems);
    return report;
  }
}
