// session.ordering: outcomes that follow from the order of the transactions. (1) A transaction placed
// before the one that creates an account it uses runs against an account that does not exist yet.
// (2) Two transactions that advance the same durable nonce from the same value exclude each other:
// the first to land advances the nonce, and the other's lifetime token is no longer valid.
import { durableNonceUse, instructionEvidence, short } from "./common.js";
import { sharedAccounts, sharedText } from "./session-links.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "session.ordering";

export const sessionOrderingRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Order-dependent outcomes: use before creation, and durable nonces shared between transactions",
  run(ctx: RuleContext) {
    const n = ctx.session.transactions.length;
    for (let j = 0; j < n; j++) {
      for (let i = j + 1; i < n; i++) {
        const created = sharedAccounts(ctx, i, j).filter((s) => s.createdBy);
        if (!created.length) continue;
        ctx.report.addClaim({
          kind: "Fact",
          ruleId: RULE_ID,
          level: "L1",
          statement: `In the order given, transaction ${j} comes before transaction ${i}, but it uses ${created.map(sharedText).join(", ")}, which transaction ${i} creates: sent in this order, transaction ${j} runs against ${created.length === 1 ? "an account" : "accounts"} that do${created.length === 1 ? "es" : ""} not exist yet.`,
          evidenceIds: created.flatMap((s) => [instructionEvidence(ctx, i, s.createdBy!), ...s.users.map((ix) => instructionEvidence(ctx, j, ix))]),
          transactionIndices: [j, i]
        });
      }
    }

    const uses = ctx.session.transactions.map((t) => durableNonceUse(ctx, t.index));
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const x = uses[a], y = uses[b];
        if (!x || !y || !x.nonceAccount || x.nonceAccount !== y.nonceAccount) continue;
        const ta = ctx.session.transactions[a]!, tb = ctx.session.transactions[b]!;
        if (ta.lifetimeToken !== tb.lifetimeToken) continue;
        const deps = [ctx.claims.get(`nonce:${a}`), ctx.claims.get(`nonce:${b}`)].filter((c): c is string => !!c);
        ctx.report.addClaim({
          kind: "Fact",
          ruleId: RULE_ID,
          level: "L1",
          statement: `Transactions ${a} and ${b} both advance durable nonce account ${short(x.nonceAccount)} from the same nonce value ${short(ta.lifetimeToken)}: at most one of them can land, and whichever lands first makes the other invalid.`,
          evidenceIds: [
            instructionEvidence(ctx, a, x.ix),
            instructionEvidence(ctx, b, y.ix),
            ctx.report.addEvidence({ type: "message", source: "message", summary: `transactions ${a} and ${b} share lifetime token (nonce value)`, data: { nonceAccount: x.nonceAccount, lifetimeToken: ta.lifetimeToken, transactions: [a, b] } })
          ],
          dependsOn: deps,
          transactionIndices: [a, b]
        });
      }
    }
  }
};
