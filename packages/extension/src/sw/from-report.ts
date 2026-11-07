// Map the engine's kelvara-report-v1 (@kelvara/core, packages/core/src/report/schema.ts) onto the
// report UI's ReportView plus a numeric alert level. Pure: no chrome.*, no I/O.
// X6a: not wired into the live service worker yet (hour-24 rule); X6 swaps the engine stub for it.
//
// Fail closed: a report that fails validateReport, analyzed different bytes than the worker holds,
// or does not fit the view's caps maps to a blocked engine-error verdict, never to a pass.
import { validateReport, type Capability, type Claim, type Evidence, type Report } from "@kelvara/core";
import type { WorkerVerdict } from "../shared/protocol.js";
import {
  validateReportView,
  type CapabilityChange,
  type Claim as ViewClaim,
  type Confidence,
  type PreviewEntry as ViewPreview,
  type ReportView,
  type Risk
} from "../shared/report-view.js";

export type Level = 0 | 1 | 2 | 3 | 4;

export type FromReport =
  | { ok: true; level: Level; report: ReportView }
  | { ok: false; reason: string; verdict: WorkerVerdict };

// Caps of validateReportView (src/shared/report-view.ts). Text is shortened to fit; counts that
// do not fit are not representable and fail closed (dropping a claim would hide a finding).
const MAX_TEXT = 2000;
const MAX_SHORT = 200;
const MAX_ITEMS = 64;
const MAX_PREVIEW = 16;
const MAX_EVIDENCE = 32;

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

class Unrepresentable extends Error {}

const LEVELS: Record<Report["alert"]["level"], Level> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

/** capability-risk-v1 class -> the UI's risk word. */
const RISK: Record<Capability["class"], Risk> = {
  code_control: "critical",
  admin_control: "critical",
  fund_movement: "high",
  mint_control: "high",
  account_control: "high",
  freeze: "medium",
  bounded_spend: "medium",
  config: "low",
  other: "low"
};

const CONFIDENCE: Record<Report["preview"][number]["confidence"], Confidence> = {
  verified: "verified",
  lower: "lower",
  observed: "observed",
  unknown: "unknown"
};

export const DEPLOY_ANY_CODE = "can deploy any code";

const capPhrase = (c: Capability): string => `${c.capability} of ${c.target ?? "an unknown target"}`;

/** One ranking for the UI (1 = most dangerous): score desc, granted before revoked, then engine rank. */
function rankCapabilities(r: Report): CapabilityChange[] {
  const all = [...r.capabilities.granted, ...r.capabilities.revoked];
  if (all.length > MAX_ITEMS) throw new Unrepresentable(`${all.length} capability changes`);
  return all
    .slice()
    .sort((a, b) => b.score - a.score || (a.direction === b.direction ? a.rank - b.rank : a.direction === "granted" ? -1 : 1))
    .map((c, i) => ({
      rank: i + 1,
      change: c.direction,
      authority: clip(capPhrase(c), MAX_SHORT),
      holder: clip(c.holder ?? "unknown", MAX_SHORT),
      risk: RISK[c.class]
    }));
}

function authorizes(r: Report): string | null {
  const parts: string[] = [];
  const list = (caps: Capability[]) => caps.map((c) => `${capPhrase(c)}${c.holder ? ` (holder ${c.holder})` : ""}`).join("; ");
  if (r.capabilities.granted.length) parts.push(`Grants ${list(r.capabilities.granted)}.`);
  if (r.capabilities.revoked.length) parts.push(`Revokes ${list(r.capabilities.revoked)}.`);
  return parts.length ? clip(parts.join(" "), MAX_TEXT) : null;
}

function simulationLine(r: Report): string | null {
  const s = r.simulation;
  if (s.status === "not_run") return null;
  return clip(s.status === "failed" ? `Simulation failed: ${s.summary}` : s.summary, MAX_TEXT);
}

/** Preview entries, "can deploy any code" first (stable), each entry's unlocks in rubric order. */
function previews(r: Report): ViewPreview[] {
  if (r.preview.length > MAX_PREVIEW) throw new Unrepresentable(`${r.preview.length} preview entries`);
  return r.preview
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.deployAnyCode) - Number(a.p.deployAnyCode) || a.i - b.i)
    .map(({ p }) => {
      const can = p.unlocks
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((u) => ({ name: clip(u.instruction, MAX_SHORT), detail: clip(u.changes, MAX_SHORT) }));
      if (p.deployAnyCode) can.unshift({ name: DEPLOY_ANY_CODE, detail: "replaces the program's code: every other power of the program follows" });
      if (can.length > MAX_ITEMS) throw new Unrepresentable(`${can.length} unlocks in ${p.id}`);
      const who = p.authority ?? "an unknown authority";
      const over = p.programId ? ` over ${p.programId}` : "";
      return { authority: clip(`${who}${over}`, MAX_SHORT), confidence: CONFIDENCE[p.confidence], can };
    });
}

function evidenceLine(e: Evidence): string {
  const where = [
    e.transactionIndex !== null ? `tx ${e.transactionIndex + 1}` : "",
    e.instructionPath ? `ix ${e.instructionPath.join(".")}` : "",
    e.address ?? ""
  ].filter(Boolean);
  return clip(`${e.id} · ${e.type} from ${e.source}${where.length ? ` · ${where.join(" · ")}` : ""}: ${e.summary}`, MAX_TEXT);
}

