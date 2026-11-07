// squads.unknown_proposal: the session votes on or executes a Squads proposal whose contents the
// engine cannot show: no create in the session and no transaction account read, a message that does
// not decode, accounts behind lookup tables, or inner instructions no decoder can name. Approving
// what you cannot see is reported, never assumed safe. Follows Helius Watchtower
// multisigProposal.ts ("contents could not be decoded", MIT).
import { instructionEvidence, short } from "./common.js";
import { proposalViews, vaultInstructions } from "./squads-session.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "squads.unknown_proposal";

export const squadsUnknownProposalRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Vote or execution on a Squads proposal whose contents are unknown",
  run(ctx: RuleContext) {
    for (const v of proposalViews(ctx)) {
      const calls = [...v.approvals, ...v.executes];
      if (!calls.length) continue;
      const problems: string[] = [];
      if (v.message) {
        const keys = v.message.accountKeys.length;
        if (v.message.addressTableLookups.length) problems.push(`its message loads accounts from ${v.message.addressTableLookups.length} lookup table(s) that were not resolved`);
        const inner = vaultInstructions(v.message);
        const unnamed: string[] = [];
        for (const ix of inner) {
          if (ix.programIdIndex >= keys) {
            unnamed.push(`#${ix.index} (program from a lookup table)`);
            continue;
          }
          const d = ctx.decoder?.decodeInstruction(ix);
          if (!d || d.status !== "named") unnamed.push(`#${ix.index} on ${short(ix.programAddress)}`);
        }
        if (unnamed.length) problems.push(`inner instruction(s) ${unnamed.join(", ")} could not be named${ctx.decoder ? "" : " (no decoder given)"}`);
      } else if (!v.configActions) {
        problems.push(v.contentProblem ?? "its contents are not known");
      }
      if (!problems.length) continue;
      ctx.report.addClaim({
        kind: "Unknown",
        statement: `This session ${v.executes.length ? "executes" : "approves"} proposal ${short(v.proposal)} on multisig ${short(v.multisig)}, but what it does is not fully known: ${problems.join("; ")}.`,
        evidenceIds: calls.map((c) => instructionEvidence(ctx, c.txIndex, c.ix)),
        ruleId: RULE_ID,
        level: "L2"
      });
    }
  }
};
