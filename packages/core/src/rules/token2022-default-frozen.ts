import { trapClaims } from "./token-traps.js";
import type { Rule } from "./types.js";
export const token2022DefaultFrozenRule:Rule = {
  id:"token2022.default_frozen",ruleIds:["token2022.default_frozen"],description:"Mint-byte-backed trap evidence.",
  run(ctx){ trapClaims(ctx,this.id,m=>m.program === "token-2022" && m.defaultAccountState === "frozen" ? {text:"New token accounts are frozen by default; transfers require thawing.",holder:m.freezeAuthority,capability:"token.default_frozen",class:"freeze"} : null); }
};
