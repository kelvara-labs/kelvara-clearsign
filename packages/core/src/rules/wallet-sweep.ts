import { SYSTEM_PROGRAM, decodeTokenAccount } from "../state/layouts.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { SimulationResult } from "../simulate/index.js";
import { isToken } from "./authority-transfer.js";
import { accountNamed, instructionEvidence, txSigners } from "./common.js";
import { accountEvidence, tokenAccount } from "./token-state.js";
import { arg } from "./squads-session.js";
import type { Rule, RuleContext } from "./types.js";

// wallet.sweep: a Fact L4 only from reads (complete inventory, exact fee) plus either
//  (a) the exact message: plain SOL/token transfers whose amounts equal the read balances (no simulation), or
//  (b) the simulated outcome (E16): the wallet ends with no more than the fee, every inventory token balance
//      leaves the wallet (transferred, or the account handed over), every account that gains lamports or tokens
//      belongs to ONE destination that is neither the wallet nor a session signer, and the destination receives
//      everything the wallet and its token accounts lose except the fee. This covers the real drainer shape:
//      ATA CreateIdempotent for the destination (rent paid by the user) + TransferChecked(all) + CloseAccount
//      (user ATA -> destination), then SOL minus fee and rent. Instructions are not allow-listed here; the
//      outcome decides, so any value coming back to the wallet or a co-signing destination keeps it below L4.
// Each transaction is judged on its own (reads and its own simulation are pre-session state), so only a
// transaction no other session transaction can change qualifies: no other transaction takes the wallet or
// an inventory account writable. Another, unrelated transaction in the session never hides a sweep.
const MEMO = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];

export const walletSweepRule: Rule = {
  id: "wallet.sweep", ruleIds: ["wallet.sweep"],
  description: "The wallet's complete SOL and token inventory goes to one non-signing destination: exact message amounts, or the simulated outcome; no heuristic percentages.",
  run(ctx) {
    const wallet = ctx.state.wallet, inventory = ctx.state.walletInventory;
    if (!wallet || !inventory?.complete) return;
    const watched = new Set([wallet, ...inventory.tokenAccounts]);
    const writes = ctx.session.transactions.map((t) => !t.complete || t.accounts.some((a) => a.writable && (!a.address || watched.has(a.address))));
    for (const tx of ctx.session.transactions) {
      const t = tx.index, fee = ctx.state.fees?.[t];
      if (!tx.complete || !txSigners(tx).includes(wallet) || fee === undefined || fee < 0n) continue;
      // Sequential balances are never guessed: another transaction that may change the wallet's holdings rules it out.
      if (writes.some((w, i) => w && i !== t)) continue;
      if (!simulatedSweep(ctx, t, wallet, inventory.tokenAccounts, fee)) exactSweep(ctx, t, wallet, inventory.tokenAccounts, fee);
    }
  }
};

function nonceDeps(ctx: RuleContext, t: number): string[] {
  return ctx.claims.has(`nonce:${t}`) ? [ctx.claims.get(`nonce:${t}`)!] : [];
}

/** (a) Exact message amounts against read balances; the wallet pays the fee. */
function exactSweep(ctx: RuleContext, t: number, wallet: string, tokenAccounts: string[], fee: bigint): void {
  const raw = ctx.state.accounts?.[wallet], tx = ctx.session.transactions[t]!, ixs = ctx.decoded[t] ?? [];
  if (!raw || raw.owner !== SYSTEM_PROGRAM || raw.data.length || tx.accounts[0]?.address !== wallet) return;
  const signers = new Set(txSigners(tx));
  let sol = 0n, recipient: string | null = null;
  const spent = new Map<string, bigint>(), evidence: string[] = [];
  for (const ix of ixs) {
    if (ix.programAddress === "ComputeBudget111111111111111111111111111111" || MEMO.includes(ix.programAddress) || (ix.programAddress === SYSTEM_PROGRAM && ix.name === "advanceNonceAccount")) continue;
    const amount = arg(ix, "amount");
    let to: string | null = null;
    if (ix.programAddress === SYSTEM_PROGRAM && ix.name === "transferSol" && accountNamed(ix, "source") === wallet && typeof amount === "bigint" && amount > 0n) {
      sol += amount; to = accountNamed(ix, "destination");
    } else if (isToken(ix) && ["transfer", "transferChecked"].includes(ix.name ?? "") && typeof amount === "bigint" && amount > 0n) {
      const source = accountNamed(ix, "source"), dest = accountNamed(ix, "destination"), from = tokenAccount(ctx, source), target = tokenAccount(ctx, dest);
      if (!source || !dest || !from || !target || ctx.state.accounts?.[source]?.owner !== ix.programAddress || ctx.state.accounts?.[dest]?.owner !== ix.programAddress || from.owner !== wallet || from.mint !== target.mint || accountNamed(ix, "authority") !== wallet || !tokenAccounts.includes(source)) return;
      spent.set(source, (spent.get(source) ?? 0n) + amount); to = target.owner;
      evidence.push(accountEvidence(ctx, source), accountEvidence(ctx, dest));
    } else return;
    if (!to || to === wallet || signers.has(to) || (recipient !== null && recipient !== to)) return;
    recipient = to; evidence.push(instructionEvidence(ctx, t, ix));
  }
  if (!recipient || sol <= 0n || sol + fee !== raw.lamports) return;
  for (const address of tokenAccounts) {
    const acc = tokenAccount(ctx, address);
    if (!acc || acc.owner !== wallet || acc.amount !== (spent.get(address) ?? 0n)) return;
    evidence.push(accountEvidence(ctx, address));
  }
  evidence.push(accountEvidence(ctx, wallet), ctx.report.addEvidence({ type: "account", source: "rpc", summary: "Complete inventory from both token programs and exact message fee", data: { wallet, inventory: ctx.state.walletInventory, fee } }));
  ctx.report.addClaim({ kind: "Fact", ruleId: "wallet.sweep", level: "L4", statement: `All wallet SOL (${sol} lamports after ${fee} fee) and every token balance are sent to non-signing recipient ${recipient}.`, evidenceIds: evidence, dependsOn: nonceDeps(ctx, t), transactionIndices: [t] });
}

