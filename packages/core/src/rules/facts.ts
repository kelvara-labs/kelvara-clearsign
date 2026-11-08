// E23 benign facts: L0 Fact claims for what a harmless transaction actually does (memo text, SOL and token
// transfers, compute budget fee, network fee, "no permission changes"). They run after every risk rule and the
// capability graph, so risk claim ids never move, and they never raise the alert level (all are L0).
// A fact is written only for an instruction the engine fully understands: a named decode on the exact program.
import type { DecodedInstruction } from "../decode/types.js";
import { COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, MEMO_V1_PROGRAM } from "../decode/builtin.js";
import type { Session } from "../ingest/types.js";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../state/layouts.js";
import { lamportsText, tokenText, unsigned } from "../util/amounts.js";
import { accountNamed, instructionEvidence } from "./common.js";
import { arg } from "./squads-session.js";
import { mintAccount, recipient as tokenRecipient, tokenAccount } from "./token-state.js";
import type { RuleContext } from "./types.js";

export const FACT_RULE_IDS = ["fact.unknown_instruction", "fact.memo", "fact.sol_transfer", "fact.token_transfer", "fact.priority_fee", "fact.network_fee", "fact.no_permission_change"] as const;

export const LAMPORTS_PER_SIGNATURE = 5000n;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_TEXT_MAX = 200;

const named = (ix: DecodedInstruction, program: string | readonly string[], names?: readonly string[]): boolean =>
  ix.status === "named" && (typeof program === "string" ? ix.programAddress === program : program.includes(ix.programAddress)) && (!names || names.includes(ix.name ?? ""));

const isMemo = (ix: DecodedInstruction): boolean => named(ix, [MEMO_PROGRAM, MEMO_V1_PROGRAM], ["memo"]) && typeof ix.args?.memo === "string";
const isSolTransfer = (ix: DecodedInstruction): boolean => named(ix, SYSTEM_PROGRAM, ["transferSol"]) && typeof arg(ix, "amount") === "bigint";
const isTokenTransfer = (ix: DecodedInstruction): boolean => named(ix, [TOKEN_PROGRAM, TOKEN_2022_PROGRAM], ["transfer", "transferChecked"]) && typeof arg(ix, "amount") === "bigint";
const BUDGET_NAMES = ["requestHeapFrame", "setComputeUnitLimit", "setComputeUnitPrice", "setLoadedAccountsDataSizeLimit"] as const;
export const isComputeBudget = (ix: DecodedInstruction): boolean => named(ix, COMPUTE_BUDGET_PROGRAM, BUDGET_NAMES);
const isAtaCreate = (ix: DecodedInstruction): boolean => named(ix, ATA_PROGRAM, ["createAssociatedToken", "createAssociatedTokenIdempotent"]);

