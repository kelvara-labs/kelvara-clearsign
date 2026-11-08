import { validateIntentContext, type IntentContext } from "@kelvara/core";
export type IntentStatus = "template" | "not-configured" | "selected" | "unavailable" | "invalid";
export interface ReportIntent {
  context: IntentContext;
  selectedId: string;
  reasonIds: string[];
  source: "engine" | "ai";
  status: IntentStatus;
}
export interface Selection { binding: string; candidateId: string; reasonIds: string[] }
export function validSelection(value: unknown, context: IntentContext): Selection | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const x = value as Record<string, unknown>;
  if (Object.keys(x).length !== 3 || !["binding", "candidateId", "reasonIds"].every(k => Object.hasOwn(x, k))) return null;
  if (x.binding !== context.messageHashes.join(":")) return null;
  const chosen = context.candidates.find(c => c.id === x.candidateId);
  const fallback = context.candidates.find(c => c.id === context.fallbackId);
  if (!chosen || !fallback || chosen.priority < fallback.priority) return null;
  if (!Array.isArray(x.reasonIds) || !x.reasonIds.length || x.reasonIds.length > 6 || new Set(x.reasonIds).size !== x.reasonIds.length) return null;
  if (!x.reasonIds.includes(chosen.reasons[0]?.id) || !x.reasonIds.every(id => typeof id === "string" && chosen.reasons.some(r => r.id === id))) return null;
  return x as unknown as Selection;
}
export function templateIntent(context: IntentContext, status: IntentStatus = "template"): ReportIntent {
  const c = context.candidates.find(c => c.id === context.fallbackId)!;
  return { context, selectedId: c.id, reasonIds: c.reasons.map(r => r.id), source: "engine", status };
}
export function validateReportIntent(value: unknown, hashes: readonly string[]): ReportIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const x = value as Record<string, unknown>;
  if (Object.keys(x).length !== 5 || !["context", "selectedId", "reasonIds", "source", "status"].every(k => Object.hasOwn(x, k))) return null;
  const context = validateIntentContext(x.context, hashes);
  if (!context || !["template", "not-configured", "selected", "unavailable", "invalid"].includes(x.status as string)) return null;
  if (x.source !== "engine" && x.source !== "ai") return null;
  if ((x.source === "ai") !== (x.status === "selected")) return null;
  const selection = validSelection({ binding: hashes.join(":"), candidateId: x.selectedId, reasonIds: x.reasonIds }, context);
  if (!selection) return null;
  if (x.source === "engine" && x.selectedId !== context.fallbackId) return null;
  return { context, selectedId: selection.candidateId, reasonIds: selection.reasonIds, source: x.source, status: x.status as IntentStatus };
}
