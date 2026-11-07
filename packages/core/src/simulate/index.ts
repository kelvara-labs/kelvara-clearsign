// simulateTransaction (sigVerify: false) with post-state for listed accounts and inner instructions.
// Pre-state comes from the AccountReader just before the call, so the report can say what
// "simulation shows": SOL and token balance changes, plus owner/authority/delegate changes.
// Simulation never signs or submits anything; the RPC client refuses sendTransaction.
import type { Address } from "@solana/kit";
import { UPGRADEABLE_LOADER_PROGRAM } from "../decode/builtin.js";
import type { SessionTransaction } from "../ingest/types.js";
import type { RpcClient } from "../rpc/client.js";
import { accountFromRpc, type Commitment, type RpcAccount } from "../rpc/methods.js";
import type { AccountInfo, AccountReader } from "../state/account-reader.js";
import { decodeLoaderState, decodeMint, decodeTokenAccount, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../state/layouts.js";
import { fromBase58, fromBase64, toBase64 } from "../util/encoding.js";

const SIG_LEN = 64;

function shortU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

/** Wire bytes for a session transaction. Missing signatures become zero slots (fine with sigVerify: false). */
export function wireTransactionBytes(tx: Pick<SessionTransaction, "version" | "messageBytes" | "signatures" | "header">): Uint8Array {
  const n = tx.header.numSignerAccounts;
  const sigs = new Uint8Array(n * SIG_LEN);
  for (let i = 0; i < n; i++) {
    const s = tx.signatures[i]?.signature;
    if (s) sigs.set(fromBase58(s), i * SIG_LEN);
  }
  if (tx.version === 1) return concat([tx.messageBytes, sigs]); // v1: message first, then signatures
  return concat([Uint8Array.from(shortU16(n)), sigs, tx.messageBytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface SimulatedInnerInstruction {
  /** Index of the top-level instruction this ran under. */
  index: number;
  stackHeight: number | null;
  /** Compiled form: indices into the message's account keys. null when the RPC sent a decoded form. */
  programIdIndex: number | null;
  accountIndices: number[] | null;
  /** Decoded forms (Agave encodes simulated inner instructions like jsonParsed): program and account addresses. */
  programId: string | null;
  accounts: string[] | null;
  /** Raw data; null when the RPC sent only its parsed form. */
  data: Uint8Array | null;
  /** RPC parser output ({type, info}) when the RPC parsed it; never trusted for decisions. */
  parsed: unknown;
}

export interface SolBalanceChange {
  address: string;
  pre: bigint;
  post: bigint;
  delta: bigint;
}

export interface TokenBalanceChange {
  account: string;
  mint: string;
  owner: string;
  program: "token" | "token-2022";
  decimals: number | null;
  pre: bigint;
  post: bigint;
  delta: bigint;
}

export interface StateChange {
  address: string;
  /** e.g. "owner" (program owner), "tokenOwner", "delegate", "closeAuthority", "state", "upgradeAuthority", "mintAuthority", "freezeAuthority". */
  field: string;
  before: string | null;
  after: string | null;
}

export interface SimulationResult {
  ok: boolean;
  /** RPC err value (e.g. {InstructionError: [2, ...]}) or null. */
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  slot: number | null;
  /** True when the RPC replaced an expired blockhash; the report must state it as an assumption. */
  blockhashReplaced: boolean;
  innerInstructions: SimulatedInnerInstruction[];
  /** Accounts asked for, with state before (read) and after (simulated). */
  accounts: { address: string; pre: AccountInfo | null; post: AccountInfo | null }[];
  /** Requested accounts past MAX_SIMULATED_ACCOUNTS: their changes are unknown, not zero. */
  accountsOmitted: string[];
  solChanges: SolBalanceChange[];
  tokenChanges: TokenBalanceChange[];
  stateChanges: StateChange[];
}

export interface SimulateOptions {
  /** Accounts whose post-state we want. Default: every writable account the transaction names. */
  accounts?: readonly string[];
  /** Reader for pre-state (and mint decimals). Without one, pre-state is unknown and changes are not computed. */
  reader?: AccountReader;
  /** "auto" (default): retry with replaceRecentBlockhash when the blockhash is not found. */
  replaceRecentBlockhash?: boolean | "auto";
  commitment?: Commitment;
}

/** Compiled ({programIdIndex, accounts: number[]}), partially decoded ({programId, accounts: string[]}) or parsed ({programId, parsed}). */
interface RpcInnerInstruction {
  programIdIndex?: number;
  programId?: string;
  accounts?: (number | string)[];
  data?: string;
  parsed?: unknown;
  stackHeight?: number | null;
}

function innerInstruction(index: number, ix: RpcInnerInstruction): SimulatedInnerInstruction {
  const accs = Array.isArray(ix.accounts) ? ix.accounts : null;
  const compiled = typeof ix.programIdIndex === "number";
  return {
    index,
    stackHeight: ix.stackHeight ?? null,
    programIdIndex: compiled ? ix.programIdIndex! : null,
    accountIndices: compiled && accs ? accs.map(Number) : null,
    programId: typeof ix.programId === "string" ? ix.programId : null,
    accounts: !compiled && accs ? accs.map(String) : null,
    data: typeof ix.data === "string" ? decodeIxData(ix.data) : null,
    parsed: ix.parsed ?? null
  };
}

interface RpcSimValue {
  err: unknown;
  logs: string[] | null;
  accounts: (RpcAccount | null)[] | null;
  unitsConsumed?: number;
  innerInstructions?: { index: number; instructions: RpcInnerInstruction[] }[] | null;
  replacementBlockhash?: { blockhash: string } | null;
}

/** Agave caps simulateTransaction `accounts.addresses` like getMultipleAccounts (100). */
export const MAX_SIMULATED_ACCOUNTS = 100;

export async function simulateTransaction(rpc: RpcClient, wire: Uint8Array, opts: SimulateOptions & { accounts: readonly string[] }): Promise<SimulationResult> {
  const unique = [...new Set(opts.accounts)];
  const addresses = unique.slice(0, MAX_SIMULATED_ACCOUNTS);
  const accountsOmitted = unique.slice(MAX_SIMULATED_ACCOUNTS);
  const pre = opts.reader ? await opts.reader.getMultipleAccounts(addresses as Address[]) : addresses.map(() => undefined);
  const mode = opts.replaceRecentBlockhash ?? "auto";
  const run = (replace: boolean) =>
    rpc.call<{ context: { slot: number }; value: RpcSimValue }>("simulateTransaction", [
      toBase64(wire),
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: replace,
        commitment: opts.commitment ?? "confirmed",
        innerInstructions: true,
        accounts: { encoding: "base64", addresses }
      }
    ]);
  let replaced = mode === true;
  let res = await run(replaced);
  if (mode === "auto" && res.value.err === "BlockhashNotFound") {
    replaced = true;
    res = await run(true);
  }
  const v = res.value;
  const postRaw = v.accounts ?? addresses.map(() => null);
  const accounts = addresses.map((address, i) => ({
    address,
    pre: pre[i] === undefined ? null : (pre[i] as AccountInfo | null),
    post: accountFromRpc(address, postRaw[i])
  }));
  const innerInstructions: SimulatedInnerInstruction[] = [];
  for (const group of v.innerInstructions ?? []) {
    for (const ix of group.instructions) innerInstructions.push(innerInstruction(group.index, ix));
  }
  const ok = v.err === null || v.err === undefined;
  const changes = opts.reader && ok ? await diffAccounts(accounts, opts.reader) : { solChanges: [], tokenChanges: [], stateChanges: [] };
  return {
    ok,
    err: v.err ?? null,
    logs: v.logs ?? [],
    unitsConsumed: v.unitsConsumed ?? null,
    slot: res.context?.slot ?? null,
    blockhashReplaced: replaced,
    innerInstructions,
    accounts,
    accountsOmitted,
    ...changes
  };
}

/** Inner instruction data comes as base58 for encoding json/base64 requests; tolerate base64 too. */
function decodeIxData(s: string): Uint8Array {
  try {
    return fromBase58(s);
  } catch {
    return fromBase64(s);
  }
}

/** Simulate one session transaction; default accounts are its resolved writable accounts. */
export function simulateSessionTransaction(rpc: RpcClient, tx: SessionTransaction, opts: SimulateOptions = {}): Promise<SimulationResult> {
  const accounts = opts.accounts ?? tx.accounts.filter((a) => a.writable && a.address).map((a) => a.address as string);
  return simulateTransaction(rpc, wireTransactionBytes(tx), { ...opts, accounts });
}

async function diffAccounts(accounts: SimulationResult["accounts"], reader: AccountReader): Promise<Pick<SimulationResult, "solChanges" | "tokenChanges" | "stateChanges">> {
  const solChanges: SolBalanceChange[] = [];
  const tokenChanges: TokenBalanceChange[] = [];
  const stateChanges: StateChange[] = [];
  const change = (address: string, field: string, before: string | null, after: string | null) => {
    if (before !== after) stateChanges.push({ address, field, before, after });
  };
  const pendingTokens: Omit<TokenBalanceChange, "decimals">[] = [];
  for (const { address, pre, post } of accounts) {
    const a = pre?.lamports ?? 0n;
    const b = post?.lamports ?? 0n;
    if (a !== b) solChanges.push({ address, pre: a, post: b, delta: b - a });
    change(address, "owner", pre?.owner ?? null, post?.owner ?? null);
    const isToken = (x: AccountInfo | null) => x !== null && (x.owner === TOKEN_PROGRAM || x.owner === TOKEN_2022_PROGRAM);
    const ta = pre && isToken(pre) ? decodeTokenAccount(pre.owner, pre.data) : null;
    const tb = post && isToken(post) ? decodeTokenAccount(post.owner, post.data) : null;
    if (ta || tb) {
      const ref = (tb ?? ta)!;
      const amountA = ta?.amount ?? 0n;
      const amountB = tb?.amount ?? 0n;
      if (amountA !== amountB) pendingTokens.push({ account: address, mint: ref.mint, owner: ref.owner, program: ref.program, pre: amountA, post: amountB, delta: amountB - amountA });
      change(address, "tokenOwner", ta?.owner ?? null, tb?.owner ?? null);
      change(address, "delegate", ta?.delegate ?? null, tb?.delegate ?? null);
      change(address, "delegatedAmount", ta ? ta.delegatedAmount.toString() : null, tb ? tb.delegatedAmount.toString() : null);
      change(address, "closeAuthority", ta?.closeAuthority ?? null, tb?.closeAuthority ?? null);
      change(address, "state", ta?.state ?? null, tb?.state ?? null);
      continue;
    }
    const ma = pre && isToken(pre) ? decodeMint(pre.owner, pre.data) : null;
    const mb = post && isToken(post) ? decodeMint(post.owner, post.data) : null;
    if (ma || mb) {
      change(address, "mintAuthority", ma?.mintAuthority ?? null, mb?.mintAuthority ?? null);
      change(address, "freezeAuthority", ma?.freezeAuthority ?? null, mb?.freezeAuthority ?? null);
      change(address, "permanentDelegate", ma?.permanentDelegate ?? null, mb?.permanentDelegate ?? null);
      continue;
    }
    const la = pre?.owner === UPGRADEABLE_LOADER_PROGRAM ? decodeLoaderState(pre.data) : null;
    const lb = post?.owner === UPGRADEABLE_LOADER_PROGRAM ? decodeLoaderState(post.data) : null;
    const auth = (s: typeof la) => (s?.kind === "programData" ? s.upgradeAuthority : s?.kind === "buffer" ? s.authority : null);
    if (la || lb) change(address, "upgradeAuthority", auth(la), auth(lb));
  }
  // Decimals from the mints (one batched read through the session cache).
  const mints = [...new Set(pendingTokens.map((t) => t.mint))];
  const mintAccs = mints.length ? await reader.getMultipleAccounts(mints as Address[]) : [];
  const decimals = new Map<string, number>();
  mints.forEach((m, i) => {
    const acc = mintAccs[i];
    const info = acc ? decodeMint(acc.owner, acc.data) : null;
    if (info) decimals.set(m, info.decimals);
  });
  for (const t of pendingTokens) tokenChanges.push({ ...t, decimals: decimals.get(t.mint) ?? null });
  return { solChanges, tokenChanges, stateChanges };
}
