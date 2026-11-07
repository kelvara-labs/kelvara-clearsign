// Report zod schema: the engine's public contract (alongside src/index.ts).
// Announce any change to @all. Bump REPORT_SCHEMA_VERSION on any breaking change.
// Written with zod/mini (same zod package, tree-shakable functional checks) since E17: the full zod
// classic API cost the extension's service worker ~435 KB minified. Accepted/rejected inputs and parsed
// output are unchanged; test/zod-mini-differential.test.ts runs the old full-zod schema
// (test/report-schema-full.ts) next to this one over every recorded report and mutant.
import * as z from "zod/mini";
import { ALERT_LEVELS, CAPABILITY_CLASSES, CLAIM_KINDS, ALERT_LEVELS_V1, CAPABILITY_RISK_V1 } from "./rubrics.js";

export const REPORT_SCHEMA_VERSION = "kelvara-report-v1";

// z.number() rejects NaN and infinities in zod 4 (full zod's .finite() was a no-op).
const jsonValue: z.ZodMiniType<import("./canonical.js").JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)])
);

export const ClaimIdSchema = z.string().check(z.regex(/^c[1-9][0-9]*$/));
export const EvidenceIdSchema = z.string().check(z.regex(/^e[1-9][0-9]*$/));
export const CapabilityIdSchema = z.string().check(z.regex(/^k[1-9][0-9]*$/));
export const PreviewIdSchema = z.string().check(z.regex(/^p[1-9][0-9]*$/));
const txIndex = z.int().check(z.nonnegative());
const address = z.string().check(z.minLength(32), z.maxLength(44));
const ruleId = z.string().check(z.regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/));

export const AlertLevelSchema = z.enum(ALERT_LEVELS);
export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export const CapabilityClassSchema = z.enum(CAPABILITY_CLASSES);

export const EVIDENCE_TYPES = ["message", "instruction", "account", "simulation", "history", "idl", "derivation"] as const;
export const EvidenceSchema = z.strictObject({
  id: EvidenceIdSchema,
  type: z.enum(EVIDENCE_TYPES),
  /** Where it came from: the signed bytes, an RPC read, simulation, Helius history, an IDL file. */
  source: z.enum(["message", "rpc", "simulation", "helius", "idl", "engine"]),
  summary: z.string().check(z.minLength(1)),
  transactionIndex: z.nullable(txIndex),
  /** Instruction path in the transaction: [top-level index] or [top, inner, ...] (Squads inner message). */
  instructionPath: z.nullable(z.array(z.int().check(z.nonnegative()))),
  address: z.nullable(address),
  data: jsonValue
});

export const CLAIM_SCOPES = ["session", "transaction", "instruction", "account"] as const;
export const ClaimSchema = z.strictObject({
  id: ClaimIdSchema,
  kind: ClaimKindSchema,
  statement: z.string().check(z.minLength(1)),
  evidenceIds: z.array(EvidenceIdSchema),
  dependsOn: z.array(ClaimIdSchema),
  ruleId: z.nullable(ruleId),
  assumptions: z.array(z.string().check(z.minLength(1))),
  scope: z.enum(CLAIM_SCOPES),
  transactionIndices: z.array(txIndex),
  /** The alert level this claim reaches under alert-levels-v1. */
  level: AlertLevelSchema
});

export const CapabilitySchema = z.strictObject({
  id: CapabilityIdSchema,
  direction: z.enum(["granted", "revoked"]),
  /** Short machine name, e.g. "program.upgrade", "token.transfer", "multisig.config". */
  capability: z.string().check(z.minLength(1)),
  class: CapabilityClassSchema,
  score: z.int(),
  /** 1..n within its direction under capability-risk-v1. */
  rank: z.int().check(z.positive()),
  /** Who gains (granted) or loses (revoked) the power; null when unknown. */
  holder: z.nullable(address),
  /** The program, mint, account or multisig the power applies to. */
  target: z.nullable(address),
  claimId: ClaimIdSchema
});

export const PreviewEntrySchema = z.strictObject({
  id: PreviewIdSchema,
  authority: z.nullable(address),
  programId: z.nullable(address),
  /** verified IDL, lower-confidence IDL/keyword map, observed history, or unknown. */
  confidence: z.enum(["verified", "lower", "observed", "unknown"]),
  /** Upgrade authority: "can deploy any code" comes first. */
  deployAnyCode: z.boolean(),
  unlocks: z.array(
    z.strictObject({
      instruction: z.string().check(z.minLength(1)),
      discriminator: z.nullable(z.string().check(z.regex(/^[0-9a-f]+$/))),
      changes: z.string(),
      class: CapabilityClassSchema,
      rank: z.int().check(z.positive())
    })
  ),
  claimId: ClaimIdSchema
});

const levelCounts = z.strictObject({ L0: z.int(), L1: z.int(), L2: z.int(), L3: z.int(), L4: z.int() });
const kindCounts = z.strictObject({ Fact: z.int(), Derived: z.int(), Conditional: z.int(), Unknown: z.int() });

export const ReportSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  engineVersion: z.string(),
  rubrics: z.strictObject({
    alertLevels: z.literal(ALERT_LEVELS_V1.id),
    capabilityRisk: z.literal(CAPABILITY_RISK_V1.id)
  }),
  session: z.strictObject({
    id: z.string().check(z.minLength(1)),
    complete: z.boolean(),
    transactions: z.array(
      z.strictObject({
        index: txIndex,
        messageHash: z.string().check(z.minLength(32), z.maxLength(44)),
        version: z.union([z.literal("legacy"), z.literal(0), z.literal(1)]),
        label: z.nullable(z.string())
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
    claims: z.int(),
    evidence: z.int(),
    granted: z.int(),
    revoked: z.int(),
    preview: z.int(),
    byKind: kindCounts,
    byLevel: levelCounts
  }),
  /** "sha256:<hex>" of the canonical JSON of the report without this field. */
  digest: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/))
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type PreviewEntry = z.infer<typeof PreviewEntrySchema>;
export type Report = z.infer<typeof ReportSchema>;
export type EvidenceType = Evidence["type"];
export type ClaimScope = Claim["scope"];
