import { SYSTEM_PROGRAM } from "../state/layouts.js";
import { isToken } from "./authority-transfer.js";
import { accountNamed, instructionEvidence, sessionSigners, txSigners } from "./common.js";
import { accountEvidence, tokenAccount } from "./token-state.js";
import { arg } from "./squads-session.js";
import type { Rule } from "./types.js";
export const walletSweepRule:Rule={
  id:"wallet.sweep",ruleIds:["wallet.sweep"],description:"Exact complete SOL/token inventory sent to one non-signing recipient; no heuristic percentages.",
  run(ctx){
    const wallet=ctx.state.wallet,inventory=ctx.state.walletInventory,raw=wallet?ctx.state.accounts?.[wallet]:null;
    if(!wallet||!raw||raw.owner!==SYSTEM_PROGRAM||raw.data.length||!inventory?.complete)return;
    const signers=sessionSigners(ctx);
    ctx.decoded.forEach((ixs,txIndex)=>{
      const tx=ctx.session.transactions[txIndex]!,fee=ctx.state.fees?.[txIndex];
      // Multi-transaction balances need sequential state; this rule never guesses it.
      if(ctx.session.transactions.length!==1||!tx.complete||!txSigners(tx).includes(wallet)||tx.accounts[0]?.address!==wallet||fee===undefined||fee<0n)return;
      let sol=0n, recipient:string|null=null,valid=true;
      const spent=new Map<string,bigint>(),evidence:string[]=[];
      for(const ix of ixs){
        if(ix.programAddress==="ComputeBudget111111111111111111111111111111"||["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr","Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"].includes(ix.programAddress)||(ix.programAddress===SYSTEM_PROGRAM&&ix.name==="advanceNonceAccount"))continue;
        const amount=arg(ix,"amount");
        let to:string|null=null;
        if(ix.programAddress===SYSTEM_PROGRAM&&ix.name==="transferSol"&&accountNamed(ix,"source")===wallet&&typeof amount==="bigint"&&amount>0n){
          sol+=amount;to=accountNamed(ix,"destination");
        }else if(isToken(ix)&&["transfer","transferChecked"].includes(ix.name??"")&&typeof amount==="bigint"&&amount>0n){
          const source=accountNamed(ix,"source"),dest=accountNamed(ix,"destination"),from=tokenAccount(ctx,source),target=tokenAccount(ctx,dest);
          if(!source||!dest||!from||!target||ctx.state.accounts?.[source]?.owner!==ix.programAddress||ctx.state.accounts?.[dest]?.owner!==ix.programAddress||from.owner!==wallet||from.mint!==target.mint||accountNamed(ix,"authority")!==wallet||!inventory.tokenAccounts.includes(source)){valid=false;break;}
          spent.set(source,(spent.get(source)??0n)+amount);to=target.owner;
          evidence.push(accountEvidence(ctx,source),accountEvidence(ctx,dest));
        }else{valid=false;break;}
        if(!to||to===wallet||signers.has(to)||(recipient!==null&&recipient!==to)){valid=false;break;}
        recipient=to;evidence.push(instructionEvidence(ctx,txIndex,ix));
      }
      if(!valid||!recipient||sol<=0n||sol+fee!==raw.lamports)return;
      for(const address of inventory.tokenAccounts){
        const acc=tokenAccount(ctx,address);
        if(!acc||acc.owner!==wallet||acc.amount!==(spent.get(address)??0n))return;
        evidence.push(accountEvidence(ctx,address));
      }
      evidence.push(accountEvidence(ctx,wallet),ctx.report.addEvidence({type:"account",source:"rpc",summary:"Complete inventory from both token programs and exact message fee",data:{wallet,inventory,fee}}));
      ctx.report.addClaim({kind:"Fact",ruleId:this.id,level:"L4",statement:`All wallet SOL (${sol} lamports after ${fee} fee) and every token balance are sent to non-signing recipient ${recipient}.`,evidenceIds:evidence,dependsOn:ctx.claims.has(`nonce:${txIndex}`)?[ctx.claims.get(`nonce:${txIndex}`)!]:[]});
    });
  }
};