/** Token account state after simulation: decoded post data, else the simulated token change, else the pre read. */
function postTokenOwner(ctx: RuleContext, sim: SimulationResult, address: string): string | null {
  const acc = sim.accounts.find((a) => a.address === address);
  if (acc?.post) {
    const t = decodeTokenAccount(acc.post.owner, acc.post.data);
    return t ? t.owner : null;
  }
  if (acc && acc.post === null && acc.pre !== null) return null; // closed
  const change = sim.tokenChanges.find((c) => c.account === address);
  if (change) return change.owner;
  return tokenAccount(ctx, address)?.owner ?? null;
}

/** (b) Simulated outcome. Returns true when it made the claim. */
function simulatedSweep(ctx: RuleContext, t: number, wallet: string, tokenAccounts: string[], fee: bigint): boolean {
  const sim = ctx.state.simulations?.[t], tx = ctx.session.transactions[t]!;
  // Unknown changes (omitted accounts) are not zero; a failed simulation proves nothing.
  if (!sim || !sim.ok || sim.accountsOmitted.length || !sim.solChanges.length) return false;
  const walletFee = tx.accounts[0]?.address === wallet ? fee : 0n;
  const w = sim.solChanges.find((c) => c.address === wallet);
  // ~0 left: nothing beyond the fee (a system account cannot end between 0 and rent-exempt, so this is 0 in practice).
  if (!w || w.post > walletFee || w.pre <= walletFee) return false;
  const inv = new Set(tokenAccounts), destinations = new Set<string>();
  let lost = w.pre - w.post, received = 0n;
  const movedMints: string[] = [];
  for (const address of tokenAccounts) {
    const change = sim.tokenChanges.find((c) => c.account === address);
    const before = change?.pre ?? tokenAccount(ctx, address)?.amount;
    if (before === undefined) return false; // balance not read: cannot prove it left
    const handover = sim.stateChanges.find((c) => c.address === address && c.field === "tokenOwner" && c.after !== null && c.after !== wallet);
    if (handover) { destinations.add(handover.after!); if (before > 0n) movedMints.push(address); continue; }
    if ((change ? change.post : before) > 0n) return false; // the user keeps a token balance
    if (before > 0n) movedMints.push(address);
  }
  // Every gain belongs to the destination; nothing comes back to the wallet.
  for (const c of sim.tokenChanges) {
    if (c.delta <= 0n) continue;
    if (c.owner === wallet || inv.has(c.account)) return false;
    destinations.add(c.owner);
  }
  for (const c of sim.solChanges) {
    if (c.address === wallet) continue;
    if (inv.has(c.address)) { if (c.delta < 0n) lost += -c.delta; else return false; continue; }
    if (c.delta <= 0n) continue;
    const owner = sim.tokenChanges.some((t) => t.account === c.address) || sim.accounts.some((a) => a.address === c.address && a.post && decodeTokenAccount(a.post.owner, a.post.data)) ? postTokenOwner(ctx, sim, c.address) : c.address;
    if (!owner || owner === wallet) return false;
    destinations.add(owner); received += c.delta;
  }
  const signers = new Set(txSigners(tx));
  if (destinations.size !== 1) return false;
  const [destination] = [...destinations] as [string];
  if (destination === wallet || signers.has(destination) || inv.has(destination)) return false;
  // The destination gets everything the wallet and its token accounts lose, except the fee.
  if (received + walletFee < lost) return false;
  const evidence: string[] = [ctx.report.addEvidence({ type: "simulation", source: "simulation", address: wallet, summary: `Simulation: wallet ${wallet} goes from ${w.pre} to ${w.post} lamports (fee ${walletFee}); destination ${destination} gains ${received} lamports and every token balance`, data: { wallet: { pre: w.pre, post: w.post }, destination, received, lost, fee: walletFee, solChanges: sim.solChanges, tokenChanges: sim.tokenChanges.filter((t) => inv.has(t.account) || t.owner === destination), blockhashReplaced: sim.blockhashReplaced } })];
  for (const ix of ctx.decoded[t] ?? []) if (!skippable(ix)) evidence.push(instructionEvidence(ctx, t, ix));
  for (const address of tokenAccounts) if (ctx.state.accounts?.[address]) evidence.push(accountEvidence(ctx, address));
  if (ctx.state.accounts?.[wallet]) evidence.push(accountEvidence(ctx, wallet));
  evidence.push(ctx.report.addEvidence({ type: "account", source: "rpc", summary: "Complete inventory from both token programs and exact message fee", data: { wallet, inventory: ctx.state.walletInventory, fee } }));
  const tokens = movedMints.length;
  ctx.report.addClaim({ kind: "Fact", ruleId: "wallet.sweep", level: "L4", statement: `Simulation shows the wallet emptied: ${lost - walletFee} lamports (all but the ${walletFee} fee, including token account rent) and all ${tokens} token balance${tokens === 1 ? "" : "s"} go to non-signing destination ${destination}.`, evidenceIds: evidence, dependsOn: nonceDeps(ctx, t), transactionIndices: [t] });
  return true;
}

function skippable(ix: DecodedInstruction): boolean {
  return ix.programAddress === "ComputeBudget111111111111111111111111111111" || MEMO.includes(ix.programAddress);
}
