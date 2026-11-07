// squads.zero_timelock_execution: the session votes on or executes a proposal of a multisig whose
// time lock is 0, so once the threshold is met nothing delays execution: no review window for the
// other members. Drift's Security Council had threshold 2 and time lock 0. From the time-lock
// handling of Helius Watchtower src/detectors/multisigChange.ts and multisigProposal.ts (MIT).
import { instructionEvidence, short } from "./common.js";
import { multisigEvidence, multisigView, proposalViews } from "./squads-session.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "squads.zero_timelock_execution";

export const squadsZeroTimelockRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Vote or execution on a multisig with time lock 0",
  run(ctx: RuleContext) {
    for (const v of proposalViews(ctx)) {
      const calls = [...v.approvals, ...v.executes];
      if (!calls.length) continue;
      const ms = multisigView(ctx, v.multisig);
      if (!ms || ms.timeLock !== 0) continue;
      const evidence = [...calls.map((c) => instructionEvidence(ctx, c.txIndex, c.ix)), multisigEvidence(ctx, ms)];
      const met = ctx.claims.get(`squads.threshold_met:${v.proposal}`);
      const both = ctx.claims.get(`squads.approve_and_execute:${v.proposal ?? v.transaction}`);
      const dependsOn = [met, both].filter((c): c is string => !!c);
      const now = v.executes.length > 0 || !!met;
      ctx.report.addClaim({
        kind: "Derived",
        statement: `Multisig ${short(v.multisig)} has a time lock of 0 seconds: ${now ? `proposal ${short(v.proposal)} can execute the moment this session lands, with no review window for other members` : `once proposal ${short(v.proposal)} reaches its threshold it can execute at once, with no review window`}.`,
        evidenceIds: evidence,
        dependsOn,
        ruleId: RULE_ID,
        level: now ? "L2" : "L1"
      });
    }
  }
};
