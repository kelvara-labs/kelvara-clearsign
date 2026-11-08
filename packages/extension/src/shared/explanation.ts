// Plain-language explanation of one report (presentation only). Pure and UI-safe: the report frame reads and
// renders it, the service worker produces it. It never changes a level, a claim, or any signing control.
import type { ReportView } from "./report-view.js";

export const EXPLAIN_MAX_SENTENCES = 5;
export const AI_SENTENCE_MAX = 240;
const OWN_SENTENCE_MAX = 2000;
const MAX_CLAIM_REFS = 8;

export interface Sentence {
  text: string;
  claimIds: string[];
}
/** "ai": written by the user's own provider and checked against the facts; "signguard": SignGuard's own text. */
export interface Explanation {
  source: "ai" | "signguard";
  sentences: Sentence[];
}

const plain = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function sentences(x: unknown, max: number, ids: ReadonlySet<string> | null): Sentence[] | null {
  if (!Array.isArray(x) || x.length < 1 || x.length > EXPLAIN_MAX_SENTENCES) return null;
  const out: Sentence[] = [];
  for (const s of x) {
    if (!plain(s) || Object.keys(s).length !== 2 || typeof s.text !== "string" || !Array.isArray(s.claimIds)) return null;
    if (!s.text.trim() || s.text.length > max || hasControl(s.text)) return null;
    if (s.claimIds.length > MAX_CLAIM_REFS || !s.claimIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) return null;
    if (ids && (!s.claimIds.length || !s.claimIds.every((id) => ids.has(id as string)))) return null;
    out.push({ text: s.text, claimIds: [...(s.claimIds as string[])] });
  }
  return out;
}

/** Strict shape check of what the worker sends the frame. */
export function readExplanation(x: unknown): Explanation | null {
  if (!plain(x) || Object.keys(x).length !== 2 || (x.source !== "ai" && x.source !== "signguard")) return null;
  const s = sentences(x.sentences, x.source === "ai" ? AI_SENTENCE_MAX : OWN_SENTENCE_MAX, null);
  return s ? { source: x.source, sentences: s } : null;
}

const B58_LONG = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const NUMBER = /(?<![A-Za-z0-9])\d+(?:[.,]\d+)*(?![A-Za-z])/g;

/**
 * Provider output {sentences:[{text, claimIds}]}: at most 5 sentences of at most 240 characters, each citing at
 * least one existing claim; every address-like string and number in a sentence must appear in a cited claim's text.
 */
export function validateAiSentences(raw: unknown, report: ReportView): Sentence[] | null {
  if (!plain(raw) || Object.keys(raw).length !== 1) return null;
  const byId = new Map(report.claims.map((c) => [c.id, c.text]));
  const list = sentences(raw.sentences, AI_SENTENCE_MAX, new Set(byId.keys()));
  if (!list) return null;
  for (const s of list) {
    const cited = s.claimIds.map((id) => byId.get(id) ?? "").join("\n");
    const numbers = (s.text.match(NUMBER) ?? []).map((n) => n.replace(/[.,]+$/, ""));
    if (!(s.text.match(B58_LONG) ?? []).every((t) => cited.includes(t))) return null;
    if (!numbers.every((n) => new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.]/g, "\\.")}(?![A-Za-z0-9])`).test(cited))) return null;
    if (/https?:|<|>/i.test(s.text)) return null;
  }
  return list;
}

/** SignGuard's own explanation: the engine's explanation text for the risk claims, else the plain summary. */
export function fallbackExplanation(report: ReportView): Explanation {
  const risks = report.claims.filter((c) => c.level !== null && c.level !== "L0" && !c.rule?.startsWith("fact."));
  const own = risks.slice(0, EXPLAIN_MAX_SENTENCES).map((c) => ({ text: c.text.slice(0, OWN_SENTENCE_MAX), claimIds: [c.id] }));
  if (own.length) return { source: "signguard", sentences: own };
  const facts = report.claims.filter((c) => c.rule?.startsWith("fact.")).map((c) => c.id).slice(0, MAX_CLAIM_REFS);
  return { source: "signguard", sentences: [{ text: (report.summary || report.title || "SignGuard could not describe this request.").slice(0, OWN_SENTENCE_MAX), claimIds: facts }] };
}

/** Public facts only: claim ids and text, capability phrases and the simulation text. No bytes, hashes or keys. */
export function explanationInput(report: ReportView, maxBytes: number): string {
  const claims = report.claims.slice(0, 24).map((c) => ({ id: c.id, level: c.level, statement: c.text.slice(0, 600) }));
  const capabilities = report.capabilities.slice(0, 16).map((c) => `${c.change === "granted" ? "grants" : "revokes"} ${c.authority} (holder ${c.holder})`);
  const simulation = report.simulation ? report.simulation.slice(0, 600) : null;
  for (;;) {
    const text = JSON.stringify({ claims, capabilities, simulation });
    if (new TextEncoder().encode(text).length <= maxBytes || claims.length <= 1) return text;
    claims.pop();
  }
}
