// G4 contract checks: schema valid, every reference resolves, counts match, ranks follow the
// rubric, no Fact without evidence, no Derived claim without a ruleId, level per alert-levels-v1.
import { canonicalDigest } from "./canonical.js";
import { ALERT_LEVELS, ALERT_LEVELS_V1, CLAIM_KINDS, capabilityScore, levelAllowed, maxLevel } from "./rubrics.js";
import { ReportSchema, type Capability, type Report } from "./schema.js";

export type ValidationResult = { ok: true; report: Report; problems: [] } | { ok: false; report: null; problems: string[] };

const num = (id: string): number => Number(id.slice(1));

/** Digest of a report: canonical JSON of everything except the digest field. */
export function reportDigest(report: Omit<Report, "digest"> | Report): string {
  const rest: Partial<Report> = { ...(report as Report) };
  delete rest.digest;
  return canonicalDigest(rest);
}

/** Sort key under capability-risk-v1: score desc, then capability, target, id. */
export function compareCapabilities(a: Pick<Capability, "score" | "capability" | "target" | "id">, b: typeof a): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1;
  const at = a.target ?? "", bt = b.target ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return num(a.id) - num(b.id);
}

export function validateReport(input: unknown): ValidationResult {
  const parsed = ReportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, report: null, problems: parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "$"}: ${i.message}`) };
  }
  const r = parsed.data;
  const p: string[] = [];

  // Session indices are 0..n-1 in order.
  r.session.transactions.forEach((t, i) => {
    if (t.index !== i) p.push(`session.transactions[${i}].index is ${t.index}, expected ${i}`);
  });
  const txCount = r.session.transactions.length;
  const txOk = (i: number) => i < txCount;

  // Ids: unique, ascending in array order.
  const ascending = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) p.push(`${what}: duplicate id ${id}`);
      seen.add(id);
      if (i > 0 && num(id) <= num(ids[i - 1]!)) p.push(`${what}: ids not ascending at ${id}`);
    });
    return seen;
  };
  const evidenceIds = ascending("evidence", r.evidence.map((e) => e.id));
  const claimIds = ascending("claims", r.claims.map((c) => c.id));
  const claimById = new Map(r.claims.map((c) => [c.id, c]));
  ascending("capabilities", [...r.capabilities.granted, ...r.capabilities.revoked].map((c) => c.id).sort((a, b) => num(a) - num(b)));
  ascending("preview", r.preview.map((e) => e.id));

  const referenced = new Set<string>();
  const refsEvidence = (where: string, ids: string[]) => {
    if (new Set(ids).size !== ids.length) p.push(`${where}: duplicate evidence reference`);
    for (const id of ids) {
      if (!evidenceIds.has(id)) p.push(`${where}: evidence ${id} does not resolve`);
      referenced.add(id);
    }
  };
  const refsClaim = (where: string, id: string) => {
    if (!claimIds.has(id)) p.push(`${where}: claim ${id} does not resolve`);
  };

  for (const e of r.evidence) {
    if (e.transactionIndex !== null && !txOk(e.transactionIndex)) p.push(`evidence ${e.id}: transactionIndex ${e.transactionIndex} out of range`);
    if (e.instructionPath !== null && e.transactionIndex === null) p.push(`evidence ${e.id}: instructionPath without transactionIndex`);
  }

  for (const c of r.claims) {
    const w = `claim ${c.id}`;
    refsEvidence(w, c.evidenceIds);
    if (new Set(c.dependsOn).size !== c.dependsOn.length) p.push(`${w}: duplicate dependsOn`);
    for (const d of c.dependsOn) {
      refsClaim(w, d);
      // Dependencies point to earlier claims, so the graph is acyclic by construction.
      if (claimIds.has(d) && num(d) >= num(c.id)) p.push(`${w}: dependsOn ${d} is not an earlier claim`);
    }
    if (new Set(c.transactionIndices).size !== c.transactionIndices.length) p.push(`${w}: duplicate transactionIndices`);
    for (const t of c.transactionIndices) if (!txOk(t)) p.push(`${w}: transactionIndex ${t} out of range`);
    if (c.scope !== "session" && c.transactionIndices.length === 0) p.push(`${w}: scope ${c.scope} needs transactionIndices`);
    if (c.kind === "Fact" && c.evidenceIds.length === 0) p.push(`${w}: Fact without evidence`);
    if (c.kind === "Derived" && c.ruleId === null) p.push(`${w}: Derived without ruleId`);
    if (c.kind === "Derived" && c.evidenceIds.length === 0 && c.dependsOn.length === 0) p.push(`${w}: Derived with neither evidence nor dependsOn`);
    if (!levelAllowed(c.kind, c.ruleId, c.level)) p.push(`${w}: ${c.kind} claim from ${c.ruleId ?? "no rule"} cannot reach ${c.level} under ${ALERT_LEVELS_V1.id}`);
  }

  refsEvidence("simulation", r.simulation.evidenceIds);

  // Capabilities: rubric score, rank order, claim references.
  for (const dir of ["granted", "revoked"] as const) {
    const list = r.capabilities[dir];
    list.forEach((c, i) => {
      const w = `capabilities.${dir} ${c.id}`;
      if (c.direction !== dir) p.push(`${w}: direction ${c.direction} in ${dir} list`);
      if (c.score !== capabilityScore(c.class)) p.push(`${w}: score ${c.score} does not match ${c.class} (${capabilityScore(c.class)})`);
      if (c.rank !== i + 1) p.push(`${w}: rank ${c.rank}, expected ${i + 1}`);
      if (i > 0 && compareCapabilities(list[i - 1]!, c) > 0) p.push(`${w}: out of rubric order`);
      refsClaim(w, c.claimId);
    });
  }

  for (const e of r.preview) {
    const w = `preview ${e.id}`;
    refsClaim(w, e.claimId);
    e.unlocks.forEach((u, i) => {
      if (u.rank !== i + 1) p.push(`${w}: unlock ${u.instruction} rank ${u.rank}, expected ${i + 1}`);
      if (i > 0 && capabilityScore(e.unlocks[i - 1]!.class) < capabilityScore(u.class)) p.push(`${w}: unlock ${u.instruction} out of rubric order`);
    });
  }

  for (const id of r.evidence.map((e) => e.id)) if (!referenced.has(id)) p.push(`evidence ${id}: not referenced by any claim`);

  // Alert level: highest claim level; claimIds = the claims at that level.
  const level = maxLevel(r.claims.map((c) => c.level));
  if (r.alert.level !== level) p.push(`alert.level ${r.alert.level}, highest claim level is ${level}`);
  const rubric = ALERT_LEVELS_V1.levels[r.alert.level];
  if (r.alert.label !== rubric.label || r.alert.action !== rubric.action) p.push(`alert: label/action do not match ${ALERT_LEVELS_V1.id} for ${r.alert.level}`);
  const atLevel = r.claims.filter((c) => c.level === level && level !== "L0").map((c) => c.id);
  if (atLevel.join(",") !== r.alert.claimIds.join(",")) p.push(`alert.claimIds [${r.alert.claimIds}] expected [${atLevel}]`);
  for (const id of r.alert.claimIds) if (!claimById.has(id)) p.push(`alert: claim ${id} does not resolve`);

  // Counts.
  const k = r.counts;
  const expect = (name: string, got: number, want: number) => {
    if (got !== want) p.push(`counts.${name} ${got}, actual ${want}`);
  };
  expect("claims", k.claims, r.claims.length);
  expect("evidence", k.evidence, r.evidence.length);
  expect("granted", k.granted, r.capabilities.granted.length);
  expect("revoked", k.revoked, r.capabilities.revoked.length);
  expect("preview", k.preview, r.preview.length);
  for (const kind of CLAIM_KINDS) expect(`byKind.${kind}`, k.byKind[kind], r.claims.filter((c) => c.kind === kind).length);
  for (const l of ALERT_LEVELS) expect(`byLevel.${l}`, k.byLevel[l], r.claims.filter((c) => c.level === l).length);

  const digest = reportDigest(r);
  if (r.digest !== digest) p.push(`digest ${r.digest} does not match canonical ${digest}`);

  return p.length === 0 ? { ok: true, report: r, problems: [] } : { ok: false, report: null, problems: p };
}
