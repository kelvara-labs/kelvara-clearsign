// Old-authority history for the capability preview fallback (PLAN.md: "Read the program's recent
// history over Helius and list the instructions that the old authority actually signed"). The result
// is an observed list, so the preview built from it is Conditional, never Fact.
import type { RpcClient } from "../rpc/client.js";
import { getJsonTransaction, getSignaturesForAddress, type RpcJsonTransaction } from "../rpc/methods.js";
import { fromBase58 } from "../util/encoding.js";

export interface AuthorityCall {
  signature: string;
  slot: number;
  /** Top-level index, or [top, inner position] for a call made through CPI (e.g. a Squads vault). */
  path: number[];
  /** true: the authority signed the transaction; false: it is only in the CPI's accounts (signer status not shown by RPC). */
  topLevelSigner: boolean;
  /** Instruction data (base58 in RPC); bytes here. */
  data: Uint8Array;
  accounts: string[];
}

export interface AuthorityHistory {
  authority: string;
  programId: string;
  /** Signatures read for the authority (newest first). */
  signaturesRead: number;
  /** Transactions fetched and searched. */
  transactionsRead: number;
  /** True when the authority's whole signature list was read and searched (no cap reached). */
  complete: boolean;
  calls: AuthorityCall[];
}

export interface ReadAuthorityHistoryOptions {
  authority: string;
  programId: string;
  /** Signatures to list (default 100). */
  limit?: number;
  /** Successful transactions to fetch (default 50). */
  maxTransactions?: number;
}

type JsonTx = RpcJsonTransaction & { transaction: { message: { header?: { numRequiredSignatures: number } } } };

/** Calls to `programId` in one transaction made by `authority` (pure; exported for tests). */
export function authorityCallsOfTransaction(tx: JsonTx, signature: string, authority: string, programId: string): AuthorityCall[] {
  const msg = tx.transaction.message;
  const keys = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const signers = new Set(msg.accountKeys.slice(0, msg.header?.numRequiredSignatures ?? 0));
  const out: AuthorityCall[] = [];
  const signed = signers.has(authority);
  const add = (ix: { programIdIndex: number; accounts: number[]; data: string }, path: number[], top: boolean) => {
    if (keys[ix.programIdIndex] !== programId) return;
    const accounts = ix.accounts.map((i) => keys[i] ?? "");
    if (!accounts.includes(authority)) return;
    if (top && !signed) return;
    out.push({ signature, slot: tx.slot, path, topLevelSigner: top, data: fromBase58(ix.data), accounts });
  };
  msg.instructions.forEach((ix, i) => add(ix, [i], true));
  for (const inner of tx.meta?.innerInstructions ?? []) inner.instructions.forEach((ix, j) => add(ix, [inner.index, j], false));
  return out;
}

export async function readAuthorityHistory(rpc: RpcClient, opts: ReadAuthorityHistoryOptions): Promise<AuthorityHistory> {
  const limit = opts.limit ?? 100;
  const maxTx = opts.maxTransactions ?? 50;
  const sigs = await getSignaturesForAddress(rpc, opts.authority, { limit });
  const ok = sigs.filter((s) => s.err === null);
  const calls: AuthorityCall[] = [];
  let read = 0;
  for (const s of ok.slice(0, maxTx)) {
    const tx = (await getJsonTransaction(rpc, s.signature)) as JsonTx | null;
    read++;
    if (!tx || tx.meta?.err) continue;
    calls.push(...authorityCallsOfTransaction(tx, s.signature, opts.authority, opts.programId));
  }
  return { authority: opts.authority, programId: opts.programId, signaturesRead: sigs.length, transactionsRead: read, complete: sigs.length < limit && ok.length <= maxTx, calls };
}
