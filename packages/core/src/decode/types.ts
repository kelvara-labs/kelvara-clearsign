import type { Address } from "@solana/kit";
import type { RootNode } from "@codama/nodes";

/** Anchor IDL as JSON (legacy v0.0.0 or the 0.1.0 spec). Only the fields the fallback decoder reads are typed. */
export interface AnchorIdlJson {
  address?: string;
  metadata?: { spec?: string; name?: string; address?: string };
  name?: string;
  instructions: AnchorIdlInstruction[];
  types?: AnchorIdlTypeDef[];
}
export interface AnchorIdlInstruction {
  name: string;
  discriminator?: number[];
  accounts: AnchorIdlAccountItem[];
  args: { name: string; type: AnchorIdlType }[];
}
export type AnchorIdlAccountItem = { name: string; accounts?: AnchorIdlAccountItem[] } & Record<string, unknown>;
export type AnchorIdlType = string | Record<string, unknown>;
export interface AnchorIdlTypeDef {
  name: string;
  type: { kind: "struct" | "enum" | "type"; fields?: unknown[]; variants?: { name: string; fields?: unknown[] }[]; alias?: AnchorIdlType };
}

/**
 * One program the decoder knows. The Codama root is tried first; the Anchor IDL, when given,
 * feeds the built-in fallback decoder for programs (or single instructions) Codama cannot handle.
 */
export interface ProgramEntry {
  name: string;
  programId: string;
  root?: RootNode;
  idl?: AnchorIdlJson;
}

export interface DecodedAccount {
  /** Name from the IDL, or null for accounts past the named list (remaining accounts) or an unknown instruction. */
  name: string | null;
  /** Position in the instruction's account list. */
  position: number;
  /** null when its lookup table could not be resolved (fail closed downstream). */
  address: Address | null;
  signer: boolean;
  writable: boolean;
}

export type DecodeStatus = "named" | "unknown";

export interface DecodedInstruction {
  /** Index of the instruction in its transaction. */
  index: number;
  programAddress: Address;
  /** Registry name of the program, or null when the program is not in the registry. */
  programName: string | null;
  status: DecodeStatus;
  /** Which path produced the result. "none" for unknown. */
  decoder: "codama" | "anchor-fallback" | "none";
  /** camelCase instruction name; null when unknown. */
  name: string | null;
  /** Decoded arguments (u64 and wider as bigint). null when unknown. */
  args: Record<string, unknown> | null;
  accounts: DecodedAccount[];
  /** Why the instruction is unknown. Unknown never means safe. */
  reason?: "program_not_in_registry" | "no_matching_instruction" | "args_did_not_decode" | "decoder_error";
  data: Uint8Array;
}
