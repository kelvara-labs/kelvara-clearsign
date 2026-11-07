import { authorityType, isToken } from "./authority-transfer.js";
import { accountNamed, instructionEvidence, txSigners } from "./common.js";
import { accountEvidence, tokenAccount } from "./token-state.js";
import { arg } from "./squads-session.js";
import type { Rule } from "./types.js";
export const tokenOwnerTakeoverRule:Rule={
  id:"token.owner_takeover",ruleIds:["token.owner_takeover"],description:"Owner or close authority of a verified wallet-owned token account handed outside the session.",
  run(ctx){
    const wallet=ctx.state.wallet;if(!wallet)return;
    ctx.decoded.forEach((ixs,txIndex)=>{for(const ix of ixs){
      if(!isToken(ix)||ix.name!=="setAuthority"||!txSigners(ctx.session.transactions[txIndex]!).includes(wallet))continue;
      const type=authorityType(ix),target=accountNamed(ix,"owned"),next=arg(ix,"newAuthority"),acc=tokenAccount(ctx,target);
      if(!target||!acc||ctx.state.accounts?.[target]?.owner!==ix.programAddress||!ctx.session.transactions[txIndex]!.complete||acc.owner!==wallet||typeof next!=="string"||txSigners(ctx.session.transactions[txIndex]!).includes(next)||!["accountOwner","closeAccount"].includes(type??""))continue;
      const current: string=type==="closeAccount"?acc.closeAuthority??acc.owner:acc.owner;
      if(accountNamed(ix,"owner")!==current||current!==wallet)continue;
      ctx.report.addClaim({kind:"Fact",ruleId:this.id,level:"L4",statement:`${type} of wallet-owned token account ${target} passes from ${current} to outsider ${next}.`,evidenceIds:[instructionEvidence(ctx,txIndex,ix),accountEvidence(ctx,target)],dependsOn:ctx.claims.has(`nonce:${txIndex}`)?[ctx.claims.get(`nonce:${txIndex}`)!]:[]});
    }});
  }
};
