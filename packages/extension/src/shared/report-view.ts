// What the report UI shows. The service worker builds it (from the engine stub now,
// from @kelvara/core's report after the hour-24 checkpoint), the bridge passes it to the
// extension iframe, and the iframe validates it again before rendering it as text only.
// Exact keys and hard size caps everywhere: a malformed view is a blocked request.

export const CLAIM_KINDS = ["Fact", "Derived", "Conditional", "Unknown"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const RISKS = ["critical", "high", "medium", "low", "unknown"] as const;
export type Risk = (typeof RISKS)[number];
export const CONFIDENCES = ["verified", "lower", "conditional", "unknown"] as const;
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

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string;
  evidence: string[];
}

export interface ReportView {
  /** Risk header: one line, what is at stake. */
  title: string;
  summary: string;
  /** "What simulation shows" next to "what you actually authorize"; null when not run. */
  simulation: string | null;
  authorizes: string | null;
  capabilities: CapabilityChange[];
  preview: PreviewEntry[];
  claims: Claim[];
  /** Base58 SHA-256 of each transaction message, to match on a Ledger. */
  messageHashes: string[];
  /** No valid license: only the risk header and top finding were kept (src/license/limit.ts). */
  limited: boolean;
}

const MAX_TEXT = 2000;
const MAX_SHORT = 200;
const MAX_ITEMS = 64;
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

function isClaim(x: unknown): x is Claim {
  return (
    plain(x) &&
    exact(x, ["id", "kind", "text", "evidence"]) &&
    str(x.id, MAX_SHORT) &&
    oneOf(x.kind, CLAIM_KINDS) &&
    str(x.text) &&
    list(x.evidence, (e): e is string => str(e, MAX_TEXT), 32)
  );
}

export function validateReportView(x: unknown): ReportView | null {
  if (!plain(x)) return null;
  if (!exact(x, ["title", "summary", "simulation", "authorizes", "capabilities", "preview", "claims", "messageHashes", "limited"])) return null;
  if (typeof x.limited !== "boolean") return null;
  if (!str(x.title, MAX_SHORT) || !str(x.summary)) return null;
  if (!(x.simulation === null || str(x.simulation)) || !(x.authorizes === null || str(x.authorizes))) return null;
  if (!list(x.capabilities, isCapability) || !list(x.preview, isPreview, 16) || !list(x.claims, isClaim)) return null;
  if (!list(x.messageHashes, (h): h is string => typeof h === "string" && B58_HASH.test(h))) return null;
  return x as unknown as ReportView;
}

/** Ranked for display: lowest rank first, stable. */
export function rankedCapabilities(view: ReportView): CapabilityChange[] {
  return view.capabilities.map((c, i) => ({ c, i })).sort((a, b) => a.c.rank - b.c.rank || a.i - b.i).map(({ c }) => c);
}
