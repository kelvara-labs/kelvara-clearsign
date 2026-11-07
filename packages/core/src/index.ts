// @kelvara/core public API. This file is a contract: announce changes to @all before merging.
export const ENGINE_VERSION = "0.1.0";

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
