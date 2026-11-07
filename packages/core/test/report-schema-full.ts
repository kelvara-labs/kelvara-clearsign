// TEST ONLY (E17): the kelvara-report-v1 schema exactly as it was written in full zod before the move to
// zod/mini (packages/core/src/report/schema.ts at 592bda1). zod-mini-differential.test.ts runs both over every
// recorded report and mutant and requires identical accept/reject and parsed output. Never import from src.
import { z } from "zod";
import { ALERT_LEVELS, CAPABILITY_CLASSES, CLAIM_KINDS, ALERT_LEVELS_V1, CAPABILITY_RISK_V1 } from "../src/report/rubrics.js";

export const REPORT_SCHEMA_VERSION = "kelvara-report-v1";

const jsonValue: z.ZodType<import("../src/report/canonical.js").JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)])
);

export const ClaimIdSchema = z.string().regex(/^c[1-9][0-9]*$/);
export const EvidenceIdSchema = z.string().regex(/^e[1-9][0-9]*$/);
export const CapabilityIdSchema = z.string().regex(/^k[1-9][0-9]*$/);
export const PreviewIdSchema = z.string().regex(/^p[1-9][0-9]*$/);
const txIndex = z.number().int().nonnegative();
const address = z.string().min(32).max(44);
const ruleId = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);

export const AlertLevelSchema = z.enum(ALERT_LEVELS);
export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export const CapabilityClassSchema = z.enum(CAPABILITY_CLASSES);

export const EVIDENCE_TYPES = ["message", "instruction", "account", "simulation", "history", "idl", "derivation"] as const;
export const EvidenceSchema = z.strictObject({
  id: EvidenceIdSchema,
  type: z.enum(EVIDENCE_TYPES),
  /** Where it came from: the signed bytes, an RPC read, simulation, Helius history, an IDL file. */
  source: z.enum(["message", "rpc", "simulation", "helius", "idl", "engine"]),
  summary: z.string().min(1),
  transactionIndex: txIndex.nullable(),
  /** Instruction path in the transaction: [top-level index] or [top, inner, ...] (Squads inner message). */
  instructionPath: z.array(z.number().int().nonnegative()).nullable(),
  address: address.nullable(),
  data: jsonValue
});

export const CLAIM_SCOPES = ["session", "transaction", "instruction", "account"] as const;
export const ClaimSchema = z.strictObject({
  id: ClaimIdSchema,
  kind: ClaimKindSchema,
  statement: z.string().min(1),
  evidenceIds: z.array(EvidenceIdSchema),
  dependsOn: z.array(ClaimIdSchema),
  ruleId: ruleId.nullable(),
  assumptions: z.array(z.string().min(1)),
  scope: z.enum(CLAIM_SCOPES),
  transactionIndices: z.array(txIndex),
  /** The alert level this claim reaches under alert-levels-v1. */
  level: AlertLevelSchema
});

export const CapabilitySchema = z.strictObject({
  id: CapabilityIdSchema,
  direction: z.enum(["granted", "revoked"]),
  /** Short machine name, e.g. "program.upgrade", "token.transfer", "multisig.config". */
  capability: z.string().min(1),
  class: CapabilityClassSchema,
  score: z.number().int(),
  /** 1..n within its direction under capability-risk-v1. */
  rank: z.number().int().positive(),
  /** Who gains (granted) or loses (revoked) the power; null when unknown. */
  holder: address.nullable(),
  /** The program, mint, account or multisig the power applies to. */
  target: address.nullable(),
  claimId: ClaimIdSchema
});

export const PreviewEntrySchema = z.strictObject({
  id: PreviewIdSchema,
  authority: address.nullable(),
  programId: address.nullable(),
  /** verified IDL, lower-confidence IDL/keyword map, observed history, or unknown. */
  confidence: z.enum(["verified", "lower", "observed", "unknown"]),
  /** Upgrade authority: "can deploy any code" comes first. */
  deployAnyCode: z.boolean(),
  unlocks: z.array(
    z.strictObject({
      instruction: z.string().min(1),
      discriminator: z.string().regex(/^[0-9a-f]+$/).nullable(),
      changes: z.string(),
      class: CapabilityClassSchema,
      rank: z.number().int().positive()
    })
  ),
  claimId: ClaimIdSchema
});

