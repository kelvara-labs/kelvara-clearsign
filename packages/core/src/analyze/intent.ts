/** Additive intent selection facts. Never changes the report or authorizes a transaction. */
import type { DecodedInstruction } from "../decode/types.js";
import type { Decoder } from "../decode/decoder.js";
import type { Session } from "../ingest/types.js";
import type { Report } from "../report/schema.js";
import { ReportBuilder } from "../report/builder.js";
import type { RuleContext, RuleState } from "../rules/types.js";
import { requestTransfers } from "../rules/address-history.js";
import { proposalViews, vaultInstructions, arg } from "../rules/squads-session.js";
import { accountNamed, instructionEvidence } from "../rules/common.js";
import { isComputeBudget } from "../rules/facts.js";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../state/layouts.js";
import { SQUADS_V4_PROGRAM } from "../decode/squads.js";
import { MEMO_PROGRAM, MEMO_V1_PROGRAM } from "../decode/builtin.js";
import { lamportsText, unsigned } from "../util/amounts.js";
import type { IntentCandidate, IntentContext } from "./intent-schema.js";
export { validateIntentContext, type IntentContext, type IntentCandidate, type IntentReason } from "./intent-schema.js";

/** Keep the already-fetched proposal snapshot reachable through a factual decoded-fee claim.
 * This is internal analysis integration, not an extra RPC read or a new rule/risk rating.
 */
export function addIntentSourceEvidence(ctx: RuleContext): void {
  if (!ctx.decoder) return;
  for (const p of proposalViews(ctx)) {
    if (!p.message || p.message.addressTableLookups.length) continue;
    const call = p.transactionCreate ?? p.executes[0] ?? p.approvals[0];
    if (!call) continue;
    for (const raw of vaultInstructions(p.message)) {
      const ix = ctx.decoder.decodeInstruction(raw);
      if (ix.status !== "named" || ix.programAddress !== TOKEN_2022_PROGRAM || ix.name !== "setTransferFee") continue;
      const bp = arg(ix, "transferFeeBasisPoints"), max = arg(ix, "maximumFee"), mint = accountNamed(ix, "mint");
      if (typeof bp !== "number" || !Number.isInteger(bp) || bp < 0 || bp > 10000 || typeof max !== "bigint" || !mint) continue;
      const evidenceIds = [instructionEvidence(ctx, call.txIndex, call.ix)];
      if (p.contentSource === "state" && p.transaction) {
        const snapshot = ctx.state.squads?.[p.transaction];
        if (!snapshot || snapshot.name !== "VaultTransaction") continue;
        evidenceIds.push(ctx.report.addEvidence({type: "account", source: "rpc", address: p.transaction, summary: "Stored Squads VaultTransaction account decoded from fetched chain state", data: {name: snapshot.name, data: snapshot.data}}));
      } else if (p.contentSource !== "session") continue;
      evidenceIds.push(instructionEvidence(ctx, call.txIndex, ix, [call.ix.index, raw.index]));
      ctx.report.addClaim({kind: "Fact", level: "L0", statement: `Proposed future Token-2022 setTransferFee on mint ${mint}: ${bp} basis points, maximum ${max} base units. Approval alone does not execute this change.`, evidenceIds, transactionIndices: [call.txIndex]});
    }
  }
}

/** Fee/priority settings named by the built-in Compute Budget decoder; any other data stays unknown. */
const isBudgetSetting = isComputeBudget;

