// On-chain reads the rules need: nonce (and who funded it), program data, mints with Token-2022
// extensions, and Squads multisig / proposal / vault transaction accounts. Every read checks the
// owner program before decoding; a wrong owner or bad layout is a StateReadError, never a guess.
import type { Address } from "@solana/kit";
import { UPGRADEABLE_LOADER_PROGRAM } from "../decode/builtin.js";
import { SQUADS_V4_PROGRAM, type SquadsAccount } from "../decode/squads.js";
import type { RpcClient } from "../rpc/client.js";
import { getJsonTransaction, getSignaturesForAddress, type RpcAccountReader, type RpcJsonTransaction } from "../rpc/methods.js";
import { fromBase58 } from "../util/encoding.js";
import type { AccountInfo, AccountReader } from "./account-reader.js";
import {
  decodeLoaderState,
  decodeMint,
  decodeNonceAccount,
  PROGRAM_DATA_HEADER_LENGTH,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type MintInfo,
  type NonceAccount
} from "./layouts.js";

export type StateReadErrorCode = "not_found" | "wrong_owner" | "bad_layout" | "wrong_kind";

export class StateReadError extends Error {
  readonly code: StateReadErrorCode;
  readonly address: string;
  constructor(code: StateReadErrorCode, address: string, message: string) {
    super(`${address}: ${message}`);
    this.name = "StateReadError";
    this.code = code;
    this.address = address;
  }
}

async function readOne(reader: AccountReader, address: string): Promise<AccountInfo> {
  const [acc] = await reader.getMultipleAccounts([address as Address]);
  if (!acc) throw new StateReadError("not_found", address, "account does not exist");
  return acc;
}

function requireOwner(acc: AccountInfo, owners: readonly string[]): void {
  if (!owners.includes(acc.owner)) throw new StateReadError("wrong_owner", acc.address, `owned by ${acc.owner}, expected ${owners.join(" or ")}`);
}

// ---------------------------------------------------------------- nonce

export interface NonceState extends NonceAccount {
  address: string;
  lamports: bigint;
}

export async function readNonceAccount(reader: AccountReader, address: string): Promise<NonceState> {
  const acc = await readOne(reader, address);
  requireOwner(acc, [SYSTEM_PROGRAM]);
  const n = decodeNonceAccount(acc.data);
  if (!n) throw new StateReadError("bad_layout", address, `not a nonce account (${acc.data.length} bytes)`);
  return { address, lamports: acc.lamports, ...n };
}

export interface OldestSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** False when the walk hit maxPages before reaching the start of history. */
  complete: boolean;
  pages: number;
}

/** Walk getSignaturesForAddress backwards to the account's first transaction. */
export async function findOldestSignature(rpc: RpcClient, address: string, opts: { pageSize?: number; maxPages?: number } = {}): Promise<OldestSignature | null> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 10;
  let before: string | undefined;
  let last: OldestSignature | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const sigs = await getSignaturesForAddress(rpc, address, { limit: pageSize, before });
    if (sigs.length === 0) return last && { ...last, complete: true };
    const oldest = sigs[sigs.length - 1]!;
    last = { signature: oldest.signature, slot: oldest.slot, blockTime: oldest.blockTime, complete: sigs.length < pageSize, pages: page };
    if (sigs.length < pageSize) return last;
    before = oldest.signature;
  }
  return last && { ...last, complete: false };
}

export type FundingMethod = "createAccount" | "createAccountWithSeed" | "transfer" | "transferWithSeed" | "feePayer";

export interface AccountOrigin {
  address: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Who paid the lamports that created the account; feePayer is the fallback when no System call funds it. */
  funder: string;
  method: FundingMethod;
  feePayer: string;
  /** False when the history walk was cut short: the true oldest tx may be older. */
  complete: boolean;
}

function u32le(d: Uint8Array): number | null {
  return d.length < 4 ? null : (d[0]! | (d[1]! << 8) | (d[2]! << 16)) + d[3]! * 0x1000000;
}

/** Find the System call in a transaction that funded `address`. Pure; exported for tests. */
export function fundingFromTransaction(tx: RpcJsonTransaction, address: string): { funder: string; method: FundingMethod; feePayer: string } {
  const msg = tx.transaction.message;
  const keys = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const feePayer = keys[0]!;
  const all = [...msg.instructions];
  for (const group of tx.meta?.innerInstructions ?? []) all.push(...group.instructions);
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM) continue;
    let data: Uint8Array;
    try {
      data = fromBase58(ix.data);
    } catch {
      continue;
    }
    const tag = u32le(data);
    const acct = (i: number): string | undefined => {
      const idx = ix.accounts[i];
      return idx === undefined ? undefined : keys[idx];
    };
    const pick = (fromIdx: number, toIdx: number, method: FundingMethod) => (acct(toIdx) === address && acct(fromIdx) ? { funder: acct(fromIdx)!, method, feePayer } : null);
    const hit = tag === 0 ? pick(0, 1, "createAccount") : tag === 3 ? pick(0, 1, "createAccountWithSeed") : tag === 2 ? pick(0, 1, "transfer") : tag === 11 ? pick(0, 2, "transferWithSeed") : null;
    if (hit) return hit;
  }
  return { funder: feePayer, method: "feePayer", feePayer };
}

