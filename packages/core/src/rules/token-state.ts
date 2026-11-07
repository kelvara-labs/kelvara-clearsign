import { decodeMint, decodeTokenAccount, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../state/layouts.js";
import type { RuleContext } from "./types.js";
import { accountNamed } from "./common.js";

export function tokenAccount(ctx: RuleContext, address: string | null) {
  const raw = address ? ctx.state.accounts?.[address] : null;
  return raw && !raw.executable ? decodeTokenAccount(raw.owner, raw.data) : null;
}
export function mintAccount(ctx: RuleContext, address: string | null) {
  const raw = address ? ctx.state.accounts?.[address] : null;
  return raw && !raw.executable ? decodeMint(raw.owner, raw.data) : null;
}
export function accountEvidence(ctx: RuleContext, address: string): string {
  const raw = ctx.state.accounts?.[address];
  return ctx.report.addEvidence({ type: "account", source: "rpc", address, summary: `Account snapshot ${address}`, data: raw });
}
/** Existing token account or canonical ATA creation in the exact message. No dApp metadata. */
export function recipient(ctx: RuleContext, txIndex: number, address: string | null): { owner: string; mint: string } | null {
  const token = tokenAccount(ctx, address);
  if (token) return { owner: token.owner, mint: token.mint };
  for (const ix of ctx.decoded[txIndex] ?? []) {
    if (ix.programAddress !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" || !["createAssociatedToken", "createAssociatedTokenIdempotent"].includes(ix.name ?? "")) continue;
    // Official ATA order: payer, ATA, wallet, mint, System, Token program.
    if (ix.accounts[1]?.address !== address || ![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(ix.accounts[5]?.address ?? "")) continue;
    const owner = ix.accounts[2]?.address, mint = accountNamed(ix,"mint") ?? ix.accounts[3]?.address;
    if (owner && mint) return {owner,mint};
  }
  return null;
}
