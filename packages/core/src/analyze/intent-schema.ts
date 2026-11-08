/** Intent context schema and validator only: safe for page-side bundles (no engine, RPC or Solana libs). */
import * as z from "zod/mini";
import { lookalike } from "../util/lookalike.js";

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const id = text(80);
const reasonSchema = z.strictObject({ id, text: text(600), claimIds: z.array(id).check(z.maxLength(64)), evidenceIds: z.array(id).check(z.maxLength(64)) });
const candidateSchema = z.strictObject({
  id, kind: z.enum(["transfer", "authority", "fees", "token-risk", "poisoning", "memo", "swap", "unknown"]),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  question: text(300), reasons: z.array(reasonSchema).check(z.minLength(1), z.maxLength(6)),
  comparison: z.nullable(z.strictObject({ proposed: text(44), previous: text(44), prefix: z.int().check(z.nonnegative()), suffix: z.int().check(z.nonnegative()) }))
});
const contextSchema = z.strictObject({ version: z.literal("kelvara-intent-v1"), messageHashes: z.array(text(44)).check(z.maxLength(64)), complex: z.boolean(), fallbackId: id, historyNote: text(600), candidates: z.array(candidateSchema).check(z.minLength(1), z.maxLength(8)) });
export type IntentReason = z.infer<typeof reasonSchema>;
export type IntentCandidate = z.infer<typeof candidateSchema>;
export type IntentContext = z.infer<typeof contextSchema>;

export function validateIntentContext(value: unknown, expectedHashes: readonly string[]): IntentContext | null {
  const parsed = z.safeParse(contextSchema, value);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.messageHashes.length !== expectedHashes.length || c.messageHashes.some((h, i) => h !== expectedHashes[i] || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h))) return null;
  const ids = new Set<string>(), reasons = new Set<string>();
  for (const candidate of c.candidates) {
    if (ids.has(candidate.id)) return null;
    ids.add(candidate.id);
    for (const r of candidate.reasons) {
      if (reasons.has(r.id) || new Set(r.claimIds).size !== r.claimIds.length || new Set(r.evidenceIds).size !== r.evidenceIds.length) return null;
      if (r.claimIds.some((x) => !/^c[1-9][0-9]*$/.test(x)) || r.evidenceIds.some((x) => !/^e[1-9][0-9]*$/.test(x))) return null;
      reasons.add(r.id);
    }
    if (candidate.comparison) {
      if (![candidate.comparison.proposed, candidate.comparison.previous].every((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))) return null;
      const m = lookalike(candidate.comparison.proposed, candidate.comparison.previous);
      if (candidate.kind !== "poisoning" || !m || m.prefix !== candidate.comparison.prefix || m.suffix !== candidate.comparison.suffix) return null;
    }
  }
  const fallback = c.candidates.find((x) => x.id === c.fallbackId);
  if (!fallback || c.candidates.some((x) => x.priority > fallback.priority)) return null;
  if (!c.complex && c.candidates.some((x) => x.kind !== "transfer" && x.kind !== "memo")) return null;
  return c;
}
