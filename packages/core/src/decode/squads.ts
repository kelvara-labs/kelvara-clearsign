import { toBase58 } from "../util/encoding.js";
import { sha256 } from "../util/sha256.js";
import { decodeAnchorType } from "./anchor-fallback.js";
import type { AnchorIdlJson, AnchorIdlTypeDef, DecodedInstruction } from "./types.js";

export interface SquadsMessage {
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: string[];
  instructions: { programIdIndex: number; accountIndexes: Uint8Array; data: Uint8Array }[];
  addressTableLookups: { accountKey: string; writableIndexes: Uint8Array; readonlyIndexes: Uint8Array }[];
}

function validate(message: SquadsMessage): SquadsMessage {
  const n = message.accountKeys.length;
  if (message.numSigners > n || message.numWritableSigners > message.numSigners || message.numWritableNonSigners > n - message.numSigners) throw new Error("Squads: invalid account header");
  const total = n + message.addressTableLookups.reduce((sum, t) => sum + t.writableIndexes.length + t.readonlyIndexes.length, 0);
  if (total > 256) throw new Error("Squads: too many accounts");
  for (const ix of message.instructions) {
    if (ix.programIdIndex >= total || [...ix.accountIndexes].some((i) => i >= total)) throw new Error("Squads: account index out of bounds");
  }
  return message;
}

/** Squads compact message: u8 vector lengths, except instruction data (u16 LE). Not Solana wire format. */
export function decodeSquadsMessage(data: Uint8Array): SquadsMessage {
  let offset = 0;
  const take = (n: number): Uint8Array => {
    if (offset + n > data.length) throw new Error("Squads: truncated message");
    const bytes = data.slice(offset, offset + n);
    offset += n;
    return bytes;
  };
  const u8 = (): number => take(1)[0]!;
  const vec = <T>(read: () => T): T[] => Array.from({ length: u8() }, read);
  const numSigners = u8(), numWritableSigners = u8(), numWritableNonSigners = u8();
  const accountKeys = vec(() => toBase58(take(32)));
  const instructions = vec(() => {
    const programIdIndex = u8();
    const accountIndexes = take(u8());
    const size = take(2);
    return { programIdIndex, accountIndexes, data: take(size[0]! + size[1]! * 256) };
  });
  const addressTableLookups = vec(() => ({ accountKey: toBase58(take(32)), writableIndexes: take(u8()), readonlyIndexes: take(u8()) }));
  if (offset !== data.length) throw new Error("Squads: trailing message bytes");
  return validate({ numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions, addressTableLookups });
}

export const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
export interface SquadsAccount {
  name: "Multisig" | "Proposal" | "VaultTransaction";
  data: Record<string, unknown>;
}

/** IDL-driven account decoding. Caller must verify RPC account owner before trusting the result. */
export function createSquadsDecoder(idl: AnchorIdlJson) {
  const accounts = (idl as AnchorIdlJson & { accounts?: (AnchorIdlTypeDef & { discriminator?: number[] })[] }).accounts ?? [];
  const supported = ["Multisig", "Proposal", "VaultTransaction"] as const;
  const types = [...(idl.types ?? []), ...accounts.filter((a) => a.type)];
  return {
    decodeAccount(bytes: Uint8Array): SquadsAccount | null {
      for (const name of supported) {
        const account = accounts.find((a) => a.name === name);
        if (!account) continue;
        const disc = account.discriminator ?? [...sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8)];
        if (bytes.length < 8 || !disc.every((b, i) => bytes[i] === b)) continue;
        const data = decodeAnchorType(bytes.subarray(8), { defined: name }, types) as Record<string, unknown>;
        if (name === "VaultTransaction") {
          const message = data.message as SquadsMessage;
          // Stored messages use ordinary Borsh vectors, unlike the compact creation message.
          message.instructions = message.instructions.map((ix) => ({ ...ix, accountIndexes: Uint8Array.from(ix.accountIndexes), data: Uint8Array.from(ix.data) }));
          message.addressTableLookups = message.addressTableLookups.map((t) => ({ ...t, writableIndexes: Uint8Array.from(t.writableIndexes), readonlyIndexes: Uint8Array.from(t.readonlyIndexes) }));
          validate(message);
        }
        return { name, data };
      }
      return null;
    },
    decodeCreateMessage(ix: DecodedInstruction): SquadsMessage | null {
      if (ix.programAddress !== SQUADS_V4_PROGRAM || ix.status !== "named" || ix.name !== "vaultTransactionCreate") return null;
      const args = ix.args!;
      const nested = args.args as Record<string, unknown> | undefined;
      const bytes = args.transactionMessage ?? args.transaction_message ?? nested?.transactionMessage ?? nested?.transaction_message;
      if (!(bytes instanceof Uint8Array)) throw new Error("Squads: missing transaction message bytes");
      return decodeSquadsMessage(bytes);
    }
  };
}
