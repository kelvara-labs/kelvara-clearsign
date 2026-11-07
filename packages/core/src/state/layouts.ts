// Pure account-layout decoders: nonce, upgradeable loader state, SPL Token / Token-2022 mints
// (with extensions) and token accounts. Each returns null when the bytes do not match the layout;
// none of them trust an owner: callers check the owner program first.
import { toBase58 } from "../util/encoding.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const ZERO_KEY = "11111111111111111111111111111111";

class Bytes {
  constructor(readonly d: Uint8Array) {}
  has(off: number, n: number): boolean {
    return off >= 0 && off + n <= this.d.length;
  }
  u8(off: number): number {
    return this.d[off]!;
  }
  u16(off: number): number {
    return this.d[off]! | (this.d[off + 1]! << 8);
  }
  u32(off: number): number {
    return (this.d[off]! | (this.d[off + 1]! << 8) | (this.d[off + 2]! << 16)) + this.d[off + 3]! * 0x1000000;
  }
  u64(off: number): bigint {
    return BigInt(this.u32(off)) | (BigInt(this.u32(off + 4)) << 32n);
  }
  i64(off: number): bigint {
    return BigInt.asIntN(64, this.u64(off));
  }
  key(off: number): string {
    return toBase58(this.d.subarray(off, off + 32));
  }
  /** OptionalNonZeroPubkey: all-zero means none. */
  optKey(off: number): string | null {
    const k = this.key(off);
    return k === ZERO_KEY ? null : k;
  }
  /** COption<Pubkey>: u32 tag + 32 bytes. */
  coptKey(off: number): string | null | undefined {
    const tag = this.u32(off);
    if (tag === 0) return null;
    if (tag === 1) return this.key(off + 4);
    return undefined; // invalid tag
  }
}

// ---------------------------------------------------------------- nonce

export interface NonceAccount {
  version: "legacy" | "current";
  state: "uninitialized" | "initialized";
  authority: string | null;
  /** The durable nonce value (a blockhash) that transactions use as recentBlockhash. */
  nonce: string | null;
  lamportsPerSignature: bigint | null;
}

export const NONCE_ACCOUNT_LENGTH = 80;

/** System nonce account: Versions(u32) + State(u32) + authority + durable nonce + fee calculator. */
export function decodeNonceAccount(data: Uint8Array): NonceAccount | null {
  if (data.length !== NONCE_ACCOUNT_LENGTH) return null;
  const b = new Bytes(data);
  const version = b.u32(0);
  const state = b.u32(4);
  if (version > 1 || state > 1) return null;
  if (state === 0) return { version: version === 0 ? "legacy" : "current", state: "uninitialized", authority: null, nonce: null, lamportsPerSignature: null };
  return { version: version === 0 ? "legacy" : "current", state: "initialized", authority: b.key(8), nonce: b.key(40), lamportsPerSignature: b.u64(72) };
}

// ---------------------------------------------------------------- upgradeable loader

export type LoaderState =
  | { kind: "uninitialized" }
  | { kind: "buffer"; authority: string | null }
  | { kind: "program"; programData: string }
  | { kind: "programData"; slot: bigint; upgradeAuthority: string | null; headerLength: number };

/** Bytes of the ProgramData header (tag + slot + Option<Pubkey>); the ELF follows. */
export const PROGRAM_DATA_HEADER_LENGTH = 45;

/** UpgradeableLoaderState (bincode): u32 tag, then the variant. Partial data (a dataSlice) is fine. */
export function decodeLoaderState(data: Uint8Array): LoaderState | null {
  const b = new Bytes(data);
  if (!b.has(0, 4)) return null;
  const tag = b.u32(0);
  const optKey = (off: number): string | null | undefined => {
    if (!b.has(off, 1)) return undefined;
    const t = b.u8(off);
    if (t === 0) return null;
    if (t === 1 && b.has(off + 1, 32)) return b.key(off + 1);
    return undefined;
  };
  if (tag === 0) return { kind: "uninitialized" };
  if (tag === 1) {
    const authority = optKey(4);
    return authority === undefined ? null : { kind: "buffer", authority };
  }
  if (tag === 2) return b.has(4, 32) ? { kind: "program", programData: b.key(4) } : null;
  if (tag === 3) {
    if (!b.has(4, 9)) return null;
    const upgradeAuthority = optKey(12);
    if (upgradeAuthority === undefined) return null;
    return { kind: "programData", slot: b.u64(4), upgradeAuthority, headerLength: PROGRAM_DATA_HEADER_LENGTH };
  }
  return null;
}

// ---------------------------------------------------------------- SPL Token / Token-2022

export const MINT_LENGTH = 82;
export const TOKEN_ACCOUNT_LENGTH = 165;

