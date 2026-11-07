// Typed wrappers over the RPC client, plus the RPC-backed AccountReader (the Helius adapter).
import type { Address } from "@solana/kit";
import type { AccountInfo, AccountReader } from "../state/account-reader.js";
import { fromBase64 } from "../util/encoding.js";
import { RpcError, type RpcClient } from "./client.js";

export type Commitment = "processed" | "confirmed" | "finalized";

/** Raw account as returned by getAccountInfo / getMultipleAccounts with encoding base64. */
export interface RpcAccount {
  data: [string, string] | string[];
  owner: string;
  lamports: number;
  executable: boolean;
  rentEpoch?: number;
  space?: number;
}

export function accountFromRpc(address: string, raw: RpcAccount | null | undefined): AccountInfo | null {
  if (!raw) return null;
  if (!Array.isArray(raw.data) || raw.data[1] !== "base64" || typeof raw.data[0] !== "string") {
    throw new RpcError("bad_response", "account", `account ${address} is not base64-encoded`);
  }
  return {
    address: address as Address,
    owner: raw.owner as Address,
    lamports: BigInt(raw.lamports),
    executable: raw.executable,
    data: fromBase64(raw.data[0])
  };
}

export interface RpcAccountReader extends AccountReader {
  readonly rpc: RpcClient;
  /** One account; dataSlice limits the bytes fetched (e.g. a ProgramData header). */
  getAccountInfo(address: Address, opts?: { dataSlice?: { offset: number; length: number } }): Promise<AccountInfo | null>;
}

/** Helius (or localnet) adapter for AccountReader: getMultipleAccounts in chunks of 100. */
export function createRpcAccountReader(rpc: RpcClient, opts: { commitment?: Commitment; chunkSize?: number } = {}): RpcAccountReader {
  const commitment = opts.commitment ?? "confirmed";
  const chunkSize = Math.min(opts.chunkSize ?? 100, 100);
  return {
    rpc,
    async getMultipleAccounts(addresses) {
      const out: (AccountInfo | null)[] = [];
      for (let i = 0; i < addresses.length; i += chunkSize) {
        const chunk = addresses.slice(i, i + chunkSize);
        const res = await rpc.call<{ value: (RpcAccount | null)[] }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment }]);
        if (!res || !Array.isArray(res.value) || res.value.length !== chunk.length) {
          throw new RpcError("bad_response", "getMultipleAccounts", `expected ${chunk.length} entries`);
        }
        chunk.forEach((a, j) => out.push(accountFromRpc(a, res.value[j])));
      }
      return out;
    },
    async getAccountInfo(address, o = {}) {
      const config: Record<string, unknown> = { encoding: "base64", commitment };
      if (o.dataSlice) config.dataSlice = o.dataSlice;
      const res = await rpc.call<{ value: RpcAccount | null }>("getAccountInfo", [address, config]);
      if (!res || typeof res !== "object" || !("value" in res)) throw new RpcError("bad_response", "getAccountInfo", "no value");
      return accountFromRpc(address, res.value);
    }
  };
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  memo: string | null;
}

export function getSignaturesForAddress(
  rpc: RpcClient,
  address: string,
  opts: { limit?: number; before?: string; until?: string; commitment?: Commitment } = {}
): Promise<SignatureInfo[]> {
  const config: Record<string, unknown> = { limit: opts.limit ?? 1000, commitment: opts.commitment ?? "confirmed" };
  if (opts.before) config.before = opts.before;
  if (opts.until) config.until = opts.until;
  return rpc.call<SignatureInfo[]>("getSignaturesForAddress", [address, config]);
}

/** getTransaction with encoding "json". */
export interface RpcJsonTransaction {
  slot: number;
  blockTime: number | null;
  version?: number | "legacy";
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] | null;
    logMessages?: string[] | null;
  } | null;
}

export function getJsonTransaction(rpc: RpcClient, signature: string, commitment: Commitment = "confirmed"): Promise<RpcJsonTransaction | null> {
  return rpc.call<RpcJsonTransaction | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment }]);
}
