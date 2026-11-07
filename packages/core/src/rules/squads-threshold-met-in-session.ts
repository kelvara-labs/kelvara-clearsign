// squads.threshold_met_in_session: the approvals in this session are what take a Squads proposal
// to its threshold, so signing it completes the vote (with a zero time lock, the proposal can then
// execute at once). Prior approvals come from an in-session proposalCreate (none yet) or the
// Proposal account read from chain; the threshold from the Multisig account. Port of the approval
// logic in Helius Watchtower src/detectors/multisigProposal.ts (MIT).
import { instructionEvidence, short } from "./common.js";
import { approvers, multisigEvidence, multisigView, proposalEvidence, proposalState, proposalViews } from "./squads-session.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "squads.threshold_met_in_session";

export const squadsThresholdMetRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Session approvals reach the multisig threshold (Watchtower multisigProposal.ts)",
  run(ctx: RuleContext) {
    for (const v of proposalViews(ctx)) {
      const voters = approvers(v);
      if (!voters.length) continue;
      const evidence = v.approvals.map((a) => instructionEvidence(ctx, a.txIndex, a.ix));
      const nonceClaims = [...new Set(v.approvals.map((a) => a.txIndex))].map((t) => ctx.claims.get(`nonce:${t}`)).filter((c): c is string => !!c);
      const ms = multisigView(ctx, v.multisig);
      if (!ms) {
        ctx.report.addClaim({
          kind: "Unknown",
          statement: `Multisig ${short(v.multisig)} was not read, so it is unknown whether the ${voters.length} approval(s) in this session reach its threshold.`,
          evidenceIds: evidence,
          ruleId: RULE_ID,
          level: "L1"
        });
        continue;
      }
      evidence.push(multisigEvidence(ctx, ms));
      // Approvals already on chain before this session.
      let prior: string[] | null = null;
      if (v.proposalCreate) {
        prior = [];
        evidence.push(instructionEvidence(ctx, v.proposalCreate.txIndex, v.proposalCreate.ix));
      } else {
        const p = proposalState(ctx, v.proposal);
        if (p && (p.status === "Active" || p.status === "Draft")) {
          prior = p.approved;
          evidence.push(proposalEvidence(ctx, v.proposal!)!);
        }
      }
      const votersNew = prior ? voters.filter((m) => !prior!.includes(m)) : voters;
      const total = (prior?.length ?? 0) + votersNew.length;
      const executesNow = v.executes.length > 0;
      const immediate = ms.timeLock === 0 || executesNow;
      const tail = immediate ? (executesNow ? " and the session executes it" : "; with a zero time lock it can execute immediately") : `; it can execute after the ${ms.timeLock} s time lock`;
      if (prior && prior.length < ms.threshold && total >= ms.threshold) {
        const id = ctx.report.addClaim({
          kind: "Derived",
          statement: `Proposal ${short(v.proposal)} on multisig ${short(v.multisig)} had ${prior.length} of ${ms.threshold} required approvals; the ${votersNew.length} approval(s) in this session (${votersNew.map(short).join(", ")}) complete the vote${tail}.`,
          evidenceIds: evidence,
          dependsOn: nonceClaims,
          ruleId: RULE_ID,
          level: immediate ? "L2" : "L1"
        });
        ctx.claims.set(`squads.threshold_met:${v.proposal}`, id);
      } else if (!prior && votersNew.length < ms.threshold) {
        ctx.report.addClaim({
          kind: "Conditional",
          statement: `Proposal ${short(v.proposal)} was not read: if it already has ${ms.threshold - votersNew.length} approval(s), the ${votersNew.length} in this session complete its ${ms.threshold}-of-${ms.members.length} vote${tail}.`,
          evidenceIds: evidence,
          dependsOn: nonceClaims,
          ruleId: RULE_ID,
          assumptions: [`the proposal already has at least ${ms.threshold - votersNew.length} approval(s) from other members`],
          level: "L1"
        });
      } else if (!prior && votersNew.length >= ms.threshold) {
        const id = ctx.report.addClaim({
          kind: "Derived",
          statement: `The ${votersNew.length} approvals in this session alone meet the ${ms.threshold}-of-${ms.members.length} threshold of multisig ${short(v.multisig)}${tail}.`,
          evidenceIds: evidence,
          dependsOn: nonceClaims,
          ruleId: RULE_ID,
          level: immediate ? "L2" : "L1"
        });
        ctx.claims.set(`squads.threshold_met:${v.proposal}`, id);
      }
    }
  }
};
