// tx.foreign_fee_payer: the connected wallet signs a transaction whose fee payer is another key.
// The fee payer's signature is required, so that key (not the user) decides whether and when the
// transaction is submitted. Needs the connected wallet; it is never inferred from the signers.
import { short, txSigners } from "./common.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "tx.foreign_fee_payer";

export const txForeignFeePayerRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Fee payer outside the user's keys (PLAN alert-levels-v1 L2 example)",
  run(ctx: RuleContext) {
    const wallet = ctx.state.wallet;
    if (!wallet) return;
    for (const tx of ctx.session.transactions) {
      const feePayer = tx.accounts[0]?.address ?? null;
      const signers = txSigners(tx);
      if (!feePayer || feePayer === wallet || !signers.includes(wallet)) continue;
      const nonce = ctx.claims.get(`nonce:${tx.index}`);
      ctx.report.addClaim({
        kind: "Fact",
        ruleId: RULE_ID,
        level: "L2",
        statement: `Transaction ${tx.index} is paid for by ${feePayer}, not by your wallet ${short(wallet)}: the fee payer must sign too, so ${short(feePayer)} decides whether and when it is submitted.${nonce ? " It uses a durable nonce, so that key can hold it indefinitely." : ""}`,
        evidenceIds: [
          ctx.report.addEvidence({
            type: "message",
            source: "message",
            transactionIndex: tx.index,
            summary: `transaction ${tx.index} fee payer (first account) and signers`,
            data: { feePayer, signers, wallet }
          })
        ],
        dependsOn: nonce ? [nonce] : [],
        transactionIndices: [tx.index]
      });
    }
  }
};
