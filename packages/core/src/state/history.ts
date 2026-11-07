// Wallet transfer history for the address rules (PLAN.md M2 rule 3d): the user's recent signatures
// over Helius (last 30 days, at most 1,000), the SOL and token transfers in them, and for each
// requested recipient every transaction it shares with the user in that window. Reads go through the
// session RpcClient, whose promise cache makes a second read in the same session free.
//
// Completeness is explicit. "The user never sent to X" is only stated as complete when X's own
// signature list reaches the window start (or X's first transaction) and every transaction X shares
// with the user in the window was read. Token sends without an ATA creation do not name the owner,
// so pass the destination token accounts of the request as `tokenAccounts` and they are searched too.
import { RpcError, type RpcClient } from "../rpc/client.js";
import { getSignaturesForAddress, type SignatureInfo } from "../rpc/methods.js";
import { fromBase58 } from "../util/encoding.js";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./layouts.js";

export const HISTORY_DAYS = 30;
export const HISTORY_MAX_SIGNATURES = 1000;
/** SOL dust: 0.001 SOL or less. */
export const DUST_MAX_LAMPORTS = 1_000_000n;
/** Token dust: worth $0.01 or less by Helius DAS price. */
export const DUST_MAX_USD = 0.01;

export interface HistoryTransfer {
  signature: string;
  slot: number;
  blockTime: number | null;
  kind: "sol" | "token";
  /** SOL source, or the owner/authority of the token source. */
  from: string;
  /** SOL destination, or the owner of the destination token account (from token balances). */
  to: string;
  /** Destination token account (tokens only). */
  toAccount?: string;
  mint?: string;
  amount: bigint;
  decimals?: number;
  /** [top-level] or [top-level, inner] instruction index. */
  path: number[];
}

export interface AssetInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** USD price per whole token from DAS token_info.price_info, null when DAS has none. */
  priceUsd: number | null;
}

export interface CounterpartyHistory {
  address: string;
  /** Addresses whose signature lists were searched (the owner plus given token accounts). */
  searched: string[];
  /** Signatures of the searched addresses inside the window. */
  signatures: number;
  /** Transactions shared with the wallet in the window that were read. */
  shared: string[];
  /** Every transfer between the wallet and this address in the shared transactions (both directions). */
  transfers: HistoryTransfer[];
  /** True only when every searched list reached the window start or its end, and every shared tx was read. */
  complete: boolean;
  problems: string[];
}

export interface WalletHistory {
  wallet: string;
  source: "helius" | "rpc";
  /** Unix seconds the window ends at, and the window start. */
  now: number;
  since: number;
  days: number;
  maxSignatures: number;
  /** User signatures inside the window, newest first. */
  signatures: SignatureInfo[];
  /** "window": reached the 30-day start; "end": first transaction; "cap": hit maxSignatures; "error": stopped early. */
  reach: "window" | "end" | "cap" | "error";
  /** Successful user transactions read for transfers (newest first), and those that could not be read. */
  read: string[];
  unread: string[];
  /** Transfers in the read transactions where the wallet is the sender. */
  outgoing: HistoryTransfer[];
  /** Mints the wallet held in the read transactions (token balances owned by the wallet), plus given ones. */
  heldMints: string[];
  counterparties: Record<string, CounterpartyHistory>;
  assets: Record<string, AssetInfo>;
  problems: string[];
}

export interface ReadHistoryOptions {
  wallet: string;
  /** Recipients of the request, with the destination token accounts the request pays into. */
  counterparties: { address: string; tokenAccounts?: string[] }[];
  /** Unix seconds; defaults to the clock. */
  now?: number;
  days?: number;
  maxSignatures?: number;
  /** User transactions read for outgoing transfers (lookalike search), newest first. */
  maxTransactions?: number;
  /** Shared transactions read per counterparty before it is marked incomplete. */
  maxSharedTransactions?: number;
  heldMints?: string[];
  /** getSignaturesForAddress page size (default and max 1000). */
  pageSize?: number;
}

