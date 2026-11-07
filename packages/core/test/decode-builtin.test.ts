// E4: hand-written upgradeable loader and Memo decoders, checked against real mainnet fixtures
// (top-level and inner calls) and against the program logs the runtime wrote for them.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import {
  createDecoder,
  decodeMemoInstruction,
  decodeUpgradeableLoaderInstruction,
  MEMO_PROGRAM,
  parseTransaction,
  UPGRADEABLE_LOADER_INSTRUCTIONS,
  UPGRADEABLE_LOADER_PROGRAM,
  type DecodedInstruction,
  type ResolvedInstruction
} from "../src/index.js";
import { fromBase58 } from "../src/util/encoding.js";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/tx");

interface Fixture {
  signature: string;
  transaction: string;
  meta: {
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[];
    logMessages?: string[];
  };
}

function listFixtures(): { file: string; fx: Fixture }[] {
  const out: { file: string; fx: Fixture }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json") && e.name !== "manifest.json") out.push({ file: path.relative(fixturesDir, p), fx: JSON.parse(readFileSync(p, "utf8")) as Fixture });
    }
  };
  walk(fixturesDir);
  return out;
}

/** Every top-level and inner instruction of a fixture, with accounts resolved from the RPC meta. */
function allInstructions(fx: Fixture): ResolvedInstruction[] {
  const tx = parseTransaction({ base64: fx.transaction, kind: "wire" });
  const keys = [...tx.staticAccounts, ...((fx.meta.loadedAddresses?.writable ?? []) as Address[]), ...((fx.meta.loadedAddresses?.readonly ?? []) as Address[])];
  const nSigners = tx.header.numSignerAccounts;
  const resolve = (programIdIndex: number, accountIndices: number[], data: Uint8Array, index: number): ResolvedInstruction => ({
    index,
    programIdIndex,
    programAddress: keys[programIdIndex]!,
    // Roles are not needed by the decoders under test; signer = transaction-level signer.
    accounts: accountIndices.map((i) => ({ index: i, address: keys[i] ?? null, signer: i < nSigners, writable: false, source: { kind: "static" } as const })),
    data
  });
  const out = tx.instructions.map((ix, i) => resolve(ix.programIdIndex, ix.accountIndices, ix.data, i));
  for (const group of fx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) out.push(resolve(ix.programIdIndex, ix.accounts, fromBase58(ix.data), group.index));
  }
  return out;
}

const decoder = createDecoder([]);
const FIXTURES = listFixtures();
const decodedFor = (programId: string): { file: string; fx: Fixture; d: DecodedInstruction }[] =>
  FIXTURES.flatMap(({ file, fx }) =>
    allInstructions(fx)
      .filter((ix) => ix.programAddress === programId)
      .map((ix) => ({ file, fx, d: decoder.decodeInstruction(ix) }))
  );

const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint): number[] => [...u32(Number(n & 0xffffffffn)), ...u32(Number(n >> 32n))];

