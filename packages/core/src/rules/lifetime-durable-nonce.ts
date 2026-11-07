// Durable nonce lifetime is independent of intent. L3 requires linked control-grant evidence.
import { SQUADS_V4_PROGRAM } from "../decode/squads.js";
import { durableNonceUse, instructionEvidence, short } from "./common.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "lifetime.durable_nonce";
/** Squads calls that move a proposal toward execution: a vote or the execution itself. */
export const SQUADS_PRIVILEGED = new Set(["proposalApprove", "vaultTransactionExecute", "configTransactionExecute", "batchExecuteTransaction"]);

export const durableNonceRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Transaction uses a durable nonce and never expires (Watchtower nonce.ts)",
  run(ctx: RuleContext) {
    for (const tx of ctx.session.transactions) {
      const use = durableNonceUse(ctx, tx.index);
      if (!use) continue;
      const evidence = [instructionEvidence(ctx, tx.index, use.ix)];
      evidence.push(
        ctx.report.addEvidence({
          type: "message",
          source: "message",
          summary: `transaction ${tx.index} lifetime token (durable nonce value)`,
          transactionIndex: tx.index,
          data: { lifetimeToken: tx.lifetimeToken, nonceAccount: use.nonceAccount, nonceAuthority: use.authority }
        })
      );
      const squads = ctx.decoded[tx.index]!.filter((ix) => ix.programAddress === SQUADS_V4_PROGRAM && ix.status === "named" && SQUADS_PRIVILEGED.has(ix.name!));
      for (const ix of squads) evidence.push(instructionEvidence(ctx, tx.index, ix));
      const what = squads.length ? ` It carries Squads ${[...new Set(squads.map((s) => s.name))].join(", ")}: a multisig vote or execution that can be collected now and landed whenever the holder chooses.` : "";
      const grant = ctx.claims.get(`controlGrant:${tx.index}`);
      const id = ctx.report.addClaim({
        transactionIndices: [tx.index],
        dependsOn: grant ? [grant] : [],
        kind: "Fact",
        statement: `Transaction ${tx.index} starts with AdvanceNonceAccount on nonce account ${short(use.nonceAccount)} (authority ${short(use.authority)}), so it does not expire: whoever holds the signed bytes can submit them at any later time.${what}`,
        evidenceIds: evidence,
        ruleId: RULE_ID,
        level: grant ? "L3" : squads.length ? "L2" : "L1"
      });
      ctx.claims.set(`nonce:${tx.index}`, id);
    }
  }
};