const levelCounts = z.strictObject({ L0: z.number().int(), L1: z.number().int(), L2: z.number().int(), L3: z.number().int(), L4: z.number().int() });
const kindCounts = z.strictObject({ Fact: z.number().int(), Derived: z.number().int(), Conditional: z.number().int(), Unknown: z.number().int() });

export const ReportSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  engineVersion: z.string(),
  rubrics: z.strictObject({
    alertLevels: z.literal(ALERT_LEVELS_V1.id),
    capabilityRisk: z.literal(CAPABILITY_RISK_V1.id)
  }),
  session: z.strictObject({
    id: z.string().min(1),
    complete: z.boolean(),
    transactions: z.array(
      z.strictObject({
        index: txIndex,
        messageHash: z.string().min(32).max(44),
        version: z.union([z.literal("legacy"), z.literal(0), z.literal(1)]),
        label: z.string().nullable()
      })
    )
  }),
  alert: z.strictObject({
    level: AlertLevelSchema,
    label: z.string(),
    action: z.enum(["pass", "pass_with_notice", "hold", "hold_block_default", "reject"]),
    /** Claims at the report's level, in claim order. Empty only at L0. */
    claimIds: z.array(ClaimIdSchema)
  }),
  /** "What simulation shows" next to "what you actually authorize". */
  simulation: z.strictObject({
    status: z.enum(["ok", "failed", "not_run"]),
    summary: z.string(),
    evidenceIds: z.array(EvidenceIdSchema)
  }),
  claims: z.array(ClaimSchema),
  evidence: z.array(EvidenceSchema),
  capabilities: z.strictObject({ granted: z.array(CapabilitySchema), revoked: z.array(CapabilitySchema) }),
  preview: z.array(PreviewEntrySchema),
  counts: z.strictObject({
    claims: z.number().int(),
    evidence: z.number().int(),
    granted: z.number().int(),
    revoked: z.number().int(),
    preview: z.number().int(),
    byKind: kindCounts,
    byLevel: levelCounts
  }),
  /** "sha256:<hex>" of the canonical JSON of the report without this field. */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type PreviewEntry = z.infer<typeof PreviewEntrySchema>;
export type Report = z.infer<typeof ReportSchema>;
export type EvidenceType = Evidence["type"];
export type ClaimScope = Claim["scope"];

// ---------------------------------------------------------------- differential check (E17)

import { ReportSchema as MiniReportSchema } from "../src/report/schema.js";

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? `#${x}` : x === undefined ? "#undefined" : x));

/** null when full zod and zod/mini agree on `input` (accept/reject, parsed output, issue paths); else the difference. */
export function schemaDifference(input: unknown): string | null {
  return schemaCompare(input).difference;
}

/** Both schemas on `input`: the difference (null when they agree) and whether zod/mini accepts it. */
export function schemaCompare(input: unknown): { difference: string | null; accepted: boolean } {
  const b = MiniReportSchema.safeParse(input);
  return { difference: diff(ReportSchema.safeParse(input), b), accepted: b.success };
}

function diff(a: ReturnType<typeof ReportSchema.safeParse>, b: ReturnType<typeof MiniReportSchema.safeParse>): string | null {
  if (a.success !== b.success) return `full ${a.success ? "accepts" : "rejects"}, mini ${b.success ? "accepts" : "rejects"}: ${show(a.success ? b.error?.issues : a.error.issues)}`;
  if (a.success) return show(a.data) === show(b.data) ? null : "parsed output differs";
  const paths = (issues: { path: PropertyKey[]; code: string }[]) => show(issues.map((i) => [i.path.map(String), i.code]).sort());
  const pa = paths(a.error.issues), pb = paths(b.error!.issues);
  return pa === pb ? null : `issues differ: full ${pa} mini ${pb}`;
}
