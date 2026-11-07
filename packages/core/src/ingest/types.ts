import type { Address } from "@solana/kit";

export type MessageVersion = "legacy" | 0 | 1;

/** One transaction as handed to the engine. */
export interface IngestInput {
  /** Raw bytes, or base64 text, of a wire transaction or a bare message. */
  bytes?: Uint8Array;
  base64?: string;
  /** "auto" (default) detects a wire transaction versus a bare message. */
  kind?: "auto" | "wire" | "message";
  /** Free-form label from the caller (wallet method, dApp hint). Never trusted. */
  label?: string;
}

export interface MessageHeader {
  numSignerAccounts: number;
  numReadonlySignerAccounts: number;
  numReadonlyNonSignerAccounts: number;
}

export interface AddressTableLookup {
  lookupTableAddress: Address;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface CompiledInstruction {
  programIdIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}

export interface SignatureSlot {
  signer: Address;
  /** base58; null when the slot is empty (all zero bytes) or the input was a bare message. */
  signature: string | null;
}

/** v1 transaction config values (SIMD-0385 style compute budget in the message). */
export interface V1Config {
  priorityFeeLamports?: bigint;
  computeUnitLimit?: number;
  loadedAccountsDataSizeLimit?: number;
  heapSize?: number;
}

/** Result of parsing bytes, before lookup tables are resolved. */
export interface ParsedTransaction {
  version: MessageVersion;
  envelope: "wire" | "message";
  /** The exact message bytes the signers sign. */
  messageBytes: Uint8Array;
  /** sha256(messageBytes), base58. Matches what a Ledger shows as the message hash. */
  messageHash: string;
  header: MessageHeader;
  staticAccounts: Address[];
  /** Recent blockhash or, for a durable-nonce transaction, the nonce value. */
  lifetimeToken: string;
  signatures: SignatureSlot[];
  addressTableLookups: AddressTableLookup[];
  instructions: CompiledInstruction[];
  v1Config?: V1Config;
}

export type AccountSource =
  | { kind: "static" }
  | { kind: "lookup"; table: Address; tableIndex: number };

export interface ResolvedAccount {
  /** Position in the full account key list (static, then loaded writable, then loaded readonly). */
  index: number;
  /** null only when its lookup table could not be resolved. */
  address: Address | null;
  signer: boolean;
  /** Writable as requested by the message. The runtime may still demote it. */
  writable: boolean;
  source: AccountSource;
}

export interface ResolvedInstruction {
  /** Position of this instruction in its transaction. */
  index: number;
  programIdIndex: number;
  programAddress: Address;
  accounts: ResolvedAccount[];
  data: Uint8Array;
}

export type LookupProblem =
  | { kind: "table_missing"; table: Address }
  | { kind: "not_a_lookup_table"; table: Address; owner: Address }
  | { kind: "malformed_table"; table: Address }
  | { kind: "index_out_of_range"; table: Address; tableIndex: number; tableSize: number }
  | { kind: "table_deactivated"; table: Address; deactivationSlot: bigint };

export interface SessionTransaction extends Omit<ParsedTransaction, "instructions"> {
  /** Stable index of this transaction in its session (input order). */
  index: number;
  label?: string;
  compiledInstructions: CompiledInstruction[];
  accounts: ResolvedAccount[];
  instructions: ResolvedInstruction[];
  lookupProblems: LookupProblem[];
  /** True when every account address is known. */
  complete: boolean;
}

export interface LookupTableInfo {
  address: Address;
  authority: Address | null;
  deactivationSlot: bigint;
  lastExtendedSlot: bigint;
  addresses: Address[];
}

export interface Session {
  /** sha256 over the ordered message hashes, base58. Same transactions in the same order give the same id. */
  id: string;
  transactions: SessionTransaction[];
  /** Lookup tables read for this session, by address. */
  lookupTables: Record<string, LookupTableInfo>;
  complete: boolean;
}