function claimText(c: Claim): string {
  const extra = [
    c.dependsOn.length ? `Follows from ${c.dependsOn.join(", ")}.` : "",
    c.assumptions.length ? `Assumes: ${c.assumptions.join("; ")}.` : "",
    c.ruleId ? `Rule ${c.ruleId}, ${c.level}.` : `${c.level}.`
  ].filter(Boolean);
  return clip(`${c.statement} ${extra.join(" ")}`, MAX_TEXT);
}

/** Claims, highest level first (stable), each with its evidence. Over 32 evidence items: 31 and a count. */
function claims(r: Report): ViewClaim[] {
  if (r.claims.length > MAX_ITEMS) throw new Unrepresentable(`${r.claims.length} claims`);
  const byId = new Map(r.evidence.map((e) => [e.id, e]));
  return r.claims
    .map((c, i) => ({ c, i }))
    .sort((a, b) => LEVELS[b.c.level] - LEVELS[a.c.level] || a.i - b.i)
    .map(({ c }) => {
      let evidence = c.evidenceIds.map((id) => evidenceLine(byId.get(id)!));
      if (evidence.length > MAX_EVIDENCE) {
        const more = evidence.length - (MAX_EVIDENCE - 1);
        evidence = [...evidence.slice(0, MAX_EVIDENCE - 1), `and ${more} more evidence items (${c.evidenceIds.slice(MAX_EVIDENCE - 1).join(", ")})`.slice(0, MAX_TEXT)];
      }
      return { id: c.id, kind: c.kind, text: claimText(c), evidence };
    });
}

function header(r: Report): { title: string; summary: string } {
  const byId = new Map(r.claims.map((c) => [c.id, c]));
  const top = r.alert.claimIds.map((id) => byId.get(id)!);
  const tally = `${r.counts.claims} claim(s), ${r.counts.granted} granted and ${r.counts.revoked} revoked capability change(s).`;
  if (top.length === 0) return { title: `${r.alert.label}: no finding reaches a notice level`, summary: tally };
  return {
    title: clip(`${r.alert.label}: ${top[0]!.statement}`, MAX_SHORT),
    summary: clip(`${top.map((c) => c.statement).join(" ")} ${tally}`, MAX_TEXT)
  };
}

const EMPTY: ReportView = { title: "", summary: "", simulation: null, authorizes: null, capabilities: [], preview: [], claims: [], messageHashes: [], limited: false };

/** Blocked engine-error verdict, same shape as policy.ts's failure(): never allow, never hold. */
export function engineErrorVerdict(reason: string, hashes: readonly string[]): WorkerVerdict {
  const safeHashes = validateReportView({ ...EMPTY, messageHashes: [...hashes] }) ? [...hashes] : [];
  return {
    allow: false,
    hold: false,
    level: null,
    reason,
    report: {
      ...EMPTY,
      title: "Blocked: request could not be analyzed",
      summary: clip(`${reason}. SignGuard blocks what it cannot check.`, MAX_TEXT),
      messageHashes: safeHashes
    }
  };
}

/**
 * Map an engine report to the UI's view. `hashes` are the base58 message hashes the worker computed
 * itself from the bytes it holds (policy.ts messageHashes); the report must cover exactly those.
 * limited is always false here: the license limiter runs after this, in decide().
 */
export function fromReport(input: unknown, hashes: readonly string[]): FromReport {
  const fail = (reason: string): FromReport => ({ ok: false, reason, verdict: engineErrorVerdict(reason, hashes) });
  try {
    const checked = validateReport(input);
    if (!checked.ok) return fail("engine error: report failed validation");
    const r = checked.report;
    const reportHashes = r.session.transactions.map((t) => t.messageHash);
    if (reportHashes.length !== hashes.length || reportHashes.some((h, i) => h !== hashes[i])) {
      return fail("engine error: report covers different transactions than the request");
    }
    let level = LEVELS[r.alert.level];
    const viewClaims = claims(r);
    // Unresolved accounts (e.g. a lookup table that could not be read): Unknown is never safe.
    if (!r.session.complete && level < 2) {
      level = 2;
      viewClaims.unshift({
        id: "extension.session_incomplete",
        kind: "Unknown",
        text: "Some accounts in this request could not be resolved, so the analysis is incomplete. Unknown is never treated as safe.",
        evidence: []
      });
      if (viewClaims.length > MAX_ITEMS) throw new Unrepresentable("claims");
    }
    const head = !r.session.complete && LEVELS[r.alert.level] < 2
      ? { title: "Warning: analysis incomplete, some accounts could not be resolved", summary: header(r).summary }
      : header(r);
    const view = validateReportView({
      title: head.title,
      summary: head.summary,
      simulation: simulationLine(r),
      authorizes: authorizes(r),
      capabilities: rankCapabilities(r),
      preview: previews(r),
      claims: viewClaims,
      messageHashes: [...hashes],
      limited: false
    });
    if (!view) return fail("engine error: report cannot be shown");
    return { ok: true, level, report: view };
  } catch (e) {
    return fail(e instanceof Unrepresentable ? "engine error: report too large to show" : "engine error: report could not be mapped");
  }
}
