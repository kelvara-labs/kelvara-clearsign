import { expect, it } from "vitest";
import { createRpcAccountReader, createRpcClient, type Session } from "../src/index.js";
import { readTokenRuleState } from "../src/rules/read-token-state.js";
import { analyze, byRule, json, sessionOf } from "./rules-helpers.js";
const f=json("packages/core/test/fixtures/rules/e8-localnet.json").cases.find((f:{name:string})=>f.name==='sweep');
it("reads mint/account state via getAccountInfo, both inventories and exact message fee",async()=>{
  const calls:string[]=[];
  const fetchFn:typeof fetch=async(_url,init)=>{
    const {id,method,params}=JSON.parse(String(init?.body));calls.push(method);
    let result;
    if(method==='getAccountInfo')result={value:f.accounts[params[0]]??null};
    else if(method==='getTokenAccountsByOwner')result={value:f.inventory.filter((a:{account:{owner:string}})=>a.account.owner===params[1].programId)};
    else if(method==='getFeeForMessage')result={value:f.fee};
    else throw new Error(`Unexpected ${method}`);
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
  };
  const reader=createRpcAccountReader(createRpcClient({url:'http://localhost:8899',fetch:fetchFn}));
  const s:Session=await sessionOf([f.transaction]);
  const state=await readTokenRuleState(reader,s,f.wallet,{inventory:true});
  expect(calls.filter(c=>c==='getTokenAccountsByOwner')).toHaveLength(2);
  expect(calls).toContain('getAccountInfo');
  expect(byRule(analyze(s,state),'wallet.sweep')[0]?.level).toBe('L4');
});
