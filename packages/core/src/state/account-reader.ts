// Injectable account reader. The engine never talks to an RPC directly: it asks an
// AccountReader. The Helius adapter (M4) implements this with getMultipleAccounts;
// tests use the fixture-backed reader built from recorded RPC responses.
import type { Address } from "@solana/kit";
import { fromBase64 } from "../util/encoding.js";

export interface AccountInfo {
  address: Address;
  owner: Address;
  lamports: bigint;
  executable: boolean;
  data: Uint8Array;
}

export interface AccountReader {
  /** Same contract as getMultipleAccounts: one entry per address, in order, null when absent. */
  getMultipleAccounts(addresses: readonly Address[]): Promise<(AccountInfo | null)[]>;
}

/** Shape of one account in a recorded getMultipleAccounts response (encoding: base64). */
export interface RecordedAccount {
  owner: string;
  dataBase64: string;
  lamports: number | string;
  executable: boolean;
}

/** Reader backed by recorded RPC responses. Unknown addresses read as absent (null). */
export function createFixtureAccountReader(
  accounts: Readonly<Record<string, RecordedAccount | null>>
): AccountReader & { calls: Address[][] } {
  const calls: Address[][] = [];
  return {
    calls,
    async getMultipleAccounts(addresses) {
      calls.push([...addresses]);
      return addresses.map((address) => {
        const a = accounts[address];
        if (!a) return null;
        return {
          address,
          owner: a.owner as Address,
          lamports: BigInt(a.lamports),
          executable: a.executable,
          data: fromBase64(a.dataBase64)
        };
      });
    }
  };
}

/**
 * Per-session cache in front of another reader: every address is fetched at most once,
 * in chunks of at most `chunkSize` (getMultipleAccounts accepts up to 100).
 */
export function createCachingAccountReader(inner: AccountReader, chunkSize = 100): AccountReader {
  const cache = new Map<string, AccountInfo | null>();
  return {
    async getMultipleAccounts(addresses) {
      const missing = [...new Set(addresses.filter((a) => !cache.has(a)))];
      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize);
        const res = await inner.getMultipleAccounts(chunk);
        if (res.length !== chunk.length) {
          throw new Error(`account reader returned ${res.length} entries for ${chunk.length} addresses`);
        }
        chunk.forEach((a, j) => cache.set(a, res[j] ?? null));
      }
      return addresses.map((a) => cache.get(a) ?? null);
    }
  };
}
