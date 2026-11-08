// Map the engine's kelvara-report-v1 (@kelvara/core, packages/core/src/report/schema.ts) onto the
// report UI's ReportView plus a numeric alert level. Pure: no chrome.*, no I/O.
// Claim text is the engine's template explanation (explainReport, E15); evidence is the explorer's
// structured items: transaction, instruction path, decoded arguments, IDL path, account snapshot (X8).
//
// Fail closed: a report that fails validateReport, analyzed different bytes than the worker holds,
// or does not fit the view's caps maps to a blocked engine-error verdict, never to a pass.
import { explainReport, validateReport, type Capability, type Claim, type Evidence, type Report, type ReportExplanation } from "@kelvara/core";
import type { WorkerVerdict } from "../shared/protocol.js";
import {
  validateReportView,
  type CapabilityChange,
  type Claim as ViewClaim,
  type Confidence,
  type EvidenceField,
  type EvidenceItem,
  type PreviewEntry as ViewPreview,
  type ReportDetails,
  type ReportView,
  type Risk,
  VIEW_CAPS
} from "../shared/report-view.js";
import { authorizeFacts, factLines, factSummary, hasNoPermissionChange, humanSimulation, NO_PERMISSION_TEXT } from "./facts-text.js";
import { idlPathFor } from "./idl-paths.js";

export type Level = 0 | 1 | 2 | 3 | 4;

export type FromReport =
  | { ok: true; level: Level; report: ReportView }
  | { ok: false; reason: string; verdict: WorkerVerdict };

// Caps of validateReportView (src/shared/report-view.ts). Text is shortened to fit; counts that
// do not fit are not representable and fail closed (dropping a claim would hide a finding).
const MAX_TEXT = VIEW_CAPS.text;
const MAX_SHORT = VIEW_CAPS.short;
const MAX_ITEMS = VIEW_CAPS.items;
const MAX_PREVIEW = VIEW_CAPS.preview;

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

const PROGRAM_NAMES: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads v4",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo",
  BPFLoaderUpgradeab1e11111111111111111111111: "Upgradeable Loader"
};
const shortId = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const programLabel = (programId: string | null, registryName: string | null): string => (programId && PROGRAM_NAMES[programId]) || registryName || (programId ? shortId(programId) : "an unknown program");

interface IxView { tx: number; path: string; program: string; name: string | null; args: unknown; accounts: unknown; programId: string | null }

