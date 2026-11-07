// @kelvara/core public API. This file is a contract: announce changes to @all before merging.
export const ENGINE_VERSION = "0.1.0";

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