export function buildIntentContext(input: {session: Session; decoded: DecodedInstruction[][]; state: RuleState; report: Report; decoder?: Decoder}): IntentContext {
  const { session, decoded, state, report } = input;
  // Matches the browser capture cap. Never silently omit hashes from the binding.
  if (report.session.transactions.length > 64) throw new RangeError("Intent review supports at most 64 transaction hashes");
  const candidates: IntentCandidate[] = [];
  const add = (kind: IntentCandidate["kind"], priority: IntentCandidate["priority"], question: string, text: string, claimIds: string[] = [], evidenceIds: string[] = [], comparison: IntentCandidate["comparison"] = null) => {
    const id = `intent-${candidates.length + 1}`;
    candidates.push({ id, kind, priority, question: question.slice(0, 300), reasons: [{ id: `${id}-reason`, text: text.slice(0, 600), claimIds: claimIds.slice(0, 64), evidenceIds: evidenceIds.slice(0, 64) }], comparison });
  };
  const h = state.wallet && state.history?.wallet === state.wallet ? state.history : undefined;
  const unknownTimes = !!h && [...h.outgoing, ...Object.values(h.counterparties).flatMap((cp) => cp.transfers)].some((t) => t.blockTime === null || !Number.isFinite(t.blockTime));
  const partial = unknownTimes || !h || !["window", "end"].includes(h.reach) || h.unread.length > 0 || h.problems.length > 0 || h.signatures.filter((s) => s.err === null).some((s) => !h.read.includes(s.signature)) || Object.values(h.counterparties).some((cp) => !cp.complete);
  const historyNote = h ? `History window: ${h.since} to ${h.now} (${h.days} days); ${partial ? "partial: unread, unsearched, or undated activity remains unknown" : "read within the recorded window"}. Counts include dated successful outgoing transactions to the exact recipient only, including tiny payments; incoming transfers never count. Undated transfers are excluded from the window count; familiarity does not establish safety.` : "History not read; prior outgoing activity is unknown. Familiarity does not establish safety.";
  for (const c of report.claims) {
    if (c.ruleId === "authority.transfer") {
      const cap = report.capabilities.granted.find((k) => k.claimId === c.id);
      const effect = cap ? `${cap.capability} control of ${cap.target ?? "an unresolved target"} to ${cap.holder ?? "an unresolved holder"}` : "authority";
      add("authority", 4, `Did you intend to ${c.statement.startsWith("Proposed ") ? "approve a proposed future transfer of" : "transfer"} ${effect}?`, c.statement, [c.id], c.evidenceIds);
    }
    else if (c.ruleId === "address.poisoning") {
      const ev = report.evidence.find((e) => c.evidenceIds.includes(e.id) && e.type === "derivation" && e.data && typeof e.data === "object" && !Array.isArray(e.data) && "lookalikeOf" in e.data);
      const d = ev?.data as {recipient: string; lookalikeOf: string; prefix: number; suffix: number} | undefined;
      add("poisoning", 4, "Did you intend to pay this exact address rather than the previous recipient it resembles?", c.statement, [c.id], c.evidenceIds, d ? { proposed: d.recipient, previous: d.lookalikeOf, prefix: d.prefix, suffix: d.suffix } : null);
    } else if (c.ruleId && /^(token2022\.|token\.freeze_authority|token\.delegate_granted)/.test(c.ruleId) && c.kind !== "Unknown") add("token-risk", c.level === "L4" ? 4 : 3, "Did you intend to accept the token controls described here?", c.statement, [c.id], c.evidenceIds);
    else if (c.level === "L4") add("unknown", 4, "Did you intend to authorize the effects in this critical finding?", c.statement, [c.id], c.evidenceIds);
    else if (c.ruleId === "address.dust_sender") add("poisoning", 3, "Did you intend to pay this exact address that previously sent you dust?", c.statement, [c.id], c.evidenceIds);
    else if (c.ruleId === "token.owner_takeover" || c.ruleId === "system.assign_takeover") add("authority", 4, "Did you intend to hand over control of this account?", c.statement, [c.id], c.evidenceIds);
    else if (c.kind === "Unknown") add("unknown", 2, "Did you intend to authorize effects that could not be determined?", c.statement, [c.id], c.evidenceIds);
  }
  const instructions = decoded.flatMap((ixs, txIndex) => ixs.map((ix) => ({ix, txIndex, proposed: false, source: `Signed transaction ${txIndex}, instruction ${ix.index}`, sourceAddress: null as string | null})));
  if (input.decoder) {
    const ctx = { session, decoded, state, decoder: input.decoder, report: new ReportBuilder(session), claims: new Map<string, string>() };
    for (const p of proposalViews(ctx)) if (p.message && !p.message.addressTableLookups.length) {
      const call = p.transactionCreate ?? p.executes[0] ?? p.approvals[0];
      if (call) for (const raw of vaultInstructions(p.message)) instructions.push({ ix: input.decoder.decodeInstruction(raw), txIndex: call.txIndex, proposed: true, source: `${p.contentSource === "state" ? `Stored Squads transaction ${p.transaction}` : `Signed proposal in transaction ${call.txIndex}`}, inner instruction ${raw.index}`, sourceAddress: p.contentSource === "state" ? p.transaction : null });
    }
  }
  for (const {ix, txIndex, proposed, source, sourceAddress} of instructions) {
    if (isBudgetSetting(ix)) continue;
    const evidence = report.evidence.filter((e) => (e.transactionIndex === txIndex && e.type === "instruction") || (sourceAddress !== null && e.address === sourceAddress && e.type === "account")).map((e) => e.id);
    if (ix.status === "named" && ix.programAddress === TOKEN_2022_PROGRAM && ix.name === "setTransferFee") {
      const bp = arg(ix, "transferFeeBasisPoints"), max = arg(ix, "maximumFee"), mint = accountNamed(ix, "mint");
      if (proposed && sourceAddress && !report.evidence.some((e) => e.type === "account" && e.address === sourceAddress && evidence.includes(e.id))) {
        add("unknown", 2, "Did you intend to approve a proposal whose stored contents lack retained source evidence?", `${source}: the stored proposal snapshot is not retained in the report; fee semantics are not established here.`, [], evidence);
      } else if (typeof bp === "number" && Number.isInteger(bp) && bp >= 0 && bp <= 10000 && typeof max === "bigint" && mint) add("fees", 2, proposed ? "Did you intend to approve this proposed future token transfer-fee change?" : "Did you intend to change this token transfer fee?", `${source}: ${proposed ? "proposed future" : "decoded"} Token-2022 setTransferFee on mint ${mint}: ${bp} basis points, maximum ${max} base units. Approval alone does not execute a proposed change.`, [], evidence);
      else add("unknown", 2, "Did you intend to authorize a fee instruction whose arguments are unresolved?", "The decoded fee instruction lacks validated amount or mint arguments.", [], evidence);
    } else if (ix.status === "unknown") add("unknown", 2, "Did you intend to authorize an instruction with unknown effects?", `Instruction ${ix.index} in transaction ${txIndex} on ${ix.programAddress} has unknown semantics.`, [], evidence);
    else {
      const memo = [MEMO_PROGRAM, MEMO_V1_PROGRAM].includes(ix.programAddress);
      const transfer = (ix.programAddress === SYSTEM_PROGRAM && ["transferSol", "advanceNonceAccount"].includes(ix.name ?? "")) || ([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(ix.programAddress) && ["transfer", "transferChecked"].includes(ix.name ?? ""));
      const governance = ix.programAddress === SQUADS_V4_PROGRAM && ["proposalApprove", "proposalCreate", "vaultTransactionCreate", "vaultTransactionExecute"].includes(ix.name ?? "");
      const claimed = report.claims.some((c) => c.kind !== "Unknown" && !!c.ruleId && /^(authority\.transfer|token\.|token2022\.|system\.assign_takeover|squads\.config_change)/.test(c.ruleId) && c.evidenceIds.some((id) => report.evidence.some((e) => e.id === id && e.type === "instruction" && e.transactionIndex === txIndex && e.data && typeof e.data === "object" && !Array.isArray(e.data) && e.data.programId === ix.programAddress && e.data.name === ix.name)));
      if (!memo && !transfer && !governance && !claimed) add("unknown", 2, "Did you intend to authorize additional effects not interpreted by this review?", `Transaction ${txIndex}, decoded instruction ${ix.index} (${ix.name}) on ${ix.programAddress}: its name is decoded, but its effects are not established by a supported intent template.`, [], evidence);
    }
  }
  if (state.wallet) for (const t of requestTransfers({ session, decoded, state }, state.wallet)) {
    const r = t.recipient;
    const failed = new Set(h?.signatures.filter((s) => s.err !== null).map((s) => s.signature));
    const transfers = h ? [...h.outgoing, ...(r ? h.counterparties[r]?.transfers ?? [] : [])] : [];
    // HistoryTransfer extraction already excludes failed meta; also reject any known failed signature.
    const count = new Set(transfers.filter((x) => x.from === state.wallet && x.to === r && !failed.has(x.signature) && (h!.read.includes(x.signature) || !!(r && h!.counterparties[r]?.shared.includes(x.signature))) && x.amount > 0n && x.blockTime !== null && Number.isFinite(x.blockTime) && x.blockTime >= h!.since && x.blockTime <= h!.now).map((x) => x.signature)).size;
    const amount = t.kind === "sol" ? unsigned(lamportsText(t.amount)) : `${t.amount} token base units`;
    const recipient = r ?? `unresolved owner of token account ${t.tokenAccount}`;
    add("transfer", 0, `Did you intend to send ${amount} to ${recipient}?`, `Decoded signed instruction ${t.ix.index} in transaction ${t.txIndex}: ${amount} to ${recipient}. ${h && r ? `${count} successful outgoing transaction(s) to this exact recipient observed in recorded history ${h.since} to ${h.now}${partial ? " (partial)" : ""}.` : "Previous outgoing activity or exact recipient unknown."} Familiarity does not establish safety.`, [], report.evidence.filter((e) => e.transactionIndex === t.txIndex && e.instructionPath?.[0] === t.ix.index).map((e) => e.id));
  }
  const effective = instructions.filter(({ix}) => !isBudgetSetting(ix));
  const onlyMemo = effective.length > 0 && effective.every(({ix}) => ix.status === "named" && [MEMO_PROGRAM, MEMO_V1_PROGRAM].includes(ix.programAddress));
  if (onlyMemo) add("memo", 0, "Did you intend to sign this memo?", `Decoded signed transactions ${report.session.transactions.map((t) => t.index).join(", ")} call only the Memo program. A memo label does not establish semantics for any other instruction.`, [], report.evidence.filter((e) => e.type === "instruction").map((e) => e.id));
  if (!candidates.length) add("unknown", 2, "Did you intend to authorize these effects?", "The available decoded instructions do not establish a supported routine intent; effects remain unknown.", [], report.evidence.map((e) => e.id));
  candidates.sort((a, b) => b.priority - a.priority);
  const routine = effective.every(({ix}) => ix.status === "named" && ([MEMO_PROGRAM, MEMO_V1_PROGRAM].includes(ix.programAddress) || requestTransfers({ session, decoded: [[ix]], state }, state.wallet ?? "").some((t) => t.recipient !== null)));
  if (!routine && candidates.every((c) => c.kind === "transfer" || c.kind === "memo")) {
    add("unknown", 2, "Did you intend to authorize additional effects beyond this transfer?", "Additional decoded instructions are not covered by a supported routine intent template; their effects remain unresolved here.", [], report.evidence.map((e) => e.id));
    candidates.sort((a, b) => b.priority - a.priority);
  }
  const bounded = candidates.slice(0, 8);
  return { version: "kelvara-intent-v1", messageHashes: report.session.transactions.map((t) => t.messageHash), complex: !routine || bounded.some((c) => c.kind !== "memo" && c.kind !== "transfer"), fallbackId: bounded[0]!.id, historyNote, candidates: bounded };
}
