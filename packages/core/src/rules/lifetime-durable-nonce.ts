// lifetime.durable_nonce: the transaction starts with System AdvanceNonceAccount, so its lifetime
// token is a durable nonce and the signature stays valid until the nonce advances: it can be held
// and submitted at any later time. Port of Helius Watchtower src/detectors/nonce.ts (MIT), plus its
// multisigProposal.ts escalation: a Squads vote or execution signed on a durable nonce is critical
// (Drift, April 2026, began with Security Council approvals pre-signed this way).
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
      const id = ctx.report.addClaim({
        kind: "Fact",
        statement: `Transaction ${tx.index} starts with AdvanceNonceAccount on nonce account ${short(use.nonceAccount)} (authority ${short(use.authority)}), so it does not expire: whoever holds the signed bytes can submit them at any later time.${what}`,
        evidenceIds: evidence,
        ruleId: RULE_ID,
        level: squads.length ? "L3" : "L1"
      });
      ctx.claims.set(`nonce:${tx.index}`, id);
    }
  }
};
