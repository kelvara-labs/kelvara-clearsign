/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON is untyped */
// E16: the S9 devnet "claim airdrop" sweep (fixtures/tx/devnet/sweep, e2e l4-sweep) as a request case: the
// unsigned bytes the page asked the user to sign (request.transactionUnsigned, rebuilt=false, so the same message
// that later landed) with the state the extension would have: the wallet, its complete inventory, the exact fee
// (request.fee) and the pre-execution simulation. The scenario simulated before submitting and recorded only its
// summary (request.simulation: per-account lamport deltas and token results); the full balances come from the
// executed transaction's meta (pre/postBalances, pre/postTokenBalances), which the test checks agree with that
// summary. Nothing is invented: every number is either the request's own simulation or the runtime's meta.
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type RuleState, type Session, type SimulationResult } from "../src/index.js";
import { json, sessionOf } from "./rules-helpers.js";

export const S9_PATH = "fixtures/tx/devnet/sweep/4YR1FAkJN1YfDoZJmbQjJeMnQyqt9SRQYfmKT6gg2QQLqMzrKskTYrT86xxceT4AZcnszQdEaQU9n656vahMCrsR.json";

export async function s9SweepCase(): Promise<{ session: Session; state: RuleState; fx: any; keys: string[] }> {
  const fx = json(S9_PATH);
  const session = await sessionOf([fx.request.transactionUnsigned]);
  const keys = session.transactions[0]!.accounts.map((a) => a.address as string);
  const m = fx.meta;
  const solChanges = keys.map((address, i) => ({ address, pre: BigInt(m.preBalances[i]), post: BigInt(m.postBalances[i]), delta: BigInt(m.postBalances[i]) - BigInt(m.preBalances[i]) })).filter((c) => c.delta !== 0n);
  const idx = new Set<number>([...m.preTokenBalances, ...m.postTokenBalances].map((b: any) => b.accountIndex));
  const tokenChanges = [...idx].map((i) => {
    const pre = m.preTokenBalances.find((b: any) => b.accountIndex === i), post = m.postTokenBalances.find((b: any) => b.accountIndex === i), ref = post ?? pre;
    const a = BigInt(pre?.uiTokenAmount.amount ?? 0), b = BigInt(post?.uiTokenAmount.amount ?? 0);
    return { account: keys[i]!, mint: ref.mint, owner: ref.owner, program: ref.programId === TOKEN_2022_PROGRAM ? "token-2022" as const : "token" as const, decimals: ref.uiTokenAmount.decimals, pre: a, post: b, delta: b - a };
  });
  if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(m.preTokenBalances[0].programId)) throw new Error("unexpected token program");
  const sim: SimulationResult = {
    ok: fx.request.simulation.err === null, err: fx.request.simulation.err, logs: m.logMessages, unitsConsumed: fx.request.simulation.unitsConsumed, slot: null, blockhashReplaced: false,
    innerInstructions: [], accounts: [], accountsOmitted: [], solChanges, tokenChanges, stateChanges: []
  };
  const inventory = m.preTokenBalances.filter((b: any) => b.owner === fx.request.user).map((b: any) => keys[b.accountIndex]!);
  return { session, fx, keys, state: { wallet: fx.request.user, fees: { 0: BigInt(fx.request.fee) }, walletInventory: { complete: true, tokenAccounts: inventory }, simulations: { 0: sim } } };
}
