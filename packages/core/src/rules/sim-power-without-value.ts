// sim.power_without_value (PLAN M2 3c): simulation shows no balance change (only the fee), or only
// the expected purchase, while the transaction grants a power to a key outside the session. A balance
// preview cannot show that power, so the report says so in plain words. This is the demo's line.
import { lamportsText, tokenText, unsigned } from "../util/amounts.js";
import type { SimulationResult } from "../simulate/index.js";
import { grantText, outsideGrants } from "./session-links.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "sim.power_without_value";

type Shape = { kind: "none"; fee: bigint | null } | { kind: "purchase"; pays: string; gets: string[] };

/** Only the fee payer's SOL goes down, nothing else moves: no value changes hands. */
function feeOnly(s: SimulationResult, feePayer: string): Shape | null {
  if (s.tokenChanges.length) return null;
  if (s.solChanges.some((c) => c.address !== feePayer || c.delta > 0n)) return null;
  const fee = s.solChanges.find((c) => c.address === feePayer)?.delta ?? null;
  return { kind: "none", fee: fee === null ? null : -fee };
}

/**
 * The connected wallet pays in exactly one asset and receives others; no account outside the wallet
 * gains a token (counterparties may receive SOL and send tokens). New accounts that simulation shows
 * becoming the wallet's token accounts count as the wallet's (their rent is part of the purchase).
 */
function purchase(s: SimulationResult, wallet: string): Shape | null {
  const own = new Set([wallet, ...s.stateChanges.filter((c) => c.field === "tokenOwner" && c.after === wallet).map((c) => c.address)]);
  const sol = s.solChanges.filter((c) => own.has(c.address)).reduce((a, c) => a + c.delta, 0n);
  const tokens = new Map<string, { delta: bigint; decimals: number | null }>();
  for (const c of s.tokenChanges) {
    if (c.owner !== wallet) {
      if (c.delta > 0n) return null;
      continue;
    }
    const t = tokens.get(c.mint) ?? { delta: 0n, decimals: c.decimals };
    t.delta += c.delta;
    tokens.set(c.mint, t);
  }
  const out: string[] = [], inn: string[] = [];
  if (sol < 0n) out.push(unsigned(lamportsText(sol)));
  if (sol > 0n) inn.push(unsigned(lamportsText(sol)));
  for (const [mint, t] of tokens) {
    if (t.delta < 0n) out.push(`${unsigned(tokenText(t.delta, t.decimals))} of mint ${mint}`);
    if (t.delta > 0n) inn.push(`${unsigned(tokenText(t.delta, t.decimals))} of mint ${mint}`);
  }
  if (out.length !== 1 || !inn.length) return null;
  return { kind: "purchase", pays: out[0]!, gets: inn };
}

export const simPowerWithoutValueRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Simulation shows no value moving (or a plain purchase) while the transaction grants a power",
  run(ctx: RuleContext) {
    const sims = ctx.state.simulations;
    if (!sims) return;
    const grants = outsideGrants(ctx);
    for (const tx of ctx.session.transactions) {
      const s = sims[tx.index];
      // A failed simulation or unread accounts cannot show that nothing moves.
      if (!s || !s.ok || s.accountsOmitted.length) continue;
      const mine = grants.filter((g) => g.txs.includes(tx.index));
      if (!mine.length) continue;
      const feePayer = tx.accounts[0]?.address;
      if (!feePayer) continue;
      const shape = feeOnly(s, feePayer) ?? (ctx.state.wallet ? purchase(s, ctx.state.wallet) : null);
      if (!shape) continue;
      const shows =
        shape.kind === "none"
          ? `Simulation of transaction ${tx.index} shows no value moving: ${shape.fee !== null ? `only the ${unsigned(lamportsText(shape.fee))} fee leaves the fee payer` : "no balance changes at all"}, 0 tokens move`
          : `Simulation of transaction ${tx.index} shows only a normal purchase: your wallet pays ${shape.pays} and receives ${shape.gets.join(" and ")}`;
      const evidence = ctx.report.addEvidence({
        type: "simulation",
        source: "simulation",
        transactionIndex: tx.index,
        summary: `simulated balance changes of transaction ${tx.index}`,
        data: { ok: s.ok, blockhashReplaced: s.blockhashReplaced, solChanges: s.solChanges, tokenChanges: s.tokenChanges, stateChanges: s.stateChanges, accountsOmitted: s.accountsOmitted }
      });
      ctx.report.addClaim({
        kind: "Derived",
        ruleId: RULE_ID,
        level: "L1",
        statement: `${shows}. Yet it carries ${mine.map(grantText).join("; ")}. That power is not a balance change, so a balance preview cannot show it: the risk is the power, not the amount.`,
        evidenceIds: [evidence],
        dependsOn: [...new Set(mine.map((g) => g.cap.claimId))],
        assumptions: s.blockhashReplaced ? ["Simulated with a replaced recent blockhash."] : [],
        transactionIndices: [tx.index]
      });
    }
  }
};
