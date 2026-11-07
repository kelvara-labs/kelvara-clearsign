import { accountNamed, instructionEvidence } from "./common.js";
import { isToken } from "./authority-transfer.js";
import { arg } from "./squads-session.js";
import type { Rule } from "./types.js";

export const tokenDelegateGrantedRule: Rule = {
  id: "token.delegate_granted", ruleIds: ["token.delegate_granted"], description: "Exact SPL allowance, with near-u64-max allowances ranked as fund movement.",
  run(ctx) {
    ctx.decoded.forEach((ixs,txIndex)=>{ for (const ix of ixs) {
      if (!isToken(ix) || !["approve","approveChecked"].includes(ix.name ?? "")) continue;
      const amount = arg(ix,"amount"), delegate = accountNamed(ix,"delegate"), target = accountNamed(ix,"source");
      if (typeof amount !== "bigint" || !delegate || !target) continue;
      const unlimited = amount >= ((1n << 64n)-1n)*99n/100n;
      const id = ctx.report.addClaim({kind:"Fact",ruleId:this.id,level:unlimited?"L2":"L1",statement:`Delegate ${delegate} is granted ${amount} base units from ${target}${unlimited ? " (unlimited or near-max allowance)" : ""}.`,evidenceIds:[instructionEvidence(ctx,txIndex,ix)]});
      ctx.report.addCapability({direction:"granted",capability:"token.delegate",class:unlimited?"fund_movement":"bounded_spend",holder:delegate,target,claimId:id,programId:ix.programAddress});
    }});
  }
};
