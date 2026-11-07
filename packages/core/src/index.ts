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

// Account reads are injected; the Helius adapter (createRpcAccountReader) implements AccountReader.
export {
  createFixtureAccountReader,
  createCachingAccountReader,
  type AccountReader,
  type AccountInfo,
  type RecordedAccount
} from "./state/index.js";

// M4 / E13: RPC (Helius or localhost:8899 only; timeouts, backoff with Retry-After, mainnet <= 8 rps,
// per-session cache), state reads (nonce + funder, program data, mints with Token-2022 extensions,
// Squads accounts) and simulateTransaction with balance and authority changes.
export {
  createRpcClient,
  rpcUrlFor,
  networkOfUrl,
  redactUrl,
  parseRetryAfter,
  RpcError,
  ALLOWED_METHODS,
  MAINNET_MAX_RPS,
  DEFAULT_RPS,
  HELIUS_RPC_HOSTS,
  LOCALNET_RPC_URL,
  createRpcAccountReader,
  accountFromRpc,
  getSignaturesForAddress,
  getJsonTransaction,
  type RpcClient,
  type RpcClientOptions,
  type RpcParams,
  type RpcStats,
  type RpcNetwork,
  type RpcErrorCode,
  type RpcAccountReader,
  type RpcAccount,
  type SignatureInfo,
  type RpcJsonTransaction,
  type Commitment
} from "./rpc/index.js";
export {
  decodeNonceAccount,
  decodeLoaderState,
  decodeMint,
  decodeTokenAccount,
  readNonceAccount,
  findOldestSignature,
  findAccountOrigin,
  fundingFromTransaction,
  readProgram,
  readMint,
  readMints,
  readSquadsAccount,
  StateReadError,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_2022_EXTENSION_NAMES,
  NONCE_ACCOUNT_LENGTH,
  PROGRAM_DATA_HEADER_LENGTH,
  type NonceAccount,
  type NonceState,
  type LoaderState,
  type MintInfo,
  type MintState,
  type TokenExtension,
  type TokenAccountInfo,
  type OldestSignature,
  type AccountOrigin,
  type FundingMethod,
  type ProgramState,
  type StateReadErrorCode,
  type SquadsAccountDecoder,
  readTransferHistory,
  transfersOfTransaction,
  dustReason,
  lookalike,
  markMatch,
  HISTORY_DAYS,
  HISTORY_MAX_SIGNATURES,
  DUST_MAX_LAMPORTS,
  DUST_MAX_USD,
  type WalletHistory,
  type HistoryTransfer,
  type CounterpartyHistory,
  type AssetInfo,
  type DustReason,
  type LookalikeMatch,
  type ReadHistoryOptions
} from "./state/index.js";
export {
  simulateTransaction,
  simulateSessionTransaction,
  wireTransactionBytes,
  MAX_SIMULATED_ACCOUNTS,
  type SimulationResult,
  type SimulateOptions,
  type SimulatedInnerInstruction,
  type SolBalanceChange,
  type TokenBalanceChange,
  type StateChange
} from "./simulate/index.js";

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
  type CapabilityRecord,
  type PreviewInput,
  type ReportSessionInput,
  type ValidationResult
} from "./report/index.js";

// M2 / E7: rules (durable nonce, outsider-staged nonce, Squads approve/execute, threshold, time lock,
// unknown proposal, config changes). Rules are synchronous; read state first and pass it as RuleState.
export {
  readTokenRuleState,
  readAddressRuleState,
  requestTransfers,
  assessRecipient,
  type RequestTransfer,
  type RecipientAssessment,
  runRules,
  RULES,
  RULE_IDS,
  ALL_RULE_IDS,
  describeConfigAction,
  proposalViews,
  vaultInstructions,
  durableNonceUse,
  type RunRulesInput,
  type Rule,
  type RuleContext,
  type RuleState,
  type NonceFacts,
  type ProposalView,
  type MultisigView,
  type DurableNonceUse
} from "./rules/index.js";

// M2 / E11: capability graph. Authority maps from IDLs, capability preview (map, then simulate-and-diff
// and old-authority history as Conditional, else Unknown) and recovery paths through the upgrade
// authority. runRules runs it after the rules; pass `authorityMaps` and RuleState.programs/simulations/
// authorityHistory to feed it.
export {
  buildAuthorityMap,
  classifyInstruction,
  describeInstruction,
  addCapabilityPreviews,
  addRecoveryPaths,
  runCapabilityGraph,
  capabilityProgram,
  GRAPH_RULE_IDS,
  PREVIEW_RULE_ID,
  RECOVERY_RULE_ID,
  TOKEN_TAGS,
  type AuthorityMap,
  type AuthorityMapEntry,
  type AuthorityTie,
  type AuthorityTieKind,
  type BuildAuthorityMapOptions,
  type CapabilityGraphOptions
} from "./graph/index.js";
export { readAuthorityHistory, authorityCallsOfTransaction, type AuthorityHistory, type AuthorityCall, type ReadAuthorityHistoryOptions } from "./state/authority-history.js";

// M4 / E14: one-call analysis (state reads, simulation, rules, capability graph, "what simulation shows").
// Online with an RpcClient (Helius or localnet); offline without one. Used by the CLI and the extension.
export { analyzeSession, addSimulationSummary, squadsTransactionPda, type AnalyzeOptions, type AnalyzeResult, type ReadNote } from "./analyze/index.js";