/** Token-2022 extension type ids (spl-token-2022 ExtensionType, in discriminant order). */
export const TOKEN_2022_EXTENSION_NAMES: readonly string[] = [
  "uninitialized",
  "transferFeeConfig",
  "transferFeeAmount",
  "mintCloseAuthority",
  "confidentialTransferMint",
  "confidentialTransferAccount",
  "defaultAccountState",
  "immutableOwner",
  "memoTransfer",
  "nonTransferable",
  "interestBearingConfig",
  "cpiGuard",
  "permanentDelegate",
  "nonTransferableAccount",
  "transferHook",
  "transferHookAccount",
  "confidentialTransferFeeConfig",
  "confidentialTransferFeeAmount",
  "metadataPointer",
  "tokenMetadata",
  "groupPointer",
  "tokenGroup",
  "groupMemberPointer",
  "tokenGroupMember",
  "confidentialMintBurn",
  "scaledUiAmount",
  "pausable",
  "pausableAccount"
];

export interface TokenExtension {
  type: number;
  name: string;
  /** Decoded fields for the extensions the rules read; empty for the others. */
  fields: Record<string, unknown>;
  /** Raw TLV value, hex. */
  raw: string;
}

export interface MintInfo {
  program: "token" | "token-2022";
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
  extensions: TokenExtension[];
  /** Convenience views over extensions (null when absent or unset). */
  permanentDelegate: string | null;
  transferHook: { authority: string | null; programId: string | null } | null;
  defaultAccountState: "uninitialized" | "initialized" | "frozen" | null;
  nonTransferable: boolean;
  mintCloseAuthority: string | null;
  transferFee: { authority: string | null; withdrawAuthority: string | null; newerBasisPoints: number; newerMaximumFee: bigint; olderBasisPoints: number; olderMaximumFee: bigint; newerEpoch: bigint } | null;
  pausable: { authority: string | null; paused: boolean } | null;
  metadata: { updateAuthority: string | null; name: string; symbol: string; uri: string } | null;
  metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
}

const ACCOUNT_STATES = ["uninitialized", "initialized", "frozen"] as const;
const hex = (d: Uint8Array): string => Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");

function readBorshString(b: Bytes, off: number): [string, number] | null {
  if (!b.has(off, 4)) return null;
  const len = b.u32(off);
  if (!b.has(off + 4, len)) return null;
  return [new TextDecoder("utf-8", { fatal: false }).decode(b.d.subarray(off + 4, off + 4 + len)), off + 4 + len];
}

function decodeExtension(type: number, value: Uint8Array): Record<string, unknown> | null {
  const b = new Bytes(value);
  const need = (n: number): boolean => value.length >= n;
  switch (type) {
    case 1: // TransferFeeConfig: authority, withdraw authority, withheld u64, older{epoch,max,bps}, newer{...}
      if (!need(108)) return null;
      return {
        authority: b.optKey(0),
        withdrawWithheldAuthority: b.optKey(32),
        withheldAmount: b.u64(64),
        olderTransferFee: { epoch: b.u64(72), maximumFee: b.u64(80), basisPoints: b.u16(88) },
        newerTransferFee: { epoch: b.u64(90), maximumFee: b.u64(98), basisPoints: b.u16(106) }
      };
    case 3:
      return need(32) ? { closeAuthority: b.optKey(0) } : null;
    case 6:
      return need(1) && b.u8(0) < 3 ? { state: ACCOUNT_STATES[b.u8(0)] } : null;
    case 9:
      return {};
    case 10: // InterestBearingConfig
      return need(52) ? { rateAuthority: b.optKey(0), initializationTimestamp: b.i64(32), preUpdateAverageRate: b.u16(40), lastUpdateTimestamp: b.i64(42), currentRate: b.u16(50) } : null;
    case 12:
      return need(32) ? { delegate: b.optKey(0) } : null;
    case 14:
      return need(64) ? { authority: b.optKey(0), programId: b.optKey(32) } : null;
    case 18:
    case 20:
    case 22:
      return need(64) ? { authority: b.optKey(0), address: b.optKey(32) } : null;
    case 19: {
      // TokenMetadata: update authority, mint, name, symbol, uri, additional_metadata
      if (!need(64)) return null;
      const name = readBorshString(b, 64);
      const symbol = name && readBorshString(b, name[1]);
      const uri = symbol && readBorshString(b, symbol[1]);
      if (!name || !symbol || !uri) return null;
      const additional: [string, string][] = [];
      let off = uri[1];
      if (b.has(off, 4)) {
        const n = b.u32(off);
        off += 4;
        for (let i = 0; i < n && i < 256; i++) {
          const k = readBorshString(b, off);
          const v = k && readBorshString(b, k[1]);
          if (!k || !v) break;
          additional.push([k[0], v[0]]);
          off = v[1];
        }
      }
      return { updateAuthority: b.optKey(0), mint: b.key(32), name: name[0], symbol: symbol[0], uri: uri[0], additionalMetadata: additional };
    }
    case 25: // ScaledUiAmount
      return need(32) ? { authority: b.optKey(0) } : null;
    case 26:
      return need(33) ? { authority: b.optKey(0), paused: b.u8(32) !== 0 } : null;
    default:
      return {};
  }
}

