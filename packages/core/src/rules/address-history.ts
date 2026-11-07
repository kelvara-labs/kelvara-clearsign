// Address poisoning (PLAN.md M2 rule 3d). For every SOL or token transfer the wallet signs, the real
// recipient (owner of a token account) is checked against the wallet's recent history read beforehand
// (readAddressRuleState -> RuleState.history). Exactly one outcome per recipient, worst first:
//   address.poisoning  (Fact L4)  recipient sent the wallet dust, the wallet never sent to it, and it
//                                 shares >= 5 start+end characters (>= 2 per side) with an address the
//                                 wallet really sent to;
//   address.dust_sender (L3)      dust and never sent to, no lookalike found;
//   address.first_send (Fact L1)  never sent to in the window, no dust: notice only.
// "Never sent" must be proven complete for the window (see CounterpartyHistory.complete); when it is
// not, a lookalike or dust finding stays Conditional (never L4) and no first-send notice is given.
import type { DecodedInstruction } from "../decode/types.js";
import type { RpcClient } from "../rpc/client.js";
import { dustReason, lookalike, markMatch, readTransferHistory, type DustReason, type HistoryTransfer, type LookalikeMatch, type ReadHistoryOptions, type WalletHistory } from "../state/history.js";
import { SYSTEM_PROGRAM } from "../state/layouts.js";
import type { Session } from "../ingest/types.js";
import { isToken } from "./authority-transfer.js";
import { accountNamed, instructionEvidence, short } from "./common.js";
import { arg } from "./squads-session.js";
import { recipient as tokenRecipient } from "./token-state.js";
import type { Rule, RuleContext, RuleState } from "./types.js";

export interface RequestTransfer {
  txIndex: number;
  ix: DecodedInstruction;
  kind: "sol" | "token";
  /** Real recipient: SOL destination or owner of the destination token account; null when unresolved. */
  recipient: string | null;
  tokenAccount: string | null;
  amount: bigint;
}

/** SOL and token transfers out of `wallet` in the decoded session (top-level calls). */
export function requestTransfers(ctx: Pick<RuleContext, "decoded" | "state" | "session">, wallet: string): RequestTransfer[] {
  const out: RequestTransfer[] = [];
  ctx.decoded.forEach((ixs, txIndex) => {
    for (const ix of ixs) {
      const amount = arg(ix, "amount");
      if (typeof amount !== "bigint") continue;
      if (ix.programAddress === SYSTEM_PROGRAM && ix.name === "transferSol" && accountNamed(ix, "source") === wallet) {
        const to = accountNamed(ix, "destination");
        if (to && to !== wallet) out.push({ txIndex, ix, kind: "sol", recipient: to, tokenAccount: null, amount });
      } else if (isToken(ix) && ["transfer", "transferChecked"].includes(ix.name ?? "") && accountNamed(ix, "authority") === wallet) {
        const dest = accountNamed(ix, "destination");
        const owner = tokenRecipient(ctx as RuleContext, txIndex, dest)?.owner ?? null;
        if (owner !== wallet) out.push({ txIndex, ix, kind: "token", recipient: owner, tokenAccount: dest, amount });
      }
    }
  });
  return out;
}

/**
 * Reads RuleState.history for the session's transfers out of `state.wallet` (token destinations must be
 * in state.accounts, e.g. from readTokenRuleState). Returns the state unchanged when there is no transfer.
 */
export async function readAddressRuleState(
  rpc: RpcClient,
  session: Session,
  decoded: DecodedInstruction[][],
  state: RuleState,
  opts: Omit<ReadHistoryOptions, "wallet" | "counterparties"> = {}
): Promise<RuleState> {
  const wallet = state.wallet;
  if (!wallet) return state;
  const byRecipient = new Map<string, Set<string>>();
  for (const t of requestTransfers({ session, decoded, state }, wallet)) {
    if (!t.recipient) continue;
    const s = byRecipient.get(t.recipient) ?? new Set<string>();
    if (t.tokenAccount) s.add(t.tokenAccount);
    byRecipient.set(t.recipient, s);
  }
  if (!byRecipient.size) return state;
  const history = await readTransferHistory(rpc, { ...opts, wallet, counterparties: [...byRecipient].map(([address, accs]) => ({ address, tokenAccounts: [...accs] })) });
  return { ...state, history };
}

const fmtTransfer = (t: HistoryTransfer): string =>
  t.kind === "sol" ? `${t.amount} lamports` : `${t.amount} base units of ${t.mint ?? "an unknown mint"}`;

function historyEvidence(ctx: RuleContext, h: WalletHistory, t: HistoryTransfer, what: string): string {
  return ctx.report.addEvidence({
    type: "history",
    source: h.source,
    summary: `${what}: ${t.signature} sends ${fmtTransfer(t)} from ${t.from} to ${t.to}`,
    address: t.from,
    data: {
      signature: t.signature, slot: t.slot, blockTime: t.blockTime, kind: t.kind, from: t.from, to: t.to,
      toAccount: t.toAccount ?? null, mint: t.mint ?? null, amount: t.amount.toString(), decimals: t.decimals ?? null, instructionPath: t.path
    }
  });
}

