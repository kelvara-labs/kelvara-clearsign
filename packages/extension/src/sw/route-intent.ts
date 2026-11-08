import type { IntentContext } from "@kelvara/core/intent-schema";
import { templateIntent, type ReportIntent } from "../intent/selection.js";

/**
 * Trusted aggregator, unreadable routed programs only: drop the "unknown effects" candidates (treated as routine).
 * Other candidates stay as the engine built them; with none left there is no intent question (and no AI call).
 */
export function routedIntent(context: IntentContext): ReportIntent | undefined {
  const rest = context.candidates.filter((c) => c.kind !== "unknown");
  if (!rest.length) return undefined;
  return templateIntent({ ...context, candidates: rest, fallbackId: rest[0]!.id, complex: rest.some((c) => c.kind !== "memo" && c.kind !== "transfer") });
}