/** Mint for SPL Token or Token-2022 (owner decides which). Extensions only on Token-2022. */
export function decodeMint(owner: string, data: Uint8Array): MintInfo | null {
  const program = owner === TOKEN_PROGRAM ? "token" : owner === TOKEN_2022_PROGRAM ? "token-2022" : null;
  if (!program || data.length < MINT_LENGTH) return null;
  const b = new Bytes(data);
  const mintAuthority = b.coptKey(0);
  const freezeAuthority = b.coptKey(46);
  if (mintAuthority === undefined || freezeAuthority === undefined) return null;
  const extensions: TokenExtension[] = [];
  if (program === "token") {
    if (data.length !== MINT_LENGTH) return null;
  } else if (data.length > MINT_LENGTH) {
    // Extended mint: zero padding to 165, account type byte (1 = Mint), then TLV entries.
    if (data.length < TOKEN_ACCOUNT_LENGTH + 1 || b.u8(TOKEN_ACCOUNT_LENGTH) !== 1) return null;
    let off = TOKEN_ACCOUNT_LENGTH + 1;
    while (off + 4 <= data.length) {
      const type = b.u16(off);
      const len = b.u16(off + 2);
      if (type === 0) break; // uninitialized: rest is padding
      if (off + 4 + len > data.length) return null;
      const value = data.subarray(off + 4, off + 4 + len);
      const fields = decodeExtension(type, value);
      extensions.push({ type, name: TOKEN_2022_EXTENSION_NAMES[type] ?? `unknown(${type})`, fields: fields ?? { malformed: true }, raw: hex(value) });
      off += 4 + len;
    }
  }
  const ext = (name: string): Record<string, unknown> | undefined => extensions.find((e) => e.name === name && !e.fields.malformed)?.fields;
  const fee = ext("transferFeeConfig") as
    | { authority: string | null; withdrawWithheldAuthority: string | null; olderTransferFee: { epoch: bigint; maximumFee: bigint; basisPoints: number }; newerTransferFee: { epoch: bigint; maximumFee: bigint; basisPoints: number } }
    | undefined;
  const hook = ext("transferHook");
  const meta = ext("tokenMetadata");
  const pointer = ext("metadataPointer");
  const pause = ext("pausable");
  const das = ext("defaultAccountState");
  return {
    program,
    mintAuthority,
    supply: b.u64(36),
    decimals: b.u8(44),
    isInitialized: b.u8(45) === 1,
    freezeAuthority,
    extensions,
    permanentDelegate: (ext("permanentDelegate")?.delegate as string | null | undefined) ?? null,
    transferHook: hook ? { authority: hook.authority as string | null, programId: hook.programId as string | null } : null,
    defaultAccountState: (das?.state as MintInfo["defaultAccountState"]) ?? null,
    nonTransferable: extensions.some((e) => e.name === "nonTransferable"),
    mintCloseAuthority: (ext("mintCloseAuthority")?.closeAuthority as string | null | undefined) ?? null,
    transferFee: fee
      ? {
          authority: fee.authority,
          withdrawAuthority: fee.withdrawWithheldAuthority,
          newerBasisPoints: fee.newerTransferFee.basisPoints,
          newerMaximumFee: fee.newerTransferFee.maximumFee,
          newerEpoch: fee.newerTransferFee.epoch,
          olderBasisPoints: fee.olderTransferFee.basisPoints,
          olderMaximumFee: fee.olderTransferFee.maximumFee
        }
      : null,
    pausable: pause ? { authority: pause.authority as string | null, paused: pause.paused as boolean } : null,
    metadata: meta ? { updateAuthority: meta.updateAuthority as string | null, name: meta.name as string, symbol: meta.symbol as string, uri: meta.uri as string } : null,
    metadataPointer: pointer ? { authority: pointer.authority as string | null, metadataAddress: pointer.address as string | null } : null
  };
}

export interface TokenAccountInfo {
  program: "token" | "token-2022";
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  state: "uninitialized" | "initialized" | "frozen";
  isNative: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
}

/** SPL token account (Token or Token-2022; extensions after byte 165 are ignored here). */
export function decodeTokenAccount(owner: string, data: Uint8Array): TokenAccountInfo | null {
  const program = owner === TOKEN_PROGRAM ? "token" : owner === TOKEN_2022_PROGRAM ? "token-2022" : null;
  if (!program || data.length < TOKEN_ACCOUNT_LENGTH) return null;
  if (program === "token" && data.length !== TOKEN_ACCOUNT_LENGTH) return null;
  if (program === "token-2022" && data.length > TOKEN_ACCOUNT_LENGTH && data[TOKEN_ACCOUNT_LENGTH] !== 2) return null;
  const b = new Bytes(data);
  const delegate = b.coptKey(72);
  const closeAuthority = b.coptKey(129);
  const state = b.u8(108);
  const nativeTag = b.u32(109);
  if (delegate === undefined || closeAuthority === undefined || state > 2 || nativeTag > 1) return null;
  return {
    program,
    mint: b.key(0),
    owner: b.key(32),
    amount: b.u64(64),
    delegate,
    state: ACCOUNT_STATES[state]!,
    isNative: nativeTag === 1 ? b.u64(113) : null,
    delegatedAmount: b.u64(121),
    closeAuthority
  };
}
