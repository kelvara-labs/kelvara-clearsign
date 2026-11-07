// Shared facts for the E10 session rules: which granted powers leave the session's own keys, and
// which accounts tie one transaction to another (static analysis of the messages only; the
// extension simulates one transaction at a time, so dependencies are found here, not by chaining).
import { SQUADS_V4_PROGRAM } from "../decode/squads.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { CapabilityRecord } from "../report/builder.js";
import { SYSTEM_PROGRAM } from "../state/layouts.js";
import { signersOf, short } from "./common.js";
import type { RuleContext } from "./types.js";

export interface OutsideGrant {
  cap: CapabilityRecord;
  /** Transactions of the claim that grants it. */
  txs: number[];
  /** Granted by instructions inside a Squads proposal (takes effect only when it executes). */
  proposed: boolean;
}

/** Granted capabilities whose holder signs none of the granting claim's transactions, as the rules so far recorded them. */
export function outsideGrants(ctx: RuleContext): OutsideGrant[] {
  const out: OutsideGrant[] = [];
  for (const cap of ctx.report.listCapabilities()) {
    if (cap.direction !== "granted" || !cap.holder) continue;
    const claim = ctx.report.getClaim(cap.claimId);
    if (!claim || signersOf(ctx, claim.transactionIndices).has(cap.holder)) continue;
    // Proposed content is evidenced by an instruction path below a Squads call (two levels deep).
    const proposed = claim.evidenceIds.some((e) => {
      const ev = ctx.report.evidence.get(e);
      return ev?.type === "instruction" && (ev.instructionPath?.length ?? 0) > 1;
    });
    out.push({ cap, txs: [...claim.transactionIndices], proposed });
  }
  return out;
}

export const grantText = (g: OutsideGrant): string =>
  `${g.proposed ? "a proposal that, once executed, gives " : ""}${g.cap.capability} over ${g.cap.target ?? "an unresolved account"} to ${g.cap.holder}`;

/**
 * Instructions that create an account and fail if it already exists, with the created account's
 * IDL name. Idempotent creations (associated token accounts) are left out: they may find it there.
 */
const CREATES: Record<string, Record<string, string>> = {
  [SYSTEM_PROGRAM]: { createAccount: "newAccount", createAccountWithSeed: "newAccount" },
  [SQUADS_V4_PROGRAM]: {
    multisigCreate: "multisig",
    multisigCreateV2: "multisig",
    vaultTransactionCreate: "transaction",
    configTransactionCreate: "transaction",
    batchCreate: "batch",
    proposalCreate: "proposal"
  }
};

export function createdBy(ix: DecodedInstruction): string | null {
  if (ix.status !== "named" || !ix.name) return null;
  const name = CREATES[ix.programAddress]?.[ix.name];
  return name ? (ix.accounts.find((a) => a.name === name)?.address ?? null) : null;
}

export interface SharedAccount {
  address: string;
  /** Instruction of the writing transaction that creates it, if one does. */
  createdBy: DecodedInstruction | null;
  /** Instructions of the writing transaction that take it writable. */
  writers: DecodedInstruction[];
  /** Instructions of the using transaction that name it. */
  users: DecodedInstruction[];
}

/**
 * Accounts that transaction `writer` writes and transaction `user` names. A signer of the writing
 * transaction (a fee payer, a member paying rent) only counts when the writer creates it, so a
 * wallet that signs every transaction does not tie them together by itself.
 */
export function sharedAccounts(ctx: RuleContext, writer: number, user: number): SharedAccount[] {
  const w = ctx.session.transactions[writer]!;
  const u = ctx.session.transactions[user]!;
  const signers = new Set(w.accounts.filter((a) => a.signer && a.address).map((a) => a.address!));
  const created = new Map<string, DecodedInstruction>();
  for (const ix of ctx.decoded[writer] ?? []) {
    const a = createdBy(ix);
    if (a && !created.has(a)) created.set(a, ix);
  }
  const used = new Set(u.accounts.map((a) => a.address).filter((a): a is NonNullable<typeof a> => !!a));
  const out: SharedAccount[] = [];
  for (const acc of w.accounts) {
    if (!acc.writable || !acc.address || !used.has(acc.address)) continue;
    if (signers.has(acc.address) && !created.has(acc.address)) continue;
    const address = acc.address;
    const writers = (ctx.decoded[writer] ?? []).filter((ix) => ix.accounts.some((a) => a.address === address && a.writable));
    const users = (ctx.decoded[user] ?? []).filter((ix) => ix.accounts.some((a) => a.address === address));
    // Taken writable by the message but by no instruction: nothing in the transaction changes it.
    if (!writers.length) continue;
    out.push({ address, createdBy: created.get(address) ?? null, writers, users });
  }
  return out;
}

export const sharedText = (s: SharedAccount): string =>
  `${short(s.address)}${s.createdBy ? ` (created by its ${s.createdBy.name})` : ""}`;
