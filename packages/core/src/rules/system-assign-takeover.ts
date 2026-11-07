import { SYSTEM_PROGRAM } from "../state/layouts.js";
import { accountNamed, instructionEvidence, txSigners } from "./common.js";
import { accountEvidence } from "./token-state.js";
import { arg } from "./squads-session.js";
import type { Rule } from "./types.js";
export const systemAssignTakeoverRule:Rule = {
  id:"system.assign_takeover",ruleIds:["system.assign_takeover"],description:"The connected wallet's existing System account reassigned to another program.",
  run(ctx){
    const wallet=ctx.state.wallet, raw=wallet?ctx.state.accounts?.[wallet]:null;
    if(!wallet||!raw||raw.owner!==SYSTEM_PROGRAM||raw.executable||raw.data.length!==0)return;
    ctx.decoded.forEach((ixs,txIndex)=>{for(const ix of ixs){
      if(ix.programAddress!==SYSTEM_PROGRAM||ix.name!=="assign"||accountNamed(ix,"account")!==wallet||!txSigners(ctx.session.transactions[txIndex]!).includes(wallet))continue;
      const next=arg(ix,"programAddress"); if(typeof next!=="string"||next===SYSTEM_PROGRAM)continue;
      ctx.report.addClaim({kind:"Fact",ruleId:this.id,level:"L4",statement:`Wallet ${wallet} is assigned to program ${next}, surrendering control of its SOL account.`,evidenceIds:[instructionEvidence(ctx,txIndex,ix),accountEvidence(ctx,wallet)],dependsOn:ctx.claims.has(`nonce:${txIndex}`)?[ctx.claims.get(`nonce:${txIndex}`)!]:[]});
    }});
  }
};
