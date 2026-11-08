// Token names from the engine's token evidence ({mint, symbol, name, decimals, source}); no hard-coded mint map.
// A token without metadata is "token EPjF…Dt1v" and its raw amount is labelled "base units". Pure.
import type { Evidence, Report } from "@kelvara/core";

export interface TokenMeta { mint: string; symbol: string | null; name: string | null; decimals: number | null }

const record = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const shortMint = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

function fromData(d: Record<string, unknown>, into: Map<string, TokenMeta>): void {
  if (typeof d.mint !== "string" || !B58.test(d.mint) || "delta" in d) return;
  const symbol = typeof d.symbol === "string" && d.symbol.trim() && d.symbol.length <= 24 && ![...d.symbol].some((c) => c.charCodeAt(0) < 32) ? d.symbol.trim() : null;
  const decimals = Number.isInteger(d.decimals) && (d.decimals as number) >= 0 && (d.decimals as number) <= 36 ? (d.decimals as number) : null;
  if (symbol === null && decimals === null) return;
  const prev = into.get(d.mint);
  into.set(d.mint, { mint: d.mint, symbol: symbol ?? prev?.symbol ?? null, name: typeof d.name === "string" && d.name.length <= 80 ? d.name : prev?.name ?? null, decimals: decimals ?? prev?.decimals ?? null });
}

/** Token metadata the engine put in evidence (data itself, or data.tokens[]), by mint. */
export function tokenMetas(r: Report): Map<string, TokenMeta> {
  const out = new Map<string, TokenMeta>();
  for (const e of r.evidence as Evidence[]) {
    const d = record(e.data);
    fromData(d, out);
    if (Array.isArray(d.tokens)) for (const t of d.tokens) fromData(record(t), out);
  }
  return out;
}

/** Every mint the report talks about: with metadata, in simulation token changes, or as an instruction's mint account. */
export function reportMints(r: Report, metas: Map<string, TokenMeta>): Set<string> {
  const mints = new Set(metas.keys());
  for (const e of r.evidence) {
    const d = record(e.data);
    for (const c of Array.isArray(d.tokenChanges) ? d.tokenChanges : []) if (typeof record(c).mint === "string") mints.add(record(c).mint as string);
    for (const a of Array.isArray(d.accounts) ? d.accounts : []) if (record(a).name === "mint" && typeof record(a).address === "string") mints.add(record(a).address as string);
    if (e.type === "instruction" && typeof record(d.args).mint === "string") mints.add(record(d.args).mint as string);
  }
  return new Set([...mints].filter((m) => B58.test(m)));
}

/** One label per mint: the symbol, or "token EPjF…Dt1v"; two mints with one symbol are told apart by their short id. */
export function tokenLabels(mints: Set<string>, metas: Map<string, TokenMeta>): Map<string, string> {
  const base = new Map<string, string>();
  for (const m of mints) {
    const s = metas.get(m)?.symbol;
    base.set(m, s ? (s === "SOL" ? "wSOL" : s) : `token ${shortMint(m)}`);
  }
  const count = new Map<string, number>();
  for (const l of base.values()) count.set(l, (count.get(l) ?? 0) + 1);
  return new Map([...base].map(([m, l]) => [m, (count.get(l) ?? 0) > 1 ? `${l} ${shortMint(m)}` : l]));
}

/** Raw base units as decimal text, or null when decimals are unknown. */
export function decimalAmount(raw: unknown, decimals: number | null | undefined): string | null {
  if (decimals === null || decimals === undefined) return null;
  try {
    const a = BigInt(raw as string);
    const neg = a < 0n, abs = neg ? -a : a, base = 10n ** BigInt(decimals);
    const frac = decimals ? (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
    return `${neg ? "−" : ""}${(abs / base).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
  } catch {
    return null;
  }
}

/** "23.180052 USDC", or "23180052 base units of token EPjF…Dt1v" without metadata. */
export function tokenAmountText(raw: unknown, mint: string, metas: Map<string, TokenMeta>, labels: Map<string, string>, decimalsHint?: unknown): string | null {
  const decimals = metas.get(mint)?.decimals ?? (Number.isInteger(decimalsHint) ? (decimalsHint as number) : null);
  const label = labels.get(mint) ?? `token ${shortMint(mint)}`;
  const human = decimalAmount(raw, decimals);
  if (human !== null) return `${human} ${label}`;
  try { return `${BigInt(raw as string).toString()} base units of ${label.startsWith("token ") ? label : `${label} (decimals unknown)`}`; } catch { return null; }
}

/** Replace every full mint address in a text with its label. */
export function relabel(text: string, labels: Map<string, string>): string {
  let out = text;
  for (const [m, l] of labels) if (out.includes(m)) out = out.split(m).join(l);
  return out;
}