/** getTransaction (json) fields the history uses. */
interface JsonTx {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RawIx[] } };
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: RawIx[] }[] | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
}
interface RawIx { programIdIndex: number; accounts: number[]; data: string }
interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { decimals: number } }

const u64 = (d: Uint8Array, o: number): bigint | null => {
  if (d.length < o + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!);
  return v;
};

/** SOL and token transfers in one json transaction (top-level and inner). Failed transactions move nothing. */
export function transfersOfTransaction(tx: JsonTx, signature: string): HistoryTransfer[] {
  if (!tx.meta || tx.meta.err !== null) return [];
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const balances = new Map<string, { mint: string; owner?: string; decimals?: number }>();
  for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    const a = keys[b.accountIndex];
    if (a) balances.set(a, { mint: b.mint, owner: b.owner ?? balances.get(a)?.owner, decimals: b.uiTokenAmount?.decimals });
  }
  const out: HistoryTransfer[] = [];
  const visit = (ix: RawIx, path: number[]) => {
    const program = keys[ix.programIdIndex];
    const acc = (i: number) => keys[ix.accounts[i] ?? -1];
    let data: Uint8Array;
    try { data = fromBase58(ix.data); } catch { return; }
    const base = { signature, slot: tx.slot, blockTime: tx.blockTime, path };
    if (program === SYSTEM_PROGRAM) {
      // Transfer (2) and TransferWithSeed (11): lamports at offset 4.
      const tag = data.length >= 4 ? data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24) : -1;
      const amount = u64(data, 4);
      if (tag === 2 && amount !== null && acc(0) && acc(1)) out.push({ ...base, kind: "sol", from: acc(0)!, to: acc(1)!, amount });
      else if (tag === 11 && amount !== null && acc(0) && acc(2)) out.push({ ...base, kind: "sol", from: acc(0)!, to: acc(2)!, amount });
    } else if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      // Transfer (3): source, destination, authority. TransferChecked (12): source, mint, destination, authority.
      const amount = u64(data, 1);
      const [src, dst, auth, mintKey] = data[0] === 3 ? [acc(0), acc(1), acc(2), undefined] : data[0] === 12 ? [acc(0), acc(2), acc(3), acc(1)] : [];
      if (amount === null || !src || !dst || !auth) return;
      const d = balances.get(dst), s = balances.get(src);
      const mint = mintKey ?? d?.mint ?? s?.mint;
      // The authority is the owner unless it is a delegate; use the recorded source owner when present.
      const from = s?.owner ?? auth;
      if (!d?.owner || !mint) return;
      out.push({ ...base, kind: "token", from, to: d.owner, toAccount: dst, mint, amount, decimals: data[0] === 12 ? data[9] : d.decimals });
    }
  };
  tx.transaction.message.instructions.forEach((ix, i) => visit(ix, [i]));
  for (const inner of tx.meta.innerInstructions ?? []) inner.instructions.forEach((ix, j) => visit(ix, [inner.index, j]));
  return out;
}

const getTx = (rpc: RpcClient, signature: string) =>
  rpc.call<JsonTx | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);

/** Signatures of `address` inside the window (newer than `since`, not below `minSlot`), newest first. */
async function windowSignatures(rpc: RpcClient, address: string, since: number, cap: number, pageSize: number, minSlot = -1): Promise<{ list: SignatureInfo[]; reach: WalletHistory["reach"]; problem?: string }> {
  const list: SignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const limit = Math.min(pageSize, cap - list.length);
    let page: SignatureInfo[];
    try {
      page = await getSignaturesForAddress(rpc, address, { limit, ...(before ? { before } : {}) });
    } catch (e) {
      return { list, reach: "error", problem: `getSignaturesForAddress ${address}: ${e instanceof RpcError ? e.message : String(e)}` };
    }
    if (!Array.isArray(page)) return { list, reach: "error", problem: `getSignaturesForAddress ${address}: bad response` };
    for (const s of page) {
      if ((s.blockTime !== null && s.blockTime < since) || s.slot < minSlot) return { list, reach: "window" };
      list.push(s);
      if (list.length >= cap) return { list, reach: "cap" };
    }
    if (page.length < limit) return { list, reach: "end" };
    before = page[page.length - 1]!.signature;
  }
}

