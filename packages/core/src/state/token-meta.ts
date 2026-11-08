// E26: token names and decimals for the mints a session touches, over Helius only. Token accounts named by token
// transfers and Jupiter swaps give their mints (getMultipleAccounts); mint accounts give decimals; DAS getAssetBatch
// gives symbol and name. One batched read each, through the session reader and client. A failed read leaves the mint
// as an address with raw units: nothing is guessed. The reads are kept apart from RuleState.accounts, so risk rules
// see exactly the state they saw before.
import type { Address } from "@solana/kit";
import type { DecodedInstruction } from "../decode/types.js";
import { RpcError, type RpcClient } from "../rpc/client.js";
import type { Session } from "../ingest/types.js";
import type { AccountReader } from "./account-reader.js";
import { assetInfo } from "./history.js";
import { decodeMint, decodeTokenAccount, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./layouts.js";

export interface TokenMeta {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  source: "helius-das" | "mint-account";
}

export interface TokenMetaState {
  tokens: Record<string, TokenMeta>;
  /** Token account -> mint, for accounts the session's instructions name. */
  tokenAccountMints: Record<string, string>;
  problems: string[];
}

export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const SWAP_EXACT_IN = ["route", "routeV2", "sharedAccountsRoute", "sharedAccountsRouteV2"] as const;
export const SWAP_EXACT_OUT = ["exactOutRoute", "exactOutRouteV2", "sharedAccountsExactOutRoute", "sharedAccountsExactOutRouteV2"] as const;
const TOKEN_IX = ["transfer", "transferChecked", "approve", "approveChecked", "mintTo", "mintToChecked", "burn", "burnChecked"];
const TOKEN_ACCOUNT_NAMES = ["source", "destination", "userSourceTokenAccount", "userDestinationTokenAccount", "sourceTokenAccount", "destinationTokenAccount"];
const MINT_NAMES = ["mint", "sourceMint", "destinationMint"];

/** Token accounts and mints named by token transfers and swaps in the session's top-level instructions. */
export function tokenSubjects(decoded: DecodedInstruction[][]): { accounts: string[]; mints: string[] } {
  const accounts = new Set<string>(), mints = new Set<string>();
  for (const ix of decoded.flat()) {
    if (ix.status !== "named") continue;
    const token = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(ix.programAddress) && TOKEN_IX.includes(ix.name ?? "");
    const swap = ix.programAddress === JUPITER_V6_PROGRAM && [...SWAP_EXACT_IN, ...SWAP_EXACT_OUT].includes(ix.name as never);
    // Any other named instruction that carries an amount: its token accounts and mints say what the amount is of.
    const amounted = !token && !swap && Object.entries(ix.args ?? {}).some(([k, v]) => typeof v === "bigint" && /amount/i.test(k));
    if (!token && !swap && !amounted) continue;
    for (const a of ix.accounts) {
      if (!a.address || !a.name) continue;
      if (amounted ? /TokenAccount$/.test(a.name) : TOKEN_ACCOUNT_NAMES.includes(a.name)) accounts.add(a.address);
      else if (amounted ? /Mint$|^mint$/.test(a.name) : MINT_NAMES.includes(a.name)) mints.add(a.address);
    }
  }
  return { accounts: [...accounts].sort(), mints: [...mints].sort() };
}

export async function readTokenMeta(rpc: RpcClient, reader: AccountReader, session: Session, decoded: DecodedInstruction[][], known: Record<string, { owner: string; data: Uint8Array; executable: boolean } | null> = {}): Promise<TokenMetaState> {
  void session;
  const problems: string[] = [];
  const subjects = tokenSubjects(decoded);
  const tokenAccountMints: Record<string, string> = {};
  const raw = new Map<string, { owner: string; data: Uint8Array; executable: boolean } | null>();
  const fetch = async (addresses: string[]): Promise<void> => {
    const need = addresses.filter((a) => !raw.has(a));
    for (const a of need) if (known[a]) raw.set(a, known[a]!);
    const todo = need.filter((a) => !raw.has(a));
    if (!todo.length) return;
    try {
      const got = await reader.getMultipleAccounts(todo as Address[]);
      todo.forEach((a, i) => raw.set(a, got[i] ?? null));
    } catch (e) {
      problems.push(`getMultipleAccounts: ${e instanceof RpcError ? e.message : String(e)}`);
    }
  };
  await fetch(subjects.accounts);
  const mints = new Set(subjects.mints);
  for (const a of subjects.accounts) {
    const acc = raw.get(a);
    const t = acc && !acc.executable ? decodeTokenAccount(acc.owner, acc.data) : null;
    if (t) { tokenAccountMints[a] = t.mint; mints.add(t.mint); }
  }
  const mintList = [...mints].sort();
  await fetch(mintList);
  const tokens: Record<string, TokenMeta> = {};
  for (const m of mintList) {
    const acc = raw.get(m);
    const info = acc && !acc.executable ? decodeMint(acc.owner, acc.data) : null;
    tokens[m] = { mint: m, symbol: null, name: null, decimals: info ? info.decimals : null, source: "mint-account" };
  }
  // DAS is a Helius method; a localnet validator has no such method.
  if (mintList.length && rpc.network !== "localnet") {
    try {
      const res = await rpc.call<unknown[]>("getAssetBatch", { ids: mintList });
      for (const a of Array.isArray(res) ? res : []) {
        const d = assetInfo(a);
        const t = d && tokens[d.mint];
        if (!d || !t) continue;
        if (d.symbol || d.name) {
          t.symbol = d.symbol;
          t.name = d.name;
          t.source = "helius-das";
        }
        if (t.decimals === null && d.decimals !== null) t.decimals = d.decimals;
      }
    } catch (e) {
      problems.push(`getAssetBatch: ${e instanceof RpcError ? e.message : String(e)}`);
    }
  }
  for (const m of mintList) if (tokens[m]!.decimals === null && !tokens[m]!.symbol && !tokens[m]!.name) delete tokens[m];
  return { tokens, tokenAccountMints, problems };
}