/** Memo text for a statement: control and line-break characters become spaces, bounded, quoted. */
export function memoText(memo: string): string {
  const flat = memo.replace(/[\p{C}\u2028\u2029]/gu, " ").replace(/"/g, "'");
  const chars = [...flat];
  return chars.length > MEMO_TEXT_MAX ? `"${chars.slice(0, MEMO_TEXT_MAX).join("")}" (first ${MEMO_TEXT_MAX} of ${chars.length} characters)` : `"${flat}"`;
}

export interface TxFeeFacts {
  txIndex: number;
  feePayer: string;
  signatures: number;
  baseFee: bigint;
  computeUnitLimit: number | null;
  /** Micro-lamports per compute unit; null when the transaction sets no unit price. */
  microLamports: bigint | null;
  /** ceil(limit * price / 1e6); 0 with no price; null when a price is set without a limit. */
  maxPriorityFee: bigint | null;
  /** True when the budget instructions are present and unambiguous (no duplicates). */
  hasBudget: boolean;
  budgetIxs: DecodedInstruction[];
  /** SOL sent by the fee payer through System transfers in this transaction. */
  solSentByPayer: bigint;
}

/** Fee facts per transaction, derived only from the message and its named compute budget instructions. */
export function transactionFeeFacts(session: Session, decoded: DecodedInstruction[][]): TxFeeFacts[] {
  return session.transactions.map((tx) => {
    const ixs = decoded[tx.index] ?? [];
    const budgetIxs = ixs.filter(isComputeBudget);
    const byName = (n: string) => budgetIxs.filter((i) => i.name === n);
    const dup = BUDGET_NAMES.some((n) => byName(n).length > 1);
    const limitIx = byName("setComputeUnitLimit")[0], priceIx = byName("setComputeUnitPrice")[0];
    const units = !dup && limitIx ? Number(limitIx.args?.units) : null;
    const price = !dup && priceIx && typeof priceIx.args?.microLamports === "bigint" ? priceIx.args.microLamports : null;
    const feePayer = tx.accounts[0]?.address ?? "";
    const maxPriorityFee = dup ? null : price === null ? 0n : units === null ? null : (BigInt(units) * price + 999_999n) / 1_000_000n;
    let solSentByPayer = 0n;
    for (const ix of ixs) if (isSolTransfer(ix) && accountNamed(ix, "source") === feePayer) solSentByPayer += arg(ix, "amount") as bigint;
    return {
      txIndex: tx.index,
      feePayer,
      signatures: tx.header.numSignerAccounts,
      baseFee: BigInt(tx.header.numSignerAccounts) * LAMPORTS_PER_SIGNATURE,
      computeUnitLimit: units,
      microLamports: price,
      maxPriorityFee,
      hasBudget: budgetIxs.length > 0 && !dup,
      budgetIxs,
      solSentByPayer
    };
  });
}

const sol = (lamports: bigint): string => unsigned(lamportsText(lamports));

export function addBenignFacts(ctx: RuleContext): void {
  const { report, decoded, session, state } = ctx;
  const fees = transactionFeeFacts(session, decoded);
  const allIxEvidence: string[] = [];
  let allBenign = true;
  let anyInstruction = false;

  session.transactions.forEach((tx) => {
    const t = tx.index;
    const ixs = decoded[t] ?? [];
    for (const ix of ixs) {
      anyInstruction = true;
      const understood = isMemo(ix) || isSolTransfer(ix) || isTokenTransfer(ix) || isComputeBudget(ix) || isAtaCreate(ix);
      if (!understood) allBenign = false;
      if (!understood) {
        if (ix.status === "unknown") {
          const ev = instructionEvidence(ctx, t, ix);
          report.addClaim({ kind: "Fact", ruleId: "fact.unknown_instruction", statement: `Transaction ${t}, instruction ${ix.index} calls program ${ix.programAddress}, which ClearSign cannot decode, so what it moves or authorizes is unknown.`, evidenceIds: [ev] });
        }
        continue;
      }
      const ev = instructionEvidence(ctx, t, ix);
      allIxEvidence.push(ev);
      if (isMemo(ix)) {
        report.addClaim({ kind: "Fact", ruleId: "fact.memo", statement: `Transaction ${t} contains a memo that says ${memoText(ix.args!.memo as string)}. A memo is plain text and moves no funds.`, evidenceIds: [ev] });
      } else if (isSolTransfer(ix)) {
        const amount = arg(ix, "amount") as bigint;
        report.addClaim({ kind: "Fact", ruleId: "fact.sol_transfer", statement: `Transaction ${t} sends ${sol(amount)} (${amount} lamports) from ${accountNamed(ix, "source") ?? "an unresolved account"} to ${accountNamed(ix, "destination") ?? "an unresolved account"}.`, evidenceIds: [ev] });
      } else if (isTokenTransfer(ix)) {
        const amount = arg(ix, "amount") as bigint;
        const source = accountNamed(ix, "source"), dest = accountNamed(ix, "destination");
        const checked = typeof arg(ix, "decimals") === "number" || typeof arg(ix, "decimals") === "bigint";
        const mint = accountNamed(ix, "mint") ?? tokenAccount(ctx, source)?.mint ?? tokenRecipient(ctx, t, dest)?.mint ?? null;
        const decimals = checked ? Number(arg(ix, "decimals")) : mint ? mintAccount(ctx, mint)?.decimals ?? null : null;
        const owner = tokenRecipient(ctx, t, dest)?.owner ?? null;
        const amountText = decimals === null ? `${amount} base units (decimals not read)` : `${unsigned(tokenText(amount, decimals))}${mint ? "" : " tokens"}`;
        report.addClaim({
          kind: "Fact",
          ruleId: "fact.token_transfer",
          statement: `Transaction ${t} sends ${amountText}${mint ? ` of token mint ${mint}` : ""} from token account ${source ?? "an unresolved account"} to ${owner ? `${owner} (owner of token account ${dest})` : `token account ${dest ?? "an unresolved account"} (its owner was not read)`}.`,
          evidenceIds: [ev]
        });
      }
    }

    const f = fees[t]!;
    if (f.hasBudget) {
      const parts: string[] = [];
      if (f.computeUnitLimit !== null) parts.push(`a limit of ${f.computeUnitLimit} compute units`);
      if (f.microLamports !== null) parts.push(`a price of ${f.microLamports} micro-lamports per compute unit`);
      for (const ix of f.budgetIxs) {
        if (ix.name === "requestHeapFrame") parts.push(`a heap frame of ${ix.args?.bytes} bytes`);
        if (ix.name === "setLoadedAccountsDataSizeLimit") parts.push(`a loaded accounts data limit of ${ix.args?.bytes} bytes`);
      }
      const effect =
        f.microLamports === null || f.microLamports === 0n ? `${f.microLamports === null ? "No unit price is set" : "The unit price is 0"}, so no priority fee is added.`
        : f.maxPriorityFee === null ? "A unit price is set without a unit limit, so the priority fee depends on the compute unit limit the network applies."
        : `The priority fee is therefore up to ${sol(f.maxPriorityFee)} (${f.maxPriorityFee} lamports, units × price ÷ 1,000,000 rounded up), paid by the fee payer ${f.feePayer} on top of the network fee.`;
      const derived = report.addEvidence({
        type: "derivation",
        source: "engine",
        transactionIndex: t,
        summary: `Priority fee of transaction ${t}: ${f.maxPriorityFee === null ? "not computable" : `${f.maxPriorityFee} lamports`}`,
        data: { feePayer: f.feePayer, computeUnitLimit: f.computeUnitLimit, microLamports: f.microLamports, maxPriorityFeeLamports: f.maxPriorityFee, formula: "ceil(computeUnitLimit * microLamports / 1000000)" }
      });
      report.addClaim({ kind: "Fact", ruleId: "fact.priority_fee", statement: `Transaction ${t} sets ${parts.join(", ")}. ${effect}`, evidenceIds: [...f.budgetIxs.map((ix) => instructionEvidence(ctx, t, ix)), derived] });
    }

    const exact = state.fees?.[t];
    const feeEvidence = report.addEvidence({
      type: "derivation",
      source: "engine",
      transactionIndex: t,
      summary: `Network fee of transaction ${t}`,
      data: { feePayer: f.feePayer, signatures: f.signatures, lamportsPerSignature: LAMPORTS_PER_SIGNATURE, baseFeeLamports: f.baseFee, getFeeForMessageLamports: exact ?? null }
    });
    report.addClaim({
      kind: "Fact",
      ruleId: "fact.network_fee",
      statement: exact !== undefined
        ? `Transaction ${t} pays a network fee of ${sol(exact)} (${exact} lamports, read with getFeeForMessage, priority fee included), paid by the fee payer ${f.feePayer}.`
        : `Transaction ${t} pays a base network fee of ${sol(f.baseFee)} (${f.signatures} signature${f.signatures === 1 ? "" : "s"} × ${LAMPORTS_PER_SIGNATURE} lamports), paid by the fee payer ${f.feePayer}.`,
      evidenceIds: [feeEvidence]
    });
  });

  if (anyInstruction && allBenign && report.listCapabilities().length === 0) {
    const n = allIxEvidence.length;
    report.addClaim({
      kind: "Fact",
      ruleId: "fact.no_permission_change",
      statement: `All ${n} instruction${n === 1 ? "" : "s"} in ${session.transactions.length} transaction${session.transactions.length === 1 ? "" : "s"} are fully decoded (memo, compute budget, SOL and token transfers, token account creation) and none grants or revokes a capability: no authority, delegate, owner or upgrade permission changes.`,
      evidenceIds: allIxEvidence
    });
  }
}
