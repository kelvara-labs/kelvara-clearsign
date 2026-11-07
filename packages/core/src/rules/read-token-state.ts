import type { Address } from "@solana/kit";
import type { Session } from "../ingest/types.js";
import { accountFromRpc, type RpcAccount, type RpcAccountReader } from "../rpc/methods.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, decodeTokenAccount } from "../state/layouts.js";
import { toBase64 } from "../util/encoding.js";
import type { RuleState } from "./types.js";

/** Per-session read-only enrichment. Failures propagate so the caller holds the request. */
export async function readTokenRuleState(reader:RpcAccountReader,session:Session,wallet:string,opts:{inventory?:boolean}={}):Promise<RuleState>{
  const state:RuleState & Required<Pick<RuleState,"accounts"|"fees">>={wallet,accounts:{},fees:{}};
  const wanted=new Set<string>([wallet]);
  for(const tx of session.transactions)for(const ix of tx.instructions){
    if([TOKEN_PROGRAM,TOKEN_2022_PROGRAM,"11111111111111111111111111111111","ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"].includes(ix.programAddress))for(const a of ix.accounts)if(a.address)wanted.add(a.address);
  }
  for(const address of wanted)state.accounts[address]=await reader.getAccountInfo(address as Address);
  // Unchecked transfers name no mint: resolve it from the token account's verified bytes.
  for(const raw of Object.values(state.accounts)){
    const token=raw?decodeTokenAccount(raw.owner,raw.data):null;
    if(token&&!Object.hasOwn(state.accounts,token.mint))state.accounts[token.mint]=await reader.getAccountInfo(token.mint as Address);
  }
  if(opts.inventory){
    const tokenAccounts:string[]=[];
    for(const programId of [TOKEN_PROGRAM,TOKEN_2022_PROGRAM]){
      const response=await reader.rpc.call<{value:{pubkey:string;account:RpcAccount}[]}>("getTokenAccountsByOwner",[wallet,{programId},{encoding:"base64",commitment:"confirmed"}]);
      if(!Array.isArray(response?.value))throw new Error("Token inventory is incomplete");
      for(const a of response.value){
        const raw=accountFromRpc(a.pubkey,a.account),token=raw?decodeTokenAccount(raw.owner,raw.data):null;
        if(!raw||raw.owner!==programId||token?.owner!==wallet)throw new Error("Invalid token inventory account");
        state.accounts[a.pubkey]=raw;tokenAccounts.push(a.pubkey);
      }
    }
    state.walletInventory={complete:true,tokenAccounts};
    for(const tx of session.transactions){
      const response=await reader.rpc.call<{value:number|null}>("getFeeForMessage",[toBase64(tx.messageBytes),{commitment:"confirmed"}]);
      if(!Number.isSafeInteger(response?.value)||response.value===null||response.value<0)throw new Error("Exact message fee is unavailable");
      state.fees[tx.index]=BigInt(response.value);
    }
  }
  return state;
}
