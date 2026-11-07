import { accountNamed, instructionEvidence } from "./common.js";
import { isToken } from "./authority-transfer.js";
import { recipient, mintAccount, accountEvidence } from "./token-state.js";
import type { RuleContext } from "./types.js";
import type { MintInfo } from "../state/layouts.js";
import type { CapabilityClass } from "../report/rubrics.js";

/** Only signed message destinations/ATA creations linked to the connected wallet. */
export function trapClaims(ctx:RuleContext,id:string,describe:(m:MintInfo)=>{text:string;holder:string|null;capability:string;class:CapabilityClass}|null):void {
  if(!ctx.state.wallet)return;
  const seen=new Set<string>();
  ctx.decoded.forEach((ixs,txIndex)=>{for(const ix of ixs){
    let to=null;
    if(isToken(ix)&&["transfer","transferChecked","transferCheckedWithFee","mintTo","mintToChecked"].includes(ix.name??""))to=recipient(ctx,txIndex,accountNamed(ix,"destination"));
    else if(ix.programAddress==="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")to=recipient(ctx,txIndex,ix.accounts[1]?.address??null);
    if(!to||to.owner!==ctx.state.wallet||seen.has(to.mint))continue;
    const mint=mintAccount(ctx,to.mint); if(!mint||!mint.isInitialized)continue;
    const finding=describe(mint); if(!finding)continue;
    seen.add(to.mint);
    const claimId=ctx.report.addClaim({kind:"Fact",ruleId:id,level:"L2",statement:`Mint ${to.mint}: ${finding.text}`,evidenceIds:[instructionEvidence(ctx,txIndex,ix),accountEvidence(ctx,to.mint)]});
    ctx.report.addCapability({direction:"granted",capability:finding.capability,class:finding.class,holder:finding.holder,target:to.mint,claimId});
  }});
}