/** Instruction evidence in request order, one entry per instruction path. */
function instructionViews(r: Report): IxView[] {
  const seen = new Set<string>();
  const out: IxView[] = [];
  for (const e of r.evidence) {
    if (e.type !== "instruction" || e.transactionIndex === null || !e.instructionPath?.length) continue;
    const key = `${e.transactionIndex}:${e.instructionPath.join(".")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = (e.data && typeof e.data === "object" && !Array.isArray(e.data) ? e.data : {}) as Record<string, unknown>;
    const programId = typeof d.programId === "string" ? d.programId : e.address;
    out.push({
      tx: e.transactionIndex,
      path: e.instructionPath.slice(0, 8).join("."),
      program: programLabel(programId, typeof d.program === "string" ? d.program : null),
      name: typeof d.name === "string" && d.name ? d.name : null,
      args: d.args,
      accounts: d.accounts,
      programId
    });
  }
  return out.sort((a, b) => a.tx - b.tx || a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** "Could not decode 1 instruction on Squads v4; its effects are unknown." One sentence per program. */
function undecodedText(r: Report): string {
  const byProgram = new Map<string, number>();
  for (const i of instructionViews(r)) if (i.name === null) byProgram.set(i.program, (byProgram.get(i.program) ?? 0) + 1);
  return [...byProgram].map(([p, n]) => `Could not decode ${n} instruction${n === 1 ? "" : "s"} on ${p}; ${n === 1 ? "its" : "their"} effects are unknown.`).join(" ");
}

function authorizes(r: Report): string | null {
  const parts: string[] = [];
  const list = (caps: Capability[]) => caps.map((c) => `${capPhrase(c)}${c.holder ? ` (holder ${c.holder})` : ""}`).join("; ");
  if (r.capabilities.granted.length) parts.push(`Grants ${list(r.capabilities.granted)}.`);
  if (r.capabilities.revoked.length) parts.push(`Revokes ${list(r.capabilities.revoked)}.`);
  parts.push(...authorizeFacts(r));
  const unknown = undecodedText(r);
  if (unknown) parts.push(unknown);
  return parts.length ? clip(parts.join(" "), MAX_TEXT) : null;
}

const argRows = (args: unknown): EvidenceField[] => {
  const rows: EvidenceField[] = [];
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args)) if (rows.length < 6) rows.push({ key: clip(k, MAX_SHORT), value: clip(scalar(v), MAX_SHORT) });
  }
  return rows;
};
const accountRows = (accounts: unknown): EvidenceField[] => {
  const rows: EvidenceField[] = [];
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      const acc = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      if (rows.length < 6 && typeof acc.name === "string" && acc.name && typeof acc.address === "string") rows.push({ key: clip(acc.name, MAX_SHORT), value: clip(acc.address, MAX_SHORT) });
    }
  }
  return rows;
};

/** Step 2 of the report: ordered instructions named from the IDL, and what changes after signing. */
function reviewDetails(r: Report): ReportDetails {
  const ixs = instructionViews(r).slice(0, MAX_ITEMS);
  const multi = r.session.transactions.length > 1;
  const changes: string[] = [];
  for (const c of r.capabilities.granted) changes.push(clip(`Grants ${capPhrase(c)}${c.holder ? ` to ${c.holder}` : ""}.`, 600));
  for (const c of r.capabilities.revoked) changes.push(clip(`Revokes ${capPhrase(c)}${c.holder ? ` from ${c.holder}` : ""}.`, 600));
  for (const f of factLines(r)) if (f.rule === "fact.sol_transfer" || f.rule === "fact.token_transfer") changes.push(clip(`${multi && f.tx !== null ? `Transaction ${f.tx}: ` : ""}${f.text}.`, 600));
  for (const c of r.claims) if (c.kind === "Fact" && c.level !== "L0" && c.level !== null && !c.ruleId?.startsWith("fact.")) changes.push(clip(c.statement.trim(), 600));
  if (hasNoPermissionChange(r)) changes.push(NO_PERMISSION_TEXT);
  return {
    instructions: ixs.map((i) => ({ tx: i.tx, path: i.path, program: clip(i.program, MAX_SHORT), name: i.name ? clip(i.name, MAX_SHORT) : null, args: argRows(i.args), accounts: accountRows(i.accounts) })),
    changes: [...new Set(changes)].slice(0, 32)
  };
}

function simulationLine(r: Report): string | null {
  const s = r.simulation;
  if (s.status === "not_run") return null;
  return clip(s.status === "failed" ? `Simulation failed: ${s.summary}` : humanSimulation(s.summary, r.session.transactions.length), MAX_TEXT);
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

const scalar = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v));

/** Flatten evidence data into text rows ("args.amount" = "5"), depth-first, capped. */
function flatten(data: unknown, rows: EvidenceField[], prefix: string, depth = 0): void {
  if (rows.length >= VIEW_CAPS.fields) return;
  const push = (key: string, value: string) => rows.length < VIEW_CAPS.fields && rows.push({ key: clip(key || "value", MAX_SHORT), value: clip(value, MAX_SHORT) });
  if (data === null || typeof data !== "object" || depth >= 6) return void push(prefix, scalar(data));
  const entries: [string, unknown][] = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data);
  if (entries.length === 0) return void push(prefix, Array.isArray(data) ? "[]" : "{}");
  // Short arrays of scalars (byte arrays, seeds) read better on one line.
  if (Array.isArray(data) && data.every((v) => v === null || typeof v !== "object")) return void push(prefix, data.map(scalar).join(", "));
  for (const [k, v] of entries) flatten(v, rows, prefix ? `${prefix}.${k}` : k, depth + 1);
}

/** Rows for an evidence item: instruction evidence gets program/name/args/named accounts; the rest is flattened. */
function evidenceFields(e: Evidence): EvidenceField[] {
  const rows: EvidenceField[] = [];
  const d = e.data;
  if (e.type === "instruction" && d && typeof d === "object" && !Array.isArray(d)) {
    const o = d as Record<string, unknown>;
    const { accounts, args } = o;
    // programId and decoder are shown as Address and IDL; accounts and args get their own rows.
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !["accounts", "args", "programId", "decoder"].includes(k)));
    flatten(rest, rows, "");
    if (args !== undefined) flatten(args, rows, "args");
    if (Array.isArray(accounts)) {
      for (const a of accounts) {
        if (rows.length >= VIEW_CAPS.fields) break;
        const acc = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
        const flags = [acc.signer === true ? "signer" : "", acc.writable === true ? "writable" : ""].filter(Boolean);
        rows.push({
          key: clip(`accounts.${typeof acc.name === "string" && acc.name ? acc.name : "?"}`, MAX_SHORT),
          value: clip(`${typeof acc.address === "string" ? acc.address : "unresolved"}${flags.length ? ` (${flags.join(", ")})` : ""}`, MAX_SHORT)
        });
      }
    }
  } else if (d !== null && d !== undefined) {
    flatten(d, rows, "");
  }
  return rows;
}

function idlOf(e: Evidence): string | null {
  const d = (e.data && typeof e.data === "object" && !Array.isArray(e.data) ? e.data : {}) as Record<string, unknown>;
  if (typeof d.idl === "string") return clip(d.idl, MAX_SHORT);
  if (e.type === "instruction") return idlPathFor(typeof d.programId === "string" ? d.programId : e.address, typeof d.decoder === "string" ? d.decoder : null);
  return null;
}

function evidenceItem(e: Evidence): EvidenceItem {
  return {
    id: e.id,
    type: e.type,
    source: e.source,
    summary: clip(e.summary, MAX_TEXT),
    tx: e.transactionIndex,
    path: e.instructionPath ? e.instructionPath.slice(0, 8).join(".") : null,
    address: e.address,
    idl: idlOf(e),
    fields: evidenceFields(e)
  };
}

const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * Claims in the explanation's order (alert claims first, then by level), each with the engine's template
 * text; evidence listed once for the whole view. Over the per-claim cap: the first ids and a count.
 */
function claimsAndEvidence(r: Report, ex: ReportExplanation): { claims: ViewClaim[]; evidence: EvidenceItem[] } {
  if (r.claims.length > MAX_ITEMS) throw new Unrepresentable(`${r.claims.length} claims`);
  const byClaim = new Map(r.claims.map((c) => [c.id, c]));
  const byEvidence = new Map(r.evidence.map((e) => [e.id, e]));
  const used = new Map<string, EvidenceItem>();
  const claims = ex.claims.map((x): ViewClaim => {
    const c: Claim = byClaim.get(x.claimId)!;
    const ids = [...new Set(c.evidenceIds)];
    const shown = ids.slice(0, VIEW_CAPS.claimEvidence);
    for (const id of shown) if (!used.has(id)) used.set(id, evidenceItem(byEvidence.get(id)!));
    const extra = [
      x.assumptions.length ? `Assumes: ${x.assumptions.map((a) => a.trim().replace(/[.]$/, "")).join("; ")}.` : "",
      c.dependsOn.length ? `Follows from ${c.dependsOn.join(", ")}.` : ""
    ].filter(Boolean);
    return {
      id: c.id,
      kind: c.kind,
      level: c.level,
      rule: c.ruleId,
      title: clip(x.title, MAX_SHORT),
      text: clip([x.text, ...extra].join(" "), MAX_TEXT),
      advice: clip(sentence(x.advice), MAX_TEXT),
      evidenceIds: shown,
      moreEvidence: ids.length - shown.length
    };
  });
  if (used.size > VIEW_CAPS.evidence) throw new Unrepresentable(`${used.size} evidence items`);
  return { claims, evidence: [...used.values()] };
}

function header(r: Report, ex: ReportExplanation): { title: string; summary: string } {
  const byId = new Map(r.claims.map((c) => [c.id, c]));
  const top = r.alert.claimIds.map((id) => byId.get(id)!);
  // Counts only as a small secondary sentence, and only when something changed.
  const g = r.counts.granted, v = r.counts.revoked;
  const tally = g + v > 0 ? `${g} permission${g === 1 ? "" : "s"} granted and ${v} revoked.` : "";
  if (top.length === 0) {
    const human = factSummary(r) ?? "SignGuard found no risks but could not describe what this request does.";
    return { title: clip(ex.headline.replace(/^([^:]+): /, "$1 · "), MAX_SHORT), summary: clip(`${human} ${tally}`.trim(), MAX_TEXT) };
  }
  return {
    // Template headline: the alert label and the rule titles of the alert claims (engine explainReport).
    title: clip(ex.headline, MAX_SHORT),
    summary: clip(`${top.map((c) => sentence(c.statement)).join(" ")} ${tally}`.trim(), MAX_TEXT)
  };
}

const EMPTY: ReportView = { title: "", summary: "", simulation: null, authorizes: null, capabilities: [], preview: [], claims: [], evidence: [], messageHashes: [], limited: false };

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
    const ex = explainReport(r);
    const { claims: viewClaims, evidence } = claimsAndEvidence(r, ex);
    // Unresolved accounts (e.g. a lookup table that could not be read): Unknown is never safe.
    if (!r.session.complete && level < 2) {
      level = 2;
      viewClaims.unshift({
        id: "extension.session_incomplete",
        kind: "Unknown",
        level: "L2",
        rule: null,
        title: "The analysis is incomplete",
        text: "Some accounts in this request could not be resolved, so the analysis is incomplete. Unknown is never treated as safe.",
        advice: "Block unless you checked the request in your wallet.",
        evidenceIds: [],
        moreEvidence: 0
      });
      if (viewClaims.length > MAX_ITEMS) throw new Unrepresentable("claims");
    }
    const head = !r.session.complete && LEVELS[r.alert.level] < 2
      ? { title: "Warning: analysis incomplete, some accounts could not be resolved", summary: header(r, ex).summary }
      : header(r, ex);
    const view = validateReportView({
      title: head.title,
      summary: head.summary,
      simulation: simulationLine(r),
      authorizes: authorizes(r),
      details: reviewDetails(r),
      capabilities: rankCapabilities(r),
      preview: previews(r),
      claims: viewClaims,
      evidence,
      messageHashes: [...hashes],
      limited: false
    });
    if (!view) return fail("engine error: report cannot be shown");
    return { ok: true, level, report: view };
  } catch (e) {
    return fail(e instanceof Unrepresentable ? "engine error: report too large to show" : "engine error: report could not be mapped");
  }
}
