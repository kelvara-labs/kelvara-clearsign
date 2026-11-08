// E26: human token text for facts and intent: amounts with decimals, symbols or names instead of mint addresses.
// Display only. The mint stays in evidence (tokenEvidence); without read metadata the text falls back to the
// address and raw units.
import type { RuleState } from "./types.js";
import { decodeMint, decodeTokenAccount } from "../state/layouts.js";
import type { TokenMeta } from "../state/token-meta.js";
import { tokenText, unsigned } from "../util/amounts.js";
import type { ReportBuilder } from "../report/builder.js";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

type HasState = { state: RuleState };

/** Metadata for a mint: the Helius read, else decimals from a mint account already in state. */
export function tokenMeta({ state }: HasState, mint: string | null): TokenMeta | null {
  if (!mint) return null;
  const read = state.tokens?.[mint];
  if (read) return read;
  const raw = state.accounts?.[mint];
  const info = raw && !raw.executable ? decodeMint(raw.owner, raw.data) : null;
  return info ? { mint, symbol: null, name: null, decimals: info.decimals, source: "mint-account" } : null;
}

const shortMint = (m: string): string => `${m.slice(0, 4)}…${m.slice(-4)}`;

/**
 * Symbol, else name, then the mint's short form: anyone can register any ticker (real memecoins on mainnet call
 * themselves "BTC" and "ETH"), so a name alone must never stand in for the token. Wrapped SOL is the one exact mint.
 * Null when no name was read.
 */
export function tokenLabel(meta: TokenMeta | null): string | null {
  if (!meta) return null;
  if (meta.mint === WRAPPED_SOL_MINT) return "SOL (wrapped)";
  const name = meta.symbol ?? meta.name;
  return name ? `${name} (${shortMint(meta.mint)})` : null;
}

export function mintOfTokenAccount({ state }: HasState, account: string | null): string | null {
  if (!account) return null;
  const mapped = state.tokenAccountMints?.[account];
  if (mapped) return mapped;
  const raw = state.accounts?.[account];
  return (raw && !raw.executable ? decodeTokenAccount(raw.owner, raw.data)?.mint : null) ?? null;
}

/** "23.180052 USDC" with a name and decimals; "23.180052 of token mint X" with decimals only; raw units otherwise. */
export function tokenAmountText(ctx: HasState, amount: bigint, mint: string | null): string {
  const meta = tokenMeta(ctx, mint);
  const label = tokenLabel(meta);
  const decimals = meta?.decimals ?? null;
  if (decimals !== null && label) return `${unsigned(tokenText(amount, decimals))} ${label}`;
  if (decimals !== null) return `${unsigned(tokenText(amount, decimals))} of ${mint ? `token mint ${mint}` : "an unread token"}`;
  return `${amount} base units of ${mint ? `token mint ${mint}` : "an unread token"}`;
}

/** One evidence item per mint with read metadata: symbol, name, decimals and where they came from. */
export function tokenEvidence(ctx: HasState & { report: ReportBuilder }, mint: string | null): string | null {
  const meta = tokenMeta(ctx, mint);
  if (!meta) return null;
  const label = tokenLabel(meta);
  return ctx.report.addEvidence({
    type: "derivation",
    source: meta.source === "helius-das" ? "helius" : "rpc",
    address: meta.mint,
    summary: `Token ${label ?? meta.mint}${meta.decimals === null ? "" : ` (${meta.decimals} decimals)`}`,
    data: { kind: "token", mint: meta.mint, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, source: meta.source }
  });
}
