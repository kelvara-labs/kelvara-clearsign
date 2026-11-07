// session.dependency: a later transaction uses accounts that an earlier one writes or creates, so its
// outcome depends on the earlier one landing first (Watchtower attackChain.ts links transactions in
// a time window; here the link is read from the messages themselves).
import { instructionEvidence, short } from "./common.js";
import { sharedAccounts, sharedText } from "./session-links.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "session.dependency";

export const sessionDependencyRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "A later transaction uses accounts an earlier one writes or creates (static, from the messages)",
  run(ctx: RuleContext) {
    const n = ctx.session.transactions.length;
    for (let j = 1; j < n; j++) {
      for (let i = 0; i < j; i++) {
        const shared = sharedAccounts(ctx, i, j);
        if (!shared.length) continue;
        const evidence = shared.flatMap((s) => [...s.writers.map((ix) => instructionEvidence(ctx, i, ix)), ...s.users.map((ix) => instructionEvidence(ctx, j, ix))]);
        const created = shared.filter((s) => s.createdBy);
        const outcome = created.length
          ? `until transaction ${i} lands, ${created.map((s) => short(s.address)).join(" and ")} ${created.length === 1 ? "does" : "do"} not exist, so transaction ${j} only works after it`
          : `its result depends on transaction ${i} landing first`;
        const id = ctx.report.addClaim({
          kind: "Fact",
          ruleId: RULE_ID,
          level: "L0",
          statement: `Transaction ${j} uses ${shared.length === 1 ? "an account" : `${shared.length} accounts`} that transaction ${i} writes: ${shared.map(sharedText).join(", ")}; ${outcome}.`,
          evidenceIds: evidence,
          transactionIndices: [i, j]
        });
        ctx.claims.set(`dependency:${i}:${j}`, id);
      }
    }
  }
};