function windowEvidence(ctx: RuleContext, h: WalletHistory, recipient: string): string {
  const cp = h.counterparties[recipient]!;
  return ctx.report.addEvidence({
    type: "history",
    source: h.source,
    summary: `Wallet history ${h.wallet}: ${h.signatures.length} signatures since ${h.since} (last ${h.days} days, at most ${h.maxSignatures}); ${cp.shared.length} transactions shared with ${recipient}`,
    address: h.wallet,
    data: {
      wallet: h.wallet, now: h.now, since: h.since, days: h.days, maxSignatures: h.maxSignatures, signatures: h.signatures.length, reach: h.reach,
      transactionsRead: h.read.length, transactionsUnread: h.unread.length,
      recipient, searched: cp.searched, recipientSignatures: cp.signatures, shared: cp.shared, complete: cp.complete, problems: [...h.problems, ...cp.problems]
    }
  });
}

export interface RecipientAssessment {
  recipient: string;
  /** "known": the wallet sent to it in the window; "none": nothing to report (unproven, no dust). */
  outcome: "known" | "poisoning" | "dust_sender" | "first_send" | "none";
  /** "Never sent to" holds for the whole window (signature lists complete, shared transactions read). */
  proven: boolean;
  dust: { transfer: HistoryTransfer; reason: DustReason }[];
  lookalike: { of: HistoryTransfer; match: LookalikeMatch } | null;
}

/** The address-rule decision for one recipient, from history alone (no request needed). */
export function assessRecipient(h: WalletHistory, recipient: string): RecipientAssessment {
  const wallet = h.wallet, cp = h.counterparties[recipient];
  const base: RecipientAssessment = { recipient, outcome: "none", proven: false, dust: [], lookalike: null };
  if (!cp || recipient === wallet) return base;
  if (cp.transfers.some((x) => x.from === wallet && x.to === recipient) || h.outgoing.some((x) => x.to === recipient)) return { ...base, outcome: "known" };
  const proven = cp.complete;
  const dust = cp.transfers
    .filter((x) => x.from === recipient && x.to === wallet)
    .map((x) => ({ transfer: x, reason: dustReason(x, h) }))
    .filter((d): d is { transfer: HistoryTransfer; reason: DustReason } => d.reason !== null);
  if (!dust.length) return { ...base, proven, outcome: proven ? "first_send" : "none" };
  let best: RecipientAssessment["lookalike"] = null;
  for (const o of h.outgoing) {
    const m = lookalike(recipient, o.to);
    if (m && (!best || m.prefix + m.suffix > best.match.prefix + best.match.suffix)) best = { of: o, match: m };
  }
  return { recipient, proven, dust, lookalike: best, outcome: best ? "poisoning" : "dust_sender" };
}

export const addressHistoryRule: Rule = {
  id: "address.history",
  ruleIds: ["address.poisoning", "address.dust_sender", "address.first_send"],
  description: "Address poisoning: dust from a lookalike of an address the wallet really sent to (L4), dust sender (L3), first send (L1).",
  run(ctx) {
    const wallet = ctx.state.wallet, h = ctx.state.history;
    if (!wallet || !h || h.wallet !== wallet) return;
    const done = new Set<string>();
    for (const t of requestTransfers(ctx, wallet)) {
      const r = t.recipient;
      if (!r || !h.counterparties[r] || done.has(r)) continue;
      done.add(r);
      const a = assessRecipient(h, r);
      if (a.outcome === "known" || a.outcome === "none") continue;
      const cp = h.counterparties[r]!;
      const req = instructionEvidence(ctx, t.txIndex, t.ix);
      const win = windowEvidence(ctx, h, r);
      const nonce = ctx.claims.get(`nonce:${t.txIndex}`);
      const dependsOn = nonce ? [nonce] : [];
      const assumptions = a.proven ? [] : [`The wallet's sends to ${r} in the last ${h.days} days could not all be read (${cp.problems.join("; ") || "incomplete history"}).`];
      const kind = a.proven ? "Fact" : "Conditional";
      // Newest five dust transfers as evidence; the window evidence carries the full count.
      const dustEv = a.dust.slice(0, 5).map((d) => historyEvidence(ctx, h, d.transfer, `Dust (${d.reason}) sent to the wallet (${a.dust.length} in the window)`));
      if (a.outcome === "poisoning") {
        const { of, match } = a.lookalike!;
        const lines = [`recipient:        ${markMatch(r, match)}`, `you really sent:  ${markMatch(of.to, match)}`];
        const matchEv = ctx.report.addEvidence({
          type: "derivation",
          source: "engine",
          summary: `Lookalike: ${r} shares the first ${match.prefix} and last ${match.suffix} characters with ${of.to}`,
          address: r,
          data: { recipient: r, lookalikeOf: of.to, prefix: match.prefix, suffix: match.suffix, lines, rule: ">=5 shared characters across start and end, >=2 on each side" }
        });
        const real = historyEvidence(ctx, h, of, "Real transfer by the wallet");
        ctx.report.addClaim({
          kind, ruleId: "address.poisoning", level: a.proven ? "L4" : "L3",
          statement: `Poisoned address: ${short(r)} sent you dust and you have never sent to it, but it looks like ${short(of.to)}, an address you really paid.\n${lines.join("\n")}`,
          evidenceIds: [req, ...dustEv, matchEv, real, win], dependsOn, assumptions
        });
      } else if (a.outcome === "dust_sender") {
        ctx.report.addClaim({
          kind, ruleId: "address.dust_sender", level: "L3",
          statement: `${short(r)} sent you dust and you have not sent to it in the last ${h.days} days; dust is how address poisoners seed lookalikes.`,
          evidenceIds: [req, ...dustEv, win], dependsOn, assumptions
        });
      } else {
        ctx.report.addClaim({
          kind: "Fact", ruleId: "address.first_send", level: "L1",
          statement: `First transfer to ${short(r)}: you have not sent to it in the last ${h.days} days.`,
          evidenceIds: [req, win], dependsOn
        });
      }
    }
  }
};
