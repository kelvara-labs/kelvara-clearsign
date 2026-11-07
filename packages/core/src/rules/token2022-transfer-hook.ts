import { trapClaims } from "./token-traps.js";
import type { Rule } from "./types.js";
export const token2022TransferHookRule:Rule = {
  id:"token2022.transfer_hook",ruleIds:["token2022.transfer_hook"],description:"Mint-byte-backed trap evidence.",
  run(ctx){ trapClaims(ctx,this.id,m=>m.program === "token-2022" && m.transferHook?.programId ? {text:`Transfer hook ${m.transferHook?.programId} runs on every transfer.`,holder:m.transferHook?.authority ?? null,capability:"token.transfer_hook",class:"config"} : null); }
};
