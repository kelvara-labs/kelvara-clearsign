// Explain (M7 / E15): a fixed template for every ruleId. Templates are the default explanation and
// the only one shipped (the optional on-device AI layer is cut, PLAN cut list #1).
// Rules: a template carries no numbers, no addresses and no "will": every specific (amount, address,
// instruction name) comes from the claim's own statement, and consequences are phrased as "can"/"may".
// The explanation is a pure function of the report, so its digest is as stable as the report digest.
import { canonicalDigest } from "../report/canonical.js";
import type { Claim, Report } from "../report/schema.js";
import type { AlertLevel, ClaimKind } from "../report/rubrics.js";

export const EXPLAIN_VERSION = "kelvara-explain-v1";

export interface RuleTemplate {
  /** Short headline for the claim card. */
  title: string;
  /** Why it matters, in plain words. */
  why: string;
  /** What the user can do about it. */
  advice: string;
}

export const RULE_TEMPLATES: Readonly<Record<string, RuleTemplate>> = {
  "authority.transfer": {
    title: "Control of an account or program moves to another key",
    why: "Whoever holds this authority can change, drain or replace what it controls, and you may not be able to take it back.",
    advice: "Sign only if you meant to hand over control and you recognise the new authority."
  },
  "lifetime.durable_nonce": {
    title: "The transaction does not expire",
    why: "A durable nonce lets a signed transaction be held and submitted at any later time, which is how pre-signed attacks are staged.",
    advice: "Treat a non-expiring signature as permanent; sign it only for a flow you set up yourself."
  },
  "nonce.staged_by_outsider": {
    title: "The nonce account was set up by someone outside your wallet",
    why: "An outside party prepared a non-expiring transaction for you to sign, so they can choose when it lands.",
    advice: "Ask who created the nonce account and why before you sign."
  },
  "squads.approve_and_execute": {
    title: "Approval and execution happen together",
    why: "Your approval can complete the vote and run the proposal in one step, leaving no time for other members to react.",
    advice: "Approve without executing, and let the team review the proposal content first."
  },
  "squads.threshold_met_in_session": {
    title: "This signature reaches the multisig threshold",
    why: "Once the threshold is met, the proposal can be executed by anyone at any time.",
    advice: "Check the proposal content yourself; your vote is the one that makes it executable."
  },
  "squads.zero_timelock_execution": {
    title: "The multisig has no time lock",
    why: "With no time lock, an approved proposal can run immediately and nobody gets a window to cancel it.",
    advice: "Confirm the proposal content with the other members before approving."
  },
  "squads.unknown_proposal": {
    title: "The proposal content could not be read",
    why: "You are voting on a proposal whose instructions are not shown here, so its effect is unknown.",
    advice: "Open the proposal in the multisig app and read its instructions before approving."
  },
  "squads.config_change": {
    title: "The multisig configuration changes",
    why: "Changing members, threshold or time lock changes who can move the multisig's funds and authorities.",
    advice: "Make sure every member agreed to this configuration change."
  },
  "token.delegate_granted": {
    title: "A delegate can move your tokens",
    why: "The delegate can transfer or burn tokens from this account up to the approved amount without asking you again.",
    advice: "Approve only the amount you need and revoke the delegate when you are done."
  },
  "token.delegate_revoked": {
    title: "A token delegate is removed",
    why: "Revoking a delegate takes away its power to move tokens from this account.",
    advice: "This lowers risk; check that the account is the one you meant."
  },
  "token2022.permanent_delegate": {
    title: "The token has a permanent delegate",
    why: "The permanent delegate can transfer or burn this token from any holder's account at any time, including yours.",
    advice: "Assume tokens of this mint can be taken back; avoid holding value in it."
  },
  "token.freeze_authority": {
    title: "The token can be frozen",
    why: "The freeze authority can freeze your token account, after which you may not be able to sell or move the tokens.",
    advice: "Prefer tokens whose freeze authority is revoked, or trust the authority holder."
  },
  "token2022.transfer_hook": {
    title: "Transfers of this token run outside code",
    why: "A transfer hook runs a program chosen by the token creator on every transfer, and it can block or change transfers.",
    advice: "Check the hook program; it may stop you from selling."
  },
  "token2022.default_frozen": {
    title: "New accounts for this token start frozen",
    why: "Token accounts begin frozen, so you may receive tokens you cannot move until the authority thaws them.",
    advice: "Buy only if you trust the freeze authority to thaw your account."
  },
  "token2022.non_transferable": {
    title: "This token cannot be transferred",
    why: "Non-transferable tokens stay in the receiving account; you cannot sell or send them on.",
    advice: "Do not pay for a non-transferable token expecting to resell it."
  },
  "system.assign_takeover": {
    title: "Your account is assigned to another program",
    why: "After the assignment that program owns the account and can control its data and lamports instead of your key.",
    advice: "Wallet accounts are almost never reassigned on purpose; reject unless you are certain."
  },
  "token.owner_takeover": {
    title: "Ownership of a token account moves to another key",
    why: "The new owner can move every token in the account, now and later.",
    advice: "Sign only if you meant to give the account away."
  },
  "wallet.sweep": {
    title: "The transaction empties the wallet",
    why: "Moving all or nearly all of a balance in one step is the pattern of a drainer.",
    advice: "Check the recipient and amounts; a normal purchase rarely moves everything."
  },
  "address.poisoning": {
    title: "The recipient imitates an address you have paid before",
    why: "Look-alike addresses are planted in your history so you copy the wrong one; funds sent there may be lost.",
    advice: "Compare the full address with the one you meant, character by character."
  },
  "address.dust_sender": {
    title: "The recipient sent you dust",
    why: "Tiny unsolicited transfers are used to plant addresses in your history for later poisoning.",
    advice: "Copy recipient addresses from a trusted source, not from your transaction history."
  },
  "address.first_send": {
    title: "First transfer to this address",
    why: "You have not sent to this address in the checked history, so there is no past payment to compare it with.",
    advice: "Confirm the address with the recipient through a second channel."
  },
  "tx.foreign_fee_payer": {
    title: "Someone else pays the fee",
    why: "Another key pays the fee and can decide when to submit the transaction you sign.",
    advice: "Make sure you know who sponsors the fee and why."
  },
  "session.dependency": {
    title: "Transactions in this request depend on each other",
    why: "A later transaction uses accounts an earlier one writes, so the batch only makes sense as a whole.",
    advice: "Review the batch together, not one transaction at a time."
  },
  "session.ordering": {
    title: "The order of transactions matters",
    why: "A transaction appears before the one it depends on, or two transactions exclude each other, so some may fail or land in an unexpected order.",
    advice: "Check that the order is what the app intended."
  },
  "session.partial_execution": {
    title: "Only part of the request may land",
    why: "Transactions land one by one, so a grant in one may take effect even if the rest fails.",
    advice: "Ask whether each transaction is safe on its own."
  },
  "intent.label_mismatch": {
    title: "The label does not match what the transaction does",
    why: "The memo or proposal label describes something milder than the powers the transaction grants.",
    advice: "Trust the instructions, not the label."
  },
  "sim.power_without_value": {
    title: "The balance preview hides a grant of power",
    why: "Simulation shows only a fee or a normal purchase, but the transaction also grants control that a balance preview cannot show.",
    advice: "Read what you authorize, not only what the simulation shows."
  },
  "fact.unknown_instruction": {
    title: "Calls a program ClearSign can't read",
    why: "ClearSign has no public interface for this program, so it cannot tell what the instruction moves or authorizes.",
    advice: "Continue only if you trust this site and this program."
  },
  "fact.memo": {
    title: "Signs a memo",
    why: "A memo is plain text recorded with the transaction; it moves no funds and gives no one any power.",
    advice: "Check that the text is what you expect to put your name to."
  },
  "fact.sol_transfer": {
    title: "Sends SOL",
    why: "SOL leaves the sender's account for the recipient once the transaction lands.",
    advice: "Check the amount and the full recipient address."
  },
  "fact.token_transfer": {
    title: "Sends tokens",
    why: "Tokens leave the sender's token account for the recipient once the transaction lands.",
    advice: "Check the amount, the token and the full recipient address."
  },
  "fact.swap": {
    title: "Swaps tokens",
    why: "A Jupiter route trades the tokens in your source token account for the tokens in your destination token account; the amounts are the most you give and the least you receive.",
    advice: "Check both tokens, the amounts and the slippage tolerance."
  },
  "fact.priority_fee": {
    title: "Pays a priority fee",
    why: "A unit limit and price make the fee payer pay extra so the transaction is processed sooner; this is a fee, not a permission.",
    advice: "Check that the fee is acceptable for what you are doing."
  },
  "fact.network_fee": {
    title: "Pays the network fee",
    why: "Every transaction pays a fee per signature, taken from the fee payer.",
    advice: "Check who the fee payer is."
  },
  "fact.no_permission_change": {
    title: "Changes no permissions",
    why: "Every instruction is understood and none grants or revokes an authority, delegate, owner or upgrade permission.",
    advice: "This covers permissions only; still check amounts and recipients."
  },
  "graph.capability_preview": {
    title: "What the new authority can do",
    why: "These are the instructions the new authority can call once it holds the power, ranked by the damage they can do.",
    advice: "Read the top lines; that is the worst case."
  },
  "capability.recovery_path": {
    title: "Whether the power can be taken back",
    why: "This shows who, if anyone, can reverse the grant afterwards.",
    advice: "If there is no recovery path, treat the grant as permanent."
  }
};