describe("E4 upgradeable loader decoder", () => {
  const loader = decodedFor(UPGRADEABLE_LOADER_PROGRAM);

  it("finds loader calls in the real fixtures and names every one", () => {
    expect(loader.length).toBeGreaterThanOrEqual(5);
    for (const { file, d } of loader) {
      expect(d, file).toMatchObject({ status: "named", decoder: "builtin", programName: "bpf-loader-upgradeable" });
      expect(d.args?.trailingBytes, file).toBeUndefined();
    }
  });

  it("agrees with the runtime logs: Upgraded program <id> and Extended ProgramData by <n>", () => {
    let checked = 0;
    for (const { file, fx, d } of loader) {
      const logs = fx.meta.logMessages ?? [];
      if (d.name === "upgrade") {
        const upgraded = logs.find((l) => l.startsWith("Upgraded program "))?.slice("Upgraded program ".length);
        expect(d.accounts.find((a) => a.name === "program")?.address, file).toBe(upgraded);
        expect(d.accounts.map((a) => a.name)).toEqual(["programData", "program", "buffer", "spill", "rentSysvar", "clockSysvar", "authority"]);
        checked++;
      }
      if (d.name === "extendProgram") {
        const m = logs.map((l) => /^Extended ProgramData account by (\d+) bytes$/.exec(l)).find(Boolean);
        expect(d.args?.additionalBytes, file).toBe(Number(m![1]));
        checked++;
      }
    }
    expect(checked).toBe(loader.length);
  });

  it("decodes every variant with its named accounts", () => {
    expect(UPGRADEABLE_LOADER_INSTRUCTIONS).toEqual([
      "initializeBuffer", "write", "deployWithMaxDataLen", "upgrade", "setAuthority", "close",
      "extendProgram", "setAuthorityChecked", "migrate", "extendProgramChecked"
    ]);
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from(u32(0)))).toMatchObject({ name: "initializeBuffer", accountNames: ["buffer", "bufferAuthority"] });
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(1), ...u32(16), ...u64(3n), 1, 2, 3]))).toEqual({
      name: "write", args: { offset: 16, bytes: Uint8Array.from([1, 2, 3]) }, accountNames: ["buffer", "bufferAuthority"]
    });
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(2), ...u64(2n ** 40n + 5n)]))).toMatchObject({
      name: "deployWithMaxDataLen", args: { maxDataLen: 2n ** 40n + 5n }
    });
    const setAuth = decodeUpgradeableLoaderInstruction(Uint8Array.from(u32(4)));
    expect(setAuth).toMatchObject({ name: "setAuthority", args: {}, accountNames: ["account", "currentAuthority", "newAuthority"] });
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from(u32(7)))).toMatchObject({ name: "setAuthorityChecked", accountNames: ["account", "currentAuthority", "newAuthority"] });
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from(u32(5)))).toMatchObject({ name: "close", accountNames: ["account", "recipient", "authority", "program"] });
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(6), ...u32(1024)]))).toMatchObject({ name: "extendProgram", args: { additionalBytes: 1024 } });
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(9), ...u32(7)]))).toMatchObject({ name: "extendProgramChecked", args: { additionalBytes: 7 } });
  });

  it("names SetAuthority accounts through the decoder, including a missing new authority (immutable)", () => {
    const ix = (n: number): ResolvedInstruction => ({
      index: 0, programIdIndex: 9, programAddress: UPGRADEABLE_LOADER_PROGRAM as Address, data: Uint8Array.from(u32(4)),
      accounts: Array.from({ length: n }, (_, i) => ({ index: i, address: null, signer: i === 1, writable: i === 0, source: { kind: "static" } as const }))
    });
    expect(decoder.decodeInstruction(ix(3)).accounts.map((a) => a.name)).toEqual(["account", "currentAuthority", "newAuthority"]);
    expect(decoder.decodeInstruction(ix(2)).accounts.map((a) => a.name)).toEqual(["account", "currentAuthority"]);
  });

  it("keeps bad data Unknown: unknown tag, short tag, truncated args, oversized write length", () => {
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from(u32(10)))).toBeNull();
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from([4, 0]))).toBeNull();
    expect(() => decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(2), 1, 2, 3]))).toThrow();
    expect(() => decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(1), ...u32(0), ...u64(1000n), 1]))).toThrow();
    const base = { index: 0, programIdIndex: 0, programAddress: UPGRADEABLE_LOADER_PROGRAM as Address, accounts: [] };
    expect(decoder.decodeInstruction({ ...base, data: Uint8Array.from(u32(99)) })).toMatchObject({ status: "unknown", reason: "no_matching_instruction" });
    expect(decoder.decodeInstruction({ ...base, data: Uint8Array.from([...u32(6), 1]) })).toMatchObject({ status: "unknown", reason: "args_did_not_decode" });
  });

  it("reports trailing bytes the runtime would ignore", () => {
    expect(decodeUpgradeableLoaderInstruction(Uint8Array.from([...u32(3), 0xaa, 0xbb]))?.args).toEqual({ trailingBytes: 2 });
  });
});

describe("E4 memo decoder", () => {
  const memos = decodedFor(MEMO_PROGRAM);

  it("decodes every real memo fixture to its exact text", () => {
    expect(memos.length).toBeGreaterThanOrEqual(5);
    for (const { file, d } of memos) {
      expect(d, file).toMatchObject({ status: "named", decoder: "builtin", name: "memo", programName: "memo" });
      // Shown as-is: the text round-trips to the exact instruction bytes.
      expect(new TextEncoder().encode(d.args!.memo as string), file).toEqual(d.data);
      expect(d.accounts.every((a) => a.name === "signer")).toBe(true);
    }
  });

  it("keeps the text exactly as written (no trim, no normalization)", () => {
    const text = "  Q4 fee update‮\n";
    expect(decodeMemoInstruction(new TextEncoder().encode(text)).args.memo).toBe(text);
  });

  it("rejects invalid UTF-8 (the program would fail) as Unknown", () => {
    const ix: ResolvedInstruction = { index: 0, programIdIndex: 0, programAddress: MEMO_PROGRAM as Address, accounts: [], data: Uint8Array.from([0xff, 0xfe]) };
    expect(decoder.decodeInstruction(ix)).toMatchObject({ status: "unknown", reason: "args_did_not_decode", name: null });
  });

  it("can be turned off, and never throws on 1,000 random payloads", () => {
    const off = createDecoder([], { builtins: false });
    const ix: ResolvedInstruction = { index: 0, programIdIndex: 0, programAddress: MEMO_PROGRAM as Address, accounts: [], data: Uint8Array.from([0x61]) };
    expect(off.decodeInstruction(ix)).toMatchObject({ status: "unknown", reason: "program_not_in_registry" });
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let i = 0; i < 1000; i++) {
      const data = Uint8Array.from({ length: Math.floor(rnd() * 64) }, () => Math.floor(rnd() * 256));
      if (i % 2) data.set(u32(Math.floor(rnd() * 12)).slice(0, Math.min(4, data.length)));
      for (const programAddress of [UPGRADEABLE_LOADER_PROGRAM, MEMO_PROGRAM] as Address[]) {
        expect(() => decoder.decodeInstruction({ ...ix, programAddress, data })).not.toThrow();
      }
    }
  });
});