/** The account's oldest transaction and who funded it (e.g. an outsider staging a nonce). */
export async function findAccountOrigin(rpc: RpcClient, address: string, opts: { maxPages?: number; pageSize?: number } = {}): Promise<AccountOrigin | null> {
  const oldest = await findOldestSignature(rpc, address, opts);
  if (!oldest) return null;
  const tx = await getJsonTransaction(rpc, oldest.signature);
  if (!tx) return null;
  return { address, signature: oldest.signature, slot: oldest.slot, blockTime: oldest.blockTime, complete: oldest.complete, ...fundingFromTransaction(tx, address) };
}

// ---------------------------------------------------------------- programs

export interface ProgramState {
  program: string;
  executable: boolean;
  loader: string;
  /** Present for upgradeable-loader programs only. */
  programData: string | null;
  deploySlot: bigint | null;
  /** null = immutable (no upgrade authority). */
  upgradeAuthority: string | null;
  upgradeable: boolean;
}

/** Program account plus its ProgramData header (fetched with a 45-byte dataSlice). */
export async function readProgram(reader: RpcAccountReader, program: string): Promise<ProgramState> {
  const acc = await readOne(reader, program);
  if (acc.owner !== UPGRADEABLE_LOADER_PROGRAM) {
    return { program, executable: acc.executable, loader: acc.owner, programData: null, deploySlot: null, upgradeAuthority: null, upgradeable: false };
  }
  const st = decodeLoaderState(acc.data);
  if (!st || st.kind !== "program") throw new StateReadError("wrong_kind", program, `loader account is ${st?.kind ?? "undecodable"}, not a program`);
  const pd = await reader.getAccountInfo(st.programData as Address, { dataSlice: { offset: 0, length: PROGRAM_DATA_HEADER_LENGTH } });
  if (!pd) throw new StateReadError("not_found", st.programData, "program data account does not exist");
  requireOwner(pd, [UPGRADEABLE_LOADER_PROGRAM]);
  const pds = decodeLoaderState(pd.data);
  if (!pds || pds.kind !== "programData") throw new StateReadError("wrong_kind", st.programData, "not a ProgramData account");
  return { program, executable: acc.executable, loader: acc.owner, programData: st.programData, deploySlot: pds.slot, upgradeAuthority: pds.upgradeAuthority, upgradeable: pds.upgradeAuthority !== null };
}

// ---------------------------------------------------------------- mints

export interface MintState extends MintInfo {
  address: string;
}

export async function readMints(reader: AccountReader, mints: readonly string[]): Promise<(MintState | StateReadError)[]> {
  const accs = await reader.getMultipleAccounts(mints as Address[]);
  return mints.map((address, i) => {
    const acc = accs[i];
    if (!acc) return new StateReadError("not_found", address, "mint does not exist");
    if (acc.owner !== TOKEN_PROGRAM && acc.owner !== TOKEN_2022_PROGRAM) return new StateReadError("wrong_owner", address, `owned by ${acc.owner}, not a token program`);
    const m = decodeMint(acc.owner, acc.data);
    if (!m) return new StateReadError("bad_layout", address, "not a mint");
    return { address, ...m };
  });
}

export async function readMint(reader: AccountReader, mint: string): Promise<MintState> {
  const [r] = await readMints(reader, [mint]);
  if (r instanceof StateReadError) throw r;
  return r!;
}

// ---------------------------------------------------------------- Squads

export interface SquadsAccountDecoder {
  decodeAccount(bytes: Uint8Array): SquadsAccount | null;
}

/** Read a Squads v4 account; `expect` asserts which kind it must be. */
export async function readSquadsAccount(
  reader: AccountReader,
  decoder: SquadsAccountDecoder,
  address: string,
  expect?: SquadsAccount["name"]
): Promise<SquadsAccount & { address: string }> {
  const acc = await readOne(reader, address);
  requireOwner(acc, [SQUADS_V4_PROGRAM]);
  let decoded: SquadsAccount | null;
  try {
    decoded = decoder.decodeAccount(acc.data);
  } catch (e) {
    throw new StateReadError("bad_layout", address, `Squads account does not decode: ${(e as Error).message}`);
  }
  if (!decoded) throw new StateReadError("bad_layout", address, "unknown Squads account discriminator");
  if (expect && decoded.name !== expect) throw new StateReadError("wrong_kind", address, `is ${decoded.name}, expected ${expect}`);
  return { address, ...decoded };
}