/** Reads the wallet history the address rules need. Never throws on RPC errors: they become problems. */
export async function readTransferHistory(rpc: RpcClient, opts: ReadHistoryOptions): Promise<WalletHistory> {
  const days = opts.days ?? HISTORY_DAYS;
  const maxSignatures = Math.min(opts.maxSignatures ?? HISTORY_MAX_SIGNATURES, HISTORY_MAX_SIGNATURES);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const since = now - days * 86_400;
  const wallet = opts.wallet;
  const problems: string[] = [];
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 1000, 1000));
  const user = await windowSignatures(rpc, wallet, since, maxSignatures, pageSize);
  if (user.problem) problems.push(user.problem);
  const userSet = new Set(user.list.map((s) => s.signature));
  // The 1,000-signature cap is the window's start (PLAN.md 3d): older activity is outside it.
  const windowStartSlot = user.reach === "cap" ? user.list.at(-1)!.slot : -1;
  // When the user list stopped on an error, the slot below which it says nothing.
  const coveredFrom = user.reach === "error" ? user.list.at(-1)?.slot ?? Infinity : null;

  const read: string[] = [], unread: string[] = [], outgoing: HistoryTransfer[] = [];
  const held = new Set(opts.heldMints ?? []);
  const txs = new Map<string, JsonTx | null>();
  const load = async (sig: string): Promise<JsonTx | null> => {
    if (txs.has(sig)) return txs.get(sig)!;
    let t: JsonTx | null = null;
    try { t = await getTx(rpc, sig); } catch { t = null; }
    txs.set(sig, t);
    return t;
  };
  const ok = user.list.filter((s) => s.err === null).slice(0, opts.maxTransactions ?? 100);
  for (const s of ok) {
    const t = await load(s.signature);
    if (!t) { unread.push(s.signature); continue; }
    read.push(s.signature);
    for (const tr of transfersOfTransaction(t, s.signature)) if (tr.from === wallet && tr.to !== wallet) outgoing.push(tr);
    for (const b of [...(t.meta?.preTokenBalances ?? []), ...(t.meta?.postTokenBalances ?? [])]) if (b.owner === wallet) held.add(b.mint);
  }

  const counterparties: Record<string, CounterpartyHistory> = {};
  for (const c of opts.counterparties) {
    if (c.address === wallet || counterparties[c.address]) continue;
    const searched = [c.address, ...(c.tokenAccounts ?? []).filter((a) => a !== c.address)];
    const cp: CounterpartyHistory = { address: c.address, searched, signatures: 0, shared: [], transfers: [], complete: true, problems: [] };
    const shared = new Set<string>();
    for (const a of searched) {
      const r = await windowSignatures(rpc, a, since, maxSignatures, pageSize, windowStartSlot);
      cp.signatures += r.list.length;
      if (r.problem) cp.problems.push(r.problem);
      if (r.reach === "error" || r.reach === "cap") cp.complete = false;
      for (const s of r.list) if (s.err === null && (userSet.has(s.signature) || (coveredFrom !== null && s.slot < coveredFrom))) shared.add(s.signature);
    }
    const max = opts.maxSharedTransactions ?? 200;
    if (shared.size > max) { cp.complete = false; cp.problems.push(`${shared.size} shared transactions, read the newest ${max}`); }
    for (const sig of [...shared].slice(0, max)) {
      const t = await load(sig);
      if (!t) { cp.complete = false; cp.problems.push(`transaction ${sig} could not be read`); continue; }
      cp.shared.push(sig);
      for (const tr of transfersOfTransaction(t, sig)) {
        if ((tr.from === wallet && tr.to === c.address) || (tr.from === c.address && tr.to === wallet)) cp.transfers.push(tr);
      }
    }
    counterparties[c.address] = cp;
  }

  // DAS metadata and price for every incoming token from a counterparty, and for held mints (copycats).
  const mints = new Set<string>(held);
  for (const cp of Object.values(counterparties)) for (const t of cp.transfers) if (t.mint && t.to === wallet) mints.add(t.mint);
  const assets: Record<string, AssetInfo> = {};
  const ids = [...mints].sort();
  for (let i = 0; i < ids.length; i += 1000) {
    try {
      const res = await rpc.call<unknown[]>("getAssetBatch", { ids: ids.slice(i, i + 1000) });
      for (const a of Array.isArray(res) ? res : []) {
        const info = assetInfo(a);
        if (info) assets[info.mint] = info;
      }
    } catch (e) {
      problems.push(`getAssetBatch: ${e instanceof RpcError ? e.message : String(e)}`);
    }
  }

  return {
    wallet, source: rpc.network === "localnet" ? "rpc" : "helius", now, since, days, maxSignatures,
    signatures: user.list, reach: user.reach, read, unread, outgoing, heldMints: [...held].sort(), counterparties, assets, problems
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- DAS asset JSON */
function assetInfo(a: any): AssetInfo | null {
  if (!a || typeof a.id !== "string") return null;
  const meta = a.content?.metadata ?? {};
  const ti = a.token_info ?? {};
  const price = ti.price_info?.price_per_token;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    mint: a.id,
    name: str(meta.name),
    symbol: str(meta.symbol) ?? str(ti.symbol),
    decimals: typeof ti.decimals === "number" ? ti.decimals : null,
    priceUsd: typeof price === "number" && Number.isFinite(price) && (ti.price_info?.currency ?? "USDC") === "USDC" ? price : null
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type DustReason = "sol_at_most_0.001" | "zero_amount_token" | "token_worth_at_most_0.01_usd" | "copycat_token";

/** Why a transfer to the wallet is dust (PLAN.md 3d), or null when it is not (or its value is unknown). */
export function dustReason(t: HistoryTransfer, h: Pick<WalletHistory, "assets" | "heldMints">): DustReason | null {
  if (t.kind === "sol") return t.amount <= DUST_MAX_LAMPORTS ? "sol_at_most_0.001" : null;
  if (t.amount === 0n) return "zero_amount_token";
  const a = t.mint ? h.assets[t.mint] : undefined;
  const decimals = t.decimals ?? a?.decimals;
  if (a && a.priceUsd !== null && decimals !== null && decimals !== undefined) {
    if ((Number(t.amount) / 10 ** decimals) * a.priceUsd <= DUST_MAX_USD) return "token_worth_at_most_0.01_usd";
  }
  if (a && t.mint) {
    const norm = (s: string | null) => s?.toLowerCase() ?? null;
    for (const m of h.heldMints) {
      const held = h.assets[m];
      if (m === t.mint || !held) continue;
      if ((norm(a.name) && norm(a.name) === norm(held.name)) || (norm(a.symbol) && norm(a.symbol) === norm(held.symbol))) return "copycat_token";
    }
  }
  return null;
}

export interface LookalikeMatch {
  prefix: number;
  suffix: number;
}

/**
 * Lookalike test (PLAN.md 3d): at least 5 shared characters across the start and the end, at least 2
 * on each side. Shared = longest common prefix and suffix (case-sensitive, base58). Null otherwise.
 */
export function lookalike(a: string, b: string): LookalikeMatch | null {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < n && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return prefix >= 2 && suffix >= 2 && prefix + suffix >= 5 ? { prefix, suffix } : null;
}

/** Marks matched characters: "[24dx]ciePS…L9[9q6h]" style, full address kept. */
export function markMatch(address: string, m: LookalikeMatch): string {
  return `[${address.slice(0, m.prefix)}]${address.slice(m.prefix, address.length - m.suffix)}[${address.slice(address.length - m.suffix)}]`;
}
