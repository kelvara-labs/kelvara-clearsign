// Token names from the engine's token evidence ({mint, symbol, name, decimals, source}); no hard-coded mint map.
// A token without metadata is "token EPjF…Dt1v" and its raw amount is labelled "base units". Pure.
import type { Evidence, Report } from "@kelvara/core";
import type { IntentContext } from "@kelvara/core/intent-schema";

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

export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/** The engine's own display name for a token with metadata ("USDC (EPjF…Dt1v)", "SOL (wrapped)"); null without a name. */
export function engineTag(meta: TokenMeta | undefined): string | null {
  if (!meta) return null;
  if (meta.mint === WRAPPED_SOL) return "SOL (wrapped)";
  const n = meta.symbol ?? meta.name;
  return n ? `${n} (${shortMint(meta.mint)})` : null;
}

/**
 * One label per mint: the symbol alone when it is unique in this report, else the engine's tag with the short
 * mint ("BTC (C5xp…pump)", real memecoins reuse tickers), or "token EPjF…Dt1v" without metadata. A name without a
 * symbol never stands alone. The full mint is shown on hover.
 */
export function tokenLabels(mints: Set<string>, metas: Map<string, TokenMeta>): Map<string, string> {
  const symbolOf = (m: string): string | null => (m === WRAPPED_SOL ? "SOL (wrapped)" : metas.get(m)?.symbol ?? null);
  const count = new Map<string, number>();
  for (const m of mints) { const s = symbolOf(m); if (s) count.set(s, (count.get(s) ?? 0) + 1); }
  return new Map([...mints].map((m) => {
    const s = symbolOf(m);
    return [m, s && count.get(s) === 1 ? s : engineTag(metas.get(m)) ?? `token ${shortMint(m)}`];
  }));
}

/** engine tag -> label, for stripping the short mint from the engine's text when the symbol is unique. */
export function tagLabels(labels: Map<string, string>, metas: Map<string, TokenMeta>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [m, l] of labels) { const t = engineTag(metas.get(m)); if (t && t !== l) out.set(t, l); }
  return out;
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

/** The intent question and reasons in the same token words as the rest of the report (display text only). */
export function relabelIntent(context: IntentContext, r: Report): IntentContext {
  const metas = tokenMetas(r), labels = tokenLabels(reportMints(r, metas), metas), tags = tagLabels(labels, metas);
  const t = (s: string, max: number): string => relabel(s, labels, tags).slice(0, max);
  return { ...context, candidates: context.candidates.map((c) => ({ ...c, question: t(c.question, 300), reasons: c.reasons.map((x) => ({ ...x, text: t(x.text, 600) })) })) };
}

/** Replace every full mint address (and the engine's short tag, when the symbol is unique) with the label. */
export function relabel(text: string, labels: Map<string, string>, tags: Map<string, string> = new Map()): string {
  let out = text;
  for (const [m, l] of labels) {
    if (out.includes(`token mint ${m}`)) out = out.split(`token mint ${m}`).join(l);
    if (out.includes(m)) out = out.split(m).join(l);
  }
  for (const [t, l] of tags) if (out.includes(t)) out = out.split(t).join(l);
  return out;
}
