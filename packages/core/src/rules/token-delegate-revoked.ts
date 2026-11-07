import { accountNamed, instructionEvidence } from "./common.js";
import { isToken } from "./authority-transfer.js";
import { accountEvidence, tokenAccount } from "./token-state.js";
import type { Rule } from "./types.js";
export const tokenDelegateRevokedRule: Rule = {
  id:"token.delegate_revoked",ruleIds:["token.delegate_revoked"],description:"Revoke is a lost power, never a grant.",
  run(ctx) {
    ctx.decoded.forEach((ixs,txIndex)=>{for(const ix of ixs){
      if(!isToken(ix)||ix.name!=="revoke")continue;
      const target=accountNamed(ix,"source"); if(!target)continue;
      const acc=tokenAccount(ctx,target);
      const evidence=[instructionEvidence(ctx,txIndex,ix)];
      if(acc)evidence.push(accountEvidence(ctx,target));
      const id=ctx.report.addClaim({kind:"Fact",ruleId:this.id,level:"L1",statement:`Revoke removes delegate ${acc?.delegate ?? "(not read)"} from ${target}${acc ? `; previous allowance ${acc.delegatedAmount} base units` : ""}.`,evidenceIds:evidence});
      ctx.report.addCapability({direction:"revoked",capability:"token.delegate",class:acc && acc.delegatedAmount>=((1n<<64n)-1n)*99n/100n?"fund_movement":"bounded_spend",holder:acc?.delegate??null,target,claimId:id});
    }});
  }
};
