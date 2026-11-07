// squads.approve_and_execute: the session both approves a Squads proposal and executes it, so the
// vote and the action land together with no window for other members to react. Behind a durable
// nonce this is the Drift attack's second transaction. Port of Helius Watchtower
// src/detectors/multisigProposal.ts (nonceApproval + executed, MIT), on our decoded session.
import { instructionEvidence, short } from "./common.js";
import { approvers, proposalViews } from "./squads-session.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "squads.approve_and_execute";

export const squadsApproveAndExecuteRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Session approves and executes the same Squads proposal (Watchtower multisigProposal.ts)",
  run(ctx: RuleContext) {
    for (const v of proposalViews(ctx)) {
      if (!v.approvals.length || !v.executes.length) continue;
      const calls = [...v.approvals, ...v.executes];
      const evidence = calls.map((c) => instructionEvidence(ctx, c.txIndex, c.ix));
      const txs = [...new Set(calls.map((c) => c.txIndex))];
      const nonceClaims = txs.map((t) => ctx.claims.get(`nonce:${t}`)).filter((c): c is string => !!c);
      const who = approvers(v).map(short).join(", ") || "an unresolved member";
      const id = ctx.report.addClaim({
        kind: "Fact",
        statement: `This session approves proposal ${short(v.proposal)} on multisig ${short(v.multisig)} (approved by ${who}) and executes its ${v.kind} transaction ${short(v.transaction)} in ${txs.length === 1 ? "the same transaction" : "the same session"}: the vote and the action land together${nonceClaims.length ? ", on a durable nonce, so they can land at any time the holder chooses" : ""}.`,
        evidenceIds: evidence,
        dependsOn: nonceClaims,
        ruleId: RULE_ID,
        level: nonceClaims.length ? "L3" : "L2"
      });
      ctx.claims.set(`squads.approve_and_execute:${v.proposal ?? v.transaction}`, id);
    }
  }
};
