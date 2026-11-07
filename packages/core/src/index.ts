// @kelvara/core public API. This file is a contract: announce changes to @all before merging.
export { ENGINE_VERSION } from "./version.js";

export { createSquadsDecoder, decodeSquadsMessage, SQUADS_V4_PROGRAM, type SquadsMessage, type SquadsAccount } from "./decode/squads.js";

// M1 / E1: ingest (parse legacy, v0 and v1 messages; resolve lookup tables; sessions).
export {
  ingestSession,
  parseTransaction,
  parseLookupTableData,
  IngestError,
  MAX_INPUT_BYTES,
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  type IngestOptions,
  type IngestErrorCode,
  type IngestInput,
  type MessageVersion,
  type MessageHeader,
  type AddressTableLookup,
  type CompiledInstruction,
  type SignatureSlot,
  type V1Config,
  type ParsedTransaction,
  type AccountSource,
  type ResolvedAccount,
  type ResolvedInstruction,
  type LookupProblem,
  type LookupTableInfo,
  type SessionTransaction,
  type Session
} from "./ingest/index.js";

// Account reads are injected; the Helius adapter implements AccountReader in M4.
export {
  createFixtureAccountReader,
  createCachingAccountReader,
  type AccountReader,
  type AccountInfo,
  type RecordedAccount
} from "./state/index.js";

// M1 / E2: decode (Codama parseInstruction first, built-in Anchor decoder as fallback; Unknown is never safe).
// M1 / E4: hand-written decoders for the upgradeable loader and Memo (decoder: "builtin").
export {
  createDecoder,
  createAnchorFallbackDecoder,
  anchorInstructionDiscriminator,
  decodeUpgradeableLoaderInstruction,
  decodeMemoInstruction,
  BUILTIN_PROGRAMS,
  UPGRADEABLE_LOADER_PROGRAM,
  UPGRADEABLE_LOADER_INSTRUCTIONS,
  MEMO_PROGRAM,
  MEMO_V1_PROGRAM,
  type Decoder,
  type DecoderOptions,
  type BuiltinDecoded,
  type BuiltinProgram,
  type AnchorFallbackDecoder,
  type AnchorDecoded,
  type ProgramEntry,
  type AnchorIdlJson,
  type DecodedInstruction,
  type DecodedAccount,
  type DecodeStatus
} from "./decode/index.js";

// M2 / E6: report contract (evidence ledger, claim builder, zod schema, canonical JSON, sha256 digest).
// Rubrics alert-levels-v1 and capability-risk-v1 are part of the contract.
export {
  ReportBuilder,
  EvidenceLedger,
  ReportError,
  reportSessionFrom,
  validateReport,
  reportDigest,
  compareCapabilities,
  canonicalJson,
  canonicalDigest,
  toJsonValue,
  CanonicalJsonError,
  ReportSchema,
  ClaimSchema,
  EvidenceSchema,
  CapabilitySchema,
  PreviewEntrySchema,
  REPORT_SCHEMA_VERSION,
  EVIDENCE_TYPES,
  CLAIM_SCOPES,
  ALERT_LEVELS,
  ALERT_LEVELS_V1,
  CLAIM_KINDS,
  CAPABILITY_RISK_V1,
  CAPABILITY_CLASSES,
  capabilityScore,
  levelAllowed,
  levelValue,
  maxLevel,
  type Report,
  type Claim,
  type ClaimKind,
  type ClaimScope,
  type Evidence,
  type EvidenceType,
  type Capability,
  type CapabilityClass,
  type PreviewEntry,
  type AlertLevel,
  type AlertAction,
  type JsonValue,
  type EvidenceInput,
  type ClaimInput,
  type CapabilityInput,
  type PreviewInput,
  type ReportSessionInput,
  type ValidationResult
} from "./report/index.js";
