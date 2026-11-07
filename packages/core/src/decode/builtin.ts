// M1 / E4: hand-written decoders for programs without an IDL: the upgradeable BPF loader and Memo.
//
// Loader layout: bincode of `UpgradeableLoaderInstruction` (solana-loader-v3-interface): a u32 LE
// variant tag, then fixed-width little-endian fields; Vec<u8> carries a u64 LE length. The runtime
// deserializes with trailing bytes allowed, so we do too (and report how many there were).
// Account lists follow the interface's doc comments, by position.

/** Result of a hand-written decoder; null means "not an instruction this program has". Throws on bad args. */
export interface BuiltinDecoded {
  name: string;
  args: Record<string, unknown>;
  /** Account names by position; positions past the list stay unnamed. */
  accountNames: string[];
  /** Name for every account past accountNames (Memo: each one is a required signer). */
  restAccountName?: string;
}

export interface BuiltinProgram {
  name: string;
  programId: string;
  decode(data: Uint8Array): BuiltinDecoded | null;
}

export const UPGRADEABLE_LOADER_PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_V1_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

class Reader {
  private o = 0;
  constructor(private readonly d: Uint8Array) {}
  private need(n: number): void {
    if (this.o + n > this.d.length) throw new Error(`truncated at byte ${this.o}, need ${n}`);
  }
  u32(): number {
    this.need(4);
    const v = (this.d[this.o]! | (this.d[this.o + 1]! << 8) | (this.d[this.o + 2]! << 16)) + this.d[this.o + 3]! * 2 ** 24;
    this.o += 4;
    return v;
  }
  u64(): bigint {
    const lo = BigInt(this.u32());
    const hi = BigInt(this.u32());
    return (hi << 32n) | lo;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.d.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
  get remaining(): number {
    return this.d.length - this.o;
  }
}

interface LoaderVariant {
  name: string;
  accounts: string[];
  args(r: Reader): Record<string, unknown>;
}

const none = (): Record<string, unknown> => ({});

/** Index = bincode variant tag. Names are camelCase like Codama's. */
const LOADER_VARIANTS: LoaderVariant[] = [
  // 0: buffer must be uninitialized; authority is recorded, not required to sign.
  { name: "initializeBuffer", accounts: ["buffer", "bufferAuthority"], args: none },
  // 1
  {
    name: "write",
    accounts: ["buffer", "bufferAuthority"],
    args: (r) => {
      const offset = r.u32();
      const len = r.u64();
      if (len > BigInt(r.remaining)) throw new Error(`write length ${len} exceeds data`);
      return { offset, bytes: r.bytes(Number(len)) };
    }
  },
  // 2
  {
    name: "deployWithMaxDataLen",
    accounts: ["payer", "programData", "program", "buffer", "rentSysvar", "clockSysvar", "systemProgram", "authority"],
    args: (r) => ({ maxDataLen: r.u64() })
  },
  // 3
  {
    name: "upgrade",
    accounts: ["programData", "program", "buffer", "spill", "rentSysvar", "clockSysvar", "authority"],
    args: none
  },
  // 4: account is a buffer or a ProgramData; a missing newAuthority makes a program immutable.
  { name: "setAuthority", accounts: ["account", "currentAuthority", "newAuthority"], args: none },
  // 5: account is a buffer, ProgramData or uninitialized account; program is required for ProgramData.
  { name: "close", accounts: ["account", "recipient", "authority", "program"], args: none },
  // 6
  {
    name: "extendProgram",
    accounts: ["programData", "program", "systemProgram", "payer"],
    args: (r) => ({ additionalBytes: r.u32() })
  },
  // 7: like setAuthority, but the new authority must sign.
  { name: "setAuthorityChecked", accounts: ["account", "currentAuthority", "newAuthority"], args: none },
  // 8: migrate the program to loader-v4.
  { name: "migrate", accounts: ["programData", "program", "authority"], args: none },
  // 9
  {
    name: "extendProgramChecked",
    accounts: ["programData", "program", "authority", "systemProgram", "payer"],
    args: (r) => ({ additionalBytes: r.u32() })
  }
];

/** Upgradeable loader instruction names, in variant order. */
export const UPGRADEABLE_LOADER_INSTRUCTIONS: readonly string[] = LOADER_VARIANTS.map((v) => v.name);

export function decodeUpgradeableLoaderInstruction(data: Uint8Array): BuiltinDecoded | null {
  if (data.length < 4) return null;
  const r = new Reader(data);
  const v = LOADER_VARIANTS[r.u32()];
  if (!v) return null;
  const args = v.args(r);
  if (r.remaining > 0) args.trailingBytes = r.remaining;
  return { name: v.name, args, accountNames: [...v.accounts] };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Memo: the whole instruction data is the memo, which the program requires to be valid UTF-8
 * (invalid UTF-8 makes the transaction fail, so it throws here and the instruction stays Unknown).
 * The text is returned exactly as written: no trimming or normalization, because attackers use memos
 * as labels and the report must show what the signer actually sees. Every account is a required signer.
 */
export function decodeMemoInstruction(data: Uint8Array): BuiltinDecoded {
  const memo = utf8.decode(data);
  return { name: "memo", args: { memo }, accountNames: [], restAccountName: "signer" };
}

export const BUILTIN_PROGRAMS: readonly BuiltinProgram[] = [
  { name: "bpf-loader-upgradeable", programId: UPGRADEABLE_LOADER_PROGRAM, decode: decodeUpgradeableLoaderInstruction },
  { name: "memo", programId: MEMO_PROGRAM, decode: decodeMemoInstruction },
  { name: "memo-v1", programId: MEMO_V1_PROGRAM, decode: decodeMemoInstruction }
];
