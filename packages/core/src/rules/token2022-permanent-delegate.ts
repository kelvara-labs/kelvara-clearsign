import { trapClaims } from "./token-traps.js";
import type { Rule } from "./types.js";
export const token2022PermanentDelegateRule:Rule = {
  id:"token2022.permanent_delegate",ruleIds:["token2022.permanent_delegate"],description:"Mint-byte-backed trap evidence.",
  run(ctx){ trapClaims(ctx,this.id,m=>m.program === "token-2022" && m.permanentDelegate ? {text:`Permanent delegate ${m.permanentDelegate} can call Transfer and Burn on your balance.`,holder:m.permanentDelegate,capability:"token.permanent_delegate",class:"fund_movement"} : null); }
};
