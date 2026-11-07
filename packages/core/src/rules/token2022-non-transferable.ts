import { trapClaims } from "./token-traps.js";
import type { Rule } from "./types.js";
export const token2022NonTransferableRule:Rule = {
  id:"token2022.non_transferable",ruleIds:["token2022.non_transferable"],description:"Mint-byte-backed trap evidence.",
  run(ctx){ trapClaims(ctx,this.id,m=>m.program === "token-2022" && m.nonTransferable ? {text:"Non-transferable mint: received tokens cannot be transferred.",holder:null,capability:"token.non_transferable",class:"other"} : null); }
};
