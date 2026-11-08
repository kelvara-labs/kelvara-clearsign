import { validateReportIntent, type ReportIntent } from "../intent/selection.js";
import { validateMessageReview, type MessageReview } from "./message-view.js";
// What the report UI shows. The service worker builds it (from the engine stub now,
// from @kelvara/core's report after the hour-24 checkpoint), the bridge passes it to the
// extension iframe, and the iframe validates it again before rendering it as text only.
// Exact keys and hard size caps everywhere: a malformed view is a blocked request.

export const CLAIM_KINDS = ["Fact", "Derived", "Conditional", "Unknown"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const RISKS = ["critical", "high", "medium", "low", "unknown"] as const;
export type Risk = (typeof RISKS)[number];
// "observed": seen in the program's history, not from an IDL (engine preview confidence).
export const CONFIDENCES = ["verified", "lower", "observed", "conditional", "unknown"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface CapabilityChange {
  rank: number; // 1 = most dangerous
  change: "granted" | "revoked";
  authority: string; // e.g. "upgrade authority of <program>"
  holder: string; // who holds it after this transaction
  risk: Risk;
}

export interface PreviewEntry {
  authority: string;
  confidence: Confidence;
  can: { name: string; detail: string }[]; // ranked by damage, first = worst
}

export const ALERT_LEVEL_NAMES = ["L0", "L1", "L2", "L3", "L4"] as const;
export type AlertLevelName = (typeof ALERT_LEVEL_NAMES)[number];
// Engine evidence types and sources (kelvara-report-v1), plus "extension" for the worker's own notes.
export const EVIDENCE_TYPES = ["message", "instruction", "account", "simulation", "history", "idl", "derivation"] as const;
export const EVIDENCE_SOURCES = ["message", "rpc", "simulation", "helius", "idl", "engine", "extension"] as const;

/** One row of an evidence item's data: a decoded argument, a named account, a snapshot field. */
export interface EvidenceField {
  key: string;
  value: string;
}

/** Evidence explorer entry (PLAN M7): where it is in the request and what was read. */
export interface EvidenceItem {
  id: string;
  type: (typeof EVIDENCE_TYPES)[number];
  source: (typeof EVIDENCE_SOURCES)[number];
  summary: string;
  /** 0-based transaction index in the request, or null (session/account evidence). */
  tx: number | null;
  /** Instruction path, "2" (top-level) or "2.0.1" (inside a Squads message); null when not an instruction. */
  path: string | null;
  address: string | null;
  /** IDL the evidence was decoded or derived with (repo path), or null. */
  idl: string | null;
  /** Decoded arguments, named accounts or the account snapshot, flattened to text rows. */
  fields: EvidenceField[];
}

export interface Claim {
  id: string;
  kind: ClaimKind;
  /** Alert level this claim reaches; null for the worker's own notes without one. */
  level: AlertLevelName | null;
  rule: string | null;
  /** Template headline for the rule (engine explainClaim). */
  title: string;
  /** Kind lead + the claim's own statement + why it matters (engine template text). */
  text: string;
  /** What the user can do about it (template), or null. */
  advice: string | null;
  /** Ids into ReportView.evidence, in the claim's order. */
  evidenceIds: string[];
  /** Evidence items not listed (over the per-claim cap). */
  moreEvidence: number;
}

export interface ReportView {
  intent?: ReportIntent;
  /** Message-signing review (signMessage / signIn); the transaction sections are then empty. */
  message?: MessageReview;
  /** Risk header: one line, what is at stake. */
  title: string;
  summary: string;
  /** "What simulation shows" next to "what you actually authorize"; null when not run. */
  simulation: string | null;
  authorizes: string | null;
  capabilities: CapabilityChange[];
  preview: PreviewEntry[];
  claims: Claim[];
  /** Every evidence item a claim points at, each listed once. */
  evidence: EvidenceItem[];
  /** Base58 SHA-256 of each transaction message, to match on a Ledger. */
  messageHashes: string[];
  /** No valid license: only the risk header and top finding were kept (src/license/limit.ts). */
  limited: boolean;
}

const MAX_TEXT = 2000;
const MAX_SHORT = 200;
const MAX_ITEMS = 64;
export const VIEW_CAPS = { text: MAX_TEXT, short: MAX_SHORT, items: MAX_ITEMS, preview: 16, evidence: 256, claimEvidence: 64, fields: 48 } as const;
const B58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function plain(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}
function exact(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}
const str = (x: unknown, max = MAX_TEXT): x is string => typeof x === "string" && x.length <= max;
const oneOf = <T extends string>(x: unknown, set: readonly T[]): x is T => typeof x === "string" && (set as readonly string[]).includes(x);
function list<T>(x: unknown, ok: (v: unknown) => v is T, max = MAX_ITEMS): x is T[] {
  return Array.isArray(x) && x.length <= max && x.every(ok);
}

function isCapability(x: unknown): x is CapabilityChange {
  return (
    plain(x) &&
    exact(x, ["rank", "change", "authority", "holder", "risk"]) &&
    Number.isInteger(x.rank) &&
    (x.rank as number) >= 1 &&
    (x.change === "granted" || x.change === "revoked") &&
    str(x.authority, MAX_SHORT) &&
    str(x.holder, MAX_SHORT) &&
    oneOf(x.risk, RISKS)
  );
}

function isAbility(x: unknown): x is { name: string; detail: string } {
  return plain(x) && exact(x, ["name", "detail"]) && str(x.name, MAX_SHORT) && str(x.detail, MAX_SHORT);
}

function isPreview(x: unknown): x is PreviewEntry {
  return plain(x) && exact(x, ["authority", "confidence", "can"]) && str(x.authority, MAX_SHORT) && oneOf(x.confidence, CONFIDENCES) && list(x.can, isAbility);
}

const idOk = (x: unknown): x is string => str(x, MAX_SHORT) && x.length > 0;
const nullOr = <T>(x: unknown, ok: (v: unknown) => v is T): x is T | null => x === null || ok(x);

function isField(x: unknown): x is EvidenceField {
  return plain(x) && exact(x, ["key", "value"]) && str(x.key, MAX_SHORT) && str(x.value, MAX_SHORT);
}

function isEvidence(x: unknown): x is EvidenceItem {
  return (
    plain(x) &&
    exact(x, ["id", "type", "source", "summary", "tx", "path", "address", "idl", "fields"]) &&
    idOk(x.id) &&
    oneOf(x.type, EVIDENCE_TYPES) &&
    oneOf(x.source, EVIDENCE_SOURCES) &&
    str(x.summary) &&
    (x.tx === null || (Number.isInteger(x.tx) && (x.tx as number) >= 0)) &&
    nullOr(x.path, (v): v is string => typeof v === "string" && /^[0-9]{1,4}(\.[0-9]{1,4}){0,7}$/.test(v)) &&
    nullOr(x.address, (v): v is string => str(v, MAX_SHORT)) &&
    nullOr(x.idl, (v): v is string => str(v, MAX_SHORT)) &&
    list(x.fields, isField, VIEW_CAPS.fields)
  );
}

function isClaim(x: unknown): x is Claim {
  return (
    plain(x) &&
    exact(x, ["id", "kind", "level", "rule", "title", "text", "advice", "evidenceIds", "moreEvidence"]) &&
    idOk(x.id) &&
    oneOf(x.kind, CLAIM_KINDS) &&
    (x.level === null || oneOf(x.level, ALERT_LEVEL_NAMES)) &&
    nullOr(x.rule, (v): v is string => str(v, MAX_SHORT)) &&
    str(x.title, MAX_SHORT) &&
    str(x.text) &&
    nullOr(x.advice, (v): v is string => str(v)) &&
    list(x.evidenceIds, idOk, VIEW_CAPS.claimEvidence) &&
    Number.isInteger(x.moreEvidence) &&
    (x.moreEvidence as number) >= 0
  );
}

export function validateReportView(x: unknown): ReportView | null {
  if (!plain(x)) return null;
  if (!exact(x, ["title", "summary", "simulation", "authorizes", "capabilities", "preview", "claims", "evidence", "messageHashes", "limited", ...(Object.hasOwn(x, "intent") ? ["intent"] : []), ...(Object.hasOwn(x, "message") ? ["message"] : [])])) return null;
  if (typeof x.limited !== "boolean") return null;
  if (!str(x.title, MAX_SHORT) || !str(x.summary)) return null;
  if (!(x.simulation === null || str(x.simulation)) || !(x.authorizes === null || str(x.authorizes))) return null;
  if (!list(x.capabilities, isCapability) || !list(x.preview, isPreview, 16) || !list(x.claims, isClaim)) return null;
  if (!list(x.evidence, isEvidence, VIEW_CAPS.evidence)) return null;
  // Every evidence id is listed once, and every claim points only at listed evidence.
  const ids = new Set(x.evidence.map((e) => e.id));
  if (ids.size !== x.evidence.length) return null;
  if (!x.claims.every((c) => c.evidenceIds.every((id) => ids.has(id)))) return null;
  if (!list(x.messageHashes, (h): h is string => typeof h === "string" && B58_HASH.test(h))) return null;
  if (Object.hasOwn(x, "intent") && !validateReportIntent(x.intent, x.messageHashes as string[])) return null;
  if (Object.hasOwn(x, "message") && !validateMessageReview(x.message)) return null;
  return x as unknown as ReportView;
}

/** Ranked for display: lowest rank first, stable. */
export function rankedCapabilities(view: ReportView): CapabilityChange[] {
  return view.capabilities.map((c, i) => ({ c, i })).sort((a, b) => a.c.rank - b.c.rank || a.i - b.i).map(({ c }) => c);
}
