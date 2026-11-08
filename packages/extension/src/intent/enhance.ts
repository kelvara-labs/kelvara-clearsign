import type { WorkerVerdict } from "../shared/protocol.js";
import { AI_STORAGE_KEY, type Permissions } from "./provider.js";
import { AI_TIMEOUT_MS, selectIntent } from "./client.js";
import { templateIntent, validateReportIntent } from "./selection.js";
export interface EnhanceDeps {
  get(keys: string[]): Promise<Record<string, unknown>>;
  fetch: typeof fetch;
  permissions: Pick<Permissions, "contains">;
  timeoutMs?: number;
}
/** An optional presentation enhancement. Never recompute or accept provider decisions. */
export async function enhanceIntent(verdict: WorkerVerdict, deps: EnhanceDeps): Promise<WorkerVerdict> {
  const report = verdict.report;
  if (!report?.intent) return verdict;
  const intent = validateReportIntent(report.intent, report.messageHashes);
  if (!intent) return verdict;
  try {
    const raw = await deps.get([AI_STORAGE_KEY]);
    const selected = await selectIntent(intent.context, raw[AI_STORAGE_KEY], { fetch: deps.fetch, permissions: deps.permissions, timeoutMs: deps.timeoutMs ?? AI_TIMEOUT_MS });
    return { ...verdict, report: { ...report, intent: selected } };
  } catch { return { ...verdict, report: { ...report, intent: templateIntent(intent.context, "unavailable") } }; }
}
