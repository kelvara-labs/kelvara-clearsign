// "What simulation shows" as net totals for the user: every SOL change plus wrapped-SOL token changes become one
// SOL line, token changes are summed per mint across the user's token accounts, and assets that net to zero
// (route hops, temporary wSOL accounts, closed accounts) are dropped. Other owners are netted per owner and asset.
// Numbers come only from the simulation evidence; nothing is estimated. Pure.
import type { Report } from "@kelvara/core";
import { shortMint, type TokenMeta } from "./tokens.js";

const WSOL = "So11111111111111111111111111111111111111112";
const record = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const big = (v: unknown): bigint | null => { try { return typeof v === "bigint" ? v : typeof v === "string" || typeof v === "number" ? BigInt(v) : null; } catch { return null; } };

function decimalText(raw: bigint, decimals: number): string {
  const neg = raw < 0n, a = neg ? -raw : raw, base = 10n ** BigInt(decimals);
  const frac = decimals ? (a % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${neg ? "−" : "+"}${(a / base).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export interface NetBalances { balances: string[]; other: string[] }

/** null when the report has no simulation data or no known user (the caller then lists changes per account). */
export function netBalances(r: Report, payer: string | null, metas: Map<string, TokenMeta>, labels: Map<string, string>, feeLine: string | null): NetBalances | null {
  if (!payer) return null;
  let sawSim = false;
  let userSol = 0n;
  const userTok = new Map<string, bigint>();
  const decimals = new Map<string, number | null>();
  const others = new Map<string, Map<string, bigint>>();
  const newAccounts = new Set<string>();
  const solByAddress = new Map<string, bigint>();
  const bump = (owner: string, asset: string, delta: bigint) => {
    if (owner === payer) return;
    const m = others.get(owner) ?? new Map<string, bigint>();
    m.set(asset, (m.get(asset) ?? 0n) + delta);
    others.set(owner, m);
  };
  for (const e of r.evidence) {
    if (e.type !== "simulation") continue;
    const d = record(e.data);
    sawSim = true;
    for (const c of Array.isArray(d.solChanges) ? d.solChanges : []) {
      const x = record(c), delta = big(x.delta);
      if (typeof x.address !== "string" || delta === null) continue;
      solByAddress.set(x.address, (solByAddress.get(x.address) ?? 0n) + delta);
      if (x.address === payer) userSol += delta;
      else bump(x.address, "SOL", delta);
    }
    for (const c of Array.isArray(d.tokenChanges) ? d.tokenChanges : []) {
      const x = record(c), delta = big(x.delta);
      if (typeof x.owner !== "string" || typeof x.mint !== "string" || delta === null) continue;
      if (x.mint === WSOL) {
        if (x.owner === payer) userSol += delta;
        else bump(x.owner, "SOL", delta);
        continue;
      }
      if (typeof x.decimals === "number") decimals.set(x.mint, x.decimals);
      if (x.owner === payer) userTok.set(x.mint, (userTok.get(x.mint) ?? 0n) + delta);
      else bump(x.owner, x.mint, delta);
    }
    for (const c of Array.isArray(d.stateChanges) ? d.stateChanges : []) {
      const x = record(c);
      if (typeof x.address === "string" && x.field === "owner" && (x.before === null || x.before === undefined) && x.after !== "11111111111111111111111111111111") newAccounts.add(x.address);
    }
  }
  if (!sawSim) return null;
  const tokText = (mint: string, delta: bigint): string => {
    const dec = metas.get(mint)?.decimals ?? decimals.get(mint) ?? null;
    const label = labels.get(mint) ?? `token ${shortMint(mint)}`;
    return dec === null ? `${delta < 0n ? "−" : "+"}${(delta < 0n ? -delta : delta).toString()} base units of ${label}` : `${decimalText(delta, dec)} ${label}`;
  };
  const rent = [...newAccounts].reduce((a, k) => a + ((solByAddress.get(k) ?? 0n) > 0n ? solByAddress.get(k)! : 0n), 0n);
  const solShown = userSol + rent;
  const rentShown = rent;
  const out: string[] = [];
  for (const [mint, delta] of userTok) if (delta < 0n) out.push(`You send · ${tokText(mint, delta)}`);
  if (solShown < 0n) out.push(`You send · ${decimalText(solShown, 9)} SOL (includes fees)`);
  for (const [mint, delta] of userTok) if (delta > 0n) out.push(`You receive · ${tokText(mint, delta)}`);
  if (solShown > 0n) out.push(`You receive · ${decimalText(solShown, 9)} SOL${feeLine ? " (after fees)" : ""}`);
  if (feeLine) out.push(`Fees · ${feeLine.replace(/^Fees: /, "").replace(/\.$/, "")}`);
  if (rentShown > 0n) out.push(`Account rent · ${decimalText(-rentShown, 9)} SOL`);
  const other: string[] = [];
  for (const [owner, assets] of others) {
    for (const [asset, delta] of assets) {
      if (delta === 0n) continue;
      other.push(`${owner.length > 12 ? `${owner.slice(0, 4)}…${owner.slice(-4)}` : owner} · ${asset === "SOL" ? `${decimalText(delta, 9)} SOL` : tokText(asset, delta)}`);
    }
  }
  return { balances: out.slice(0, 32), other: other.slice(0, 32) };
}
