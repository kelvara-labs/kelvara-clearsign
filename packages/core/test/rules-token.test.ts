/* eslint-disable @typescript-eslint/no-explicit-any -- recorded RPC responses */
import { expect, it } from "vitest";
import { recipient } from "../src/rules/token-state.js";
import { accountFromRpc, type RuleState } from "../src/index.js";
import { analyze, byRule, decoder, json, sessionOf } from "./rules-helpers.js";
const cases = json<{ cases: any[] }>("packages/core/test/fixtures/rules/e8-localnet.json").cases;
export const e8Cases = cases;
export function e8State(f: any): RuleState {
  return { wallet: f.wallet, accounts: Object.fromEntries(Object.entries(f.accounts).map(([a,r]) => [a,accountFromRpc(a,r as any)])), fees: { 0: BigInt(f.fee) }, walletInventory: f.inventory ? { complete: f.inventoryComplete, tokenAccounts: f.inventory.map((a: any) => a.pubkey) } : undefined };
}
it("delegate grant names exact delegate and raw amount; near-max ranks higher; revoke names the lost power", async () => {
  const reports = [];
  for (const name of ["approve-bounded","approve-unlimited","revoke"]) {
    const f = cases.find(f => f.name === name); reports.push(analyze(await sessionOf([f.transaction]),e8State(f)));
  }
  const [bounded,unlimited,revoke] = reports;
  expect(byRule(bounded!,"token.delegate_granted")[0]?.statement).toContain("25 base units");
  expect(bounded!.capabilities.granted[0]?.class).toBe("bounded_spend");
  expect(byRule(unlimited!,"token.delegate_granted")[0]?.statement).toContain("18446744073709551615");
  expect(unlimited!.capabilities.granted[0]?.class).toBe("fund_movement");
  expect(byRule(revoke!,"token.delegate_revoked")[0]?.level).toBe("L1");
  expect(revoke!.capabilities.revoked[0]?.holder).toBe(unlimited!.capabilities.granted[0]?.holder);
  expect(byRule(revoke!,"token.delegate_granted")).toEqual([]);
  expect(byRule(bounded!,"token.delegate_revoked")).toEqual([]);
});
for (const [name,id] of [["permanent","token2022.permanent_delegate"],["freeze","token.freeze_authority"],["hook","token2022.transfer_hook"],["frozen","token2022.default_frozen"],["nontransferable","token2022.non_transferable"]]) {
  it(`${id} reads real mint bytes and stays silent on the plain mint`, async () => {
    const f = cases.find(f=>f.name===`receive-${name}`);
    const r = analyze(await sessionOf([f.transaction]),e8State(f));
    expect(byRule(r,id!)[0]?.level).toBe("L2");
    const plain = cases.find(f=>f.name==='receive-plain');
    expect(byRule(analyze(await sessionOf([plain.transaction]),e8State(plain)),id!)).toEqual([]);
    expect(r.alert.level).not.toBe("L4");
  });
}
it("real trap purchase resolves a newly created recipient ATA without trusting a dApp label", async () => {
  const fixture = json("fixtures/tx/localnet/trap/5dH35ADAXRoXC9tCGYnDaqLRsTEctKPTFTVGv5pMMfUhq4oEs1YSwGqPfK3WGBecux3ggLsxmBKpoFJE1bhGfrfh.json");
  const s = await sessionOf([fixture.transaction]);
  const decoded = decoder.decodeSession(s)[0]!;
  const ata = decoded.find(ix => ix.programAddress === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")!;
  const mint = ata.accounts[3]!.address!;
  const wallet = ata.accounts[2]!.address!;
  const report = analyze(s, {wallet, accounts: {}});
  // This archived purchase predates the state recording: labels are not mint evidence.
  expect(byRule(report,"token2022.permanent_delegate")).toEqual([]);
  expect(byRule(report,"token.freeze_authority")).toEqual([]);
  const { ReportBuilder } = await import("../src/index.js");
  const ctx = {session:s, decoded:[decoded], state:{wallet}, claims:new Map(), report:new ReportBuilder(s)};
  expect(recipient(ctx,0,ata.accounts[1]!.address!)).toEqual({owner:wallet,mint});
});