/** Used only for a claim whose ruleId has no template (G9 proves none exists) or a claim without a ruleId. */
export const FALLBACK_TEMPLATE: RuleTemplate = {
  title: "Finding",
  why: "The engine recorded this finding with the evidence listed below.",
  advice: "Open the evidence before you sign."
};

/** How sure the claim is, said the same way every time. */
export const KIND_LEADS: Readonly<Record<ClaimKind, string>> = {
  Fact: "Proven from the transaction and on-chain reads:",
  Derived: "Derived from the decoded instructions:",
  Conditional: "Possible, under the stated assumptions:",
  Unknown: "Not determined:"
};

export interface ClaimExplanation {
  claimId: string;
  ruleId: string | null;
  kind: ClaimKind;
  level: AlertLevel;
  /** "template" when the ruleId has its own template, "fallback" otherwise. */
  source: "template" | "fallback";
  title: string;
  /** Kind lead + the claim's own statement (all specifics) + why it matters. */
  text: string;
  advice: string;
  /** Assumptions of a Conditional claim, verbatim. */
  assumptions: string[];
  evidenceIds: string[];
}

export interface ReportExplanation {
  version: typeof EXPLAIN_VERSION;
  reportDigest: string;
  headline: string;
  /** Claims at the report's alert level first (in alert order), then the rest by level desc, claim order. */
  claims: ClaimExplanation[];
  /** "sha256:<hex>" of the canonical JSON of this object without the digest. */
  digest: string;
}

