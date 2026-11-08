// Shared helpers for rules: instruction evidence, signers, durable-nonce detection.
import type { DecodedInstruction } from "../decode/types.js";
import type { SessionTransaction } from "../ingest/types.js";
import { SYSTEM_PROGRAM } from "../state/layouts.js";
import type { RuleContext } from "./types.js";

export const short = (a: string | null | undefined): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "an unresolved address");

/** Account address by IDL name, or null. */
export function accountNamed(ix: DecodedInstruction, name: string): string | null {
  return ix.accounts.find((a) => a.name === name)?.address ?? null;
}

/** Evidence for one decoded instruction: program, name, args, named accounts. Deduped by the ledger. */
export function instructionEvidence(ctx: RuleContext, txIndex: number, ix: DecodedInstruction, path: number[] = [ix.index]): string {
  const programLabel = ix.status !== "named" ? ctx.state.programLabels?.names[ix.programAddress] : undefined;
  const label = ix.status === "named" ? `${ix.programName ?? ix.programAddress}.${ix.name}` : `unknown instruction on ${ix.programAddress}`;
  return ctx.report.addEvidence({
    type: "instruction",
    source: "message",
    summary: `transaction ${txIndex}, instruction ${path.join(".")}: ${label}`,
    transactionIndex: txIndex,
    instructionPath: path,
    address: ix.programAddress,
    data: {
      programId: ix.programAddress,
      program: ix.programName,
      ...(programLabel ? { programLabel, labelSource: ctx.state.programLabels!.source } : {}),
      name: ix.name,
      decoder: ix.decoder,
      args: ix.args,
      accounts: ix.accounts.map((a) => ({ name: a.name, address: a.address, signer: a.signer, writable: a.writable }))
    }
  });
}

/** Addresses that sign this transaction (the message header's signer accounts). */
export function txSigners(tx: SessionTransaction): string[] {
  return tx.accounts.filter((a) => a.signer && a.address).map((a) => a.address!);
}

/**
 * Signers of the given transactions: the keys that take part in an action, so a grant to one of them is
 * not a grant to an outsider. Never the whole session: a signer of an unrelated transaction does not
 * sign the grant, and adding such a transaction must never lower a session's level (monotonicity).
 */
export function signersOf(ctx: RuleContext, txIndices: Iterable<number>): Set<string> {
  const out = new Set<string>();
  for (const i of txIndices) {
    const tx = ctx.session.transactions[i];
    if (tx) for (const s of txSigners(tx)) out.add(s);
  }
  return out;
}

export function isSystemIx(ix: DecodedInstruction | undefined, name: string, tag: number): boolean {
  if (!ix || ix.programAddress !== SYSTEM_PROGRAM) return false;
  if (ix.status === "named") return ix.name === name;
  // Not decodable by name: fall back to the bincode u32 tag the runtime reads.
  const d = ix.data;
  return d.length >= 4 && d[0] === tag && d[1] === 0 && d[2] === 0 && d[3] === 0;
}

/** AdvanceNonceAccount (System tag 4). */
export const isAdvanceNonce = (ix: DecodedInstruction | undefined): boolean => isSystemIx(ix, "advanceNonceAccount", 4);

export interface DurableNonceUse {
  txIndex: number;
  ix: DecodedInstruction;
  /** Nonce account (first account of AdvanceNonceAccount). */
  nonceAccount: string | null;
  /** Nonce authority that signs the advance (third account). */
  authority: string | null;
}

/**
 * The runtime treats a transaction as a durable-nonce transaction when its first instruction is
 * System AdvanceNonceAccount; the recent blockhash is then the nonce value and never expires.
 */
export function durableNonceUse(ctx: RuleContext, txIndex: number): DurableNonceUse | null {
  const first = ctx.decoded[txIndex]?.[0];
  if (!isAdvanceNonce(first)) return null;
  return { txIndex, ix: first!, nonceAccount: first!.accounts[0]?.address ?? null, authority: first!.accounts[2]?.address ?? null };
}
