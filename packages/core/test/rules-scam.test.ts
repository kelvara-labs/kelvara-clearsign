import { expect, it } from "vitest";
import { accountFromRpc, type RuleState } from "../src/index.js";
import { analyze, byRule, json, sessionOf } from "./rules-helpers.js";
const cases = json("packages/core/test/fixtures/rules/e8-localnet.json").cases;
const stateOf = (f: typeof cases[number]): RuleState => ({wallet:f.wallet,accounts:Object.fromEntries(Object.entries(f.accounts).map(([a,r])=>[a,accountFromRpc(a,r as Parameters<typeof accountFromRpc>[1])])),fees:{0:BigInt(f.fee)},walletInventory:f.inventory ? {complete:true,tokenAccounts:f.inventory.map((a: {pubkey:string})=>a.pubkey)}:undefined});
for(const [name,id] of [["assign-takeover","system.assign_takeover"],["owner-takeover","token.owner_takeover"],["close-authority-takeover","token.owner_takeover"],["sweep","wallet.sweep"]]) {
  it(`${id} requires wallet identity and real account evidence`,async()=>{
    const f=cases.find((f: {name:string})=>f.name===name), s=await sessionOf([f.transaction]), state=stateOf(f);
    const report=analyze(s,state);
    expect(byRule(report,id!)[0]?.level).toBe("L4");
    if(name!=="close-authority-takeover") expect(byRule(report,id!)[0]?.dependsOn).toContain(byRule(report,"lifetime.durable_nonce")[0]?.id);
    expect(byRule(analyze(s,{...state,wallet:undefined}),id!)).toEqual([]);
    expect(byRule(analyze(s,{...state,accounts:{}}),id!)).toEqual([]);
    const benign=cases.find((f: {name:string})=>f.name==="benign-partial-send");
    expect(byRule(analyze(await sessionOf([benign.transaction]),stateOf(benign)),id!)).toEqual([]);
  });
}
it("wallet.sweep refuses incomplete inventory, wrong fee, unresolved recipient and retained assets",async()=>{
  const f=cases.find((f: {name:string})=>f.name==='sweep'),s=await sessionOf([f.transaction]),state=stateOf(f);
  const changes: RuleState[] = [{...state,walletInventory:{...state.walletInventory!,complete:false}},{...state,fees:{}},{...state,fees:{0:0n}},{...state,walletInventory:{complete:true,tokenAccounts:[...state.walletInventory!.tokenAccounts,f.wallet]}}];
  for(const changed of changes){
    expect(byRule(analyze(s,changed),"wallet.sweep")).toEqual([]);
  }
});