export function templateFor(ruleId: string | null): { template: RuleTemplate; source: "template" | "fallback" } {
  const t = ruleId ? RULE_TEMPLATES[ruleId] : undefined;
  return t ? { template: t, source: "template" } : { template: FALLBACK_TEMPLATE, source: "fallback" };
}

const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

export function explainClaim(claim: Claim): ClaimExplanation {
  const { template, source } = templateFor(claim.ruleId);
  return {
    claimId: claim.id,
    ruleId: claim.ruleId,
    kind: claim.kind,
    level: claim.level,
    source,
    title: template.title,
    text: `${KIND_LEADS[claim.kind]} ${sentence(claim.statement)} ${template.why}`,
    advice: template.advice,
    assumptions: [...claim.assumptions],
    evidenceIds: [...claim.evidenceIds]
  };
}

const levelNum = (l: AlertLevel): number => Number(l.slice(1));

/** Strongest fact first: what the transaction does matters more than what it costs. */
const FACT_ORDER = ["fact.unknown_instruction", "fact.swap", "fact.sol_transfer", "fact.token_transfer", "fact.memo", "fact.priority_fee", "fact.network_fee", "fact.no_permission_change"];

/** L0 headline: says what the transaction does; says "No risks found" only when every instruction was understood. */
function calmHeadline(report: Report, claims: ClaimExplanation[]): string {
  const strongest = FACT_ORDER.map((id) => claims.find((c) => c.ruleId === id)).find((c) => !!c);
  const allUnderstood = claims.some((c) => c.ruleId === "fact.no_permission_change");
  const head = allUnderstood ? "No risks found" : "Can't fully verify this transaction";
  return strongest ? `${head}: ${strongest.title.charAt(0).toLowerCase()}${strongest.title.slice(1)}` : head;
}

/** The default explanation of a report: templates only, deterministic. */
export function explainReport(report: Report): ReportExplanation {
  const byId = new Map(report.claims.map((c) => [c.id, c]));
  const alertIds = report.alert.claimIds.filter((id) => byId.has(id));
  const alertSet = new Set(alertIds);
  const rest = report.claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !alertSet.has(c.id))
    .sort((a, b) => levelNum(b.c.level) - levelNum(a.c.level) || a.i - b.i)
    .map(({ c }) => c);
  const claims = [...alertIds.map((id) => byId.get(id)!), ...rest].map(explainClaim);
  const titles = [...new Set(claims.filter((c) => alertSet.has(c.claimId)).map((c) => c.title))];
  const headline = titles.length ? `${report.alert.label}: ${titles.join("; ")}` : calmHeadline(report, claims);
  const body: Omit<ReportExplanation, "digest"> = { version: EXPLAIN_VERSION, reportDigest: report.digest, headline, claims };
  return { ...body, digest: canonicalDigest(body) };
}
