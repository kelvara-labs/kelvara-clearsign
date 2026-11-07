import { trapClaims } from "./token-traps.js";
import type { Rule } from "./types.js";
export const tokenFreezeAuthorityRule:Rule = {
  id:"token.freeze_authority",ruleIds:["token.freeze_authority"],description:"Mint-byte-backed trap evidence.",
  run(ctx){ trapClaims(ctx,this.id,m=>m.freezeAuthority ? {text:`Freeze authority ${m.freezeAuthority} can call FreezeAccount on your balance.`,holder:m.freezeAuthority,capability:"token.freeze",class:"freeze"} : null); }
};
