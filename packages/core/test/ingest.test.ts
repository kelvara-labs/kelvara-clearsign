import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IngestError,
  createFixtureAccountReader,
  ingestSession,
  parseTransaction,
  type RecordedAccount
} from "../src/index.js";
import { sha256 } from "../src/util/sha256.js";
import { fromBase64, toBase58 } from "../src/util/encoding.js";
import txFixture from "./fixtures/ingest/transactions.json" with { type: "json" };
import altFixture from "./fixtures/ingest/lookup-tables.json" with { type: "json" };

interface FixtureTx {
  signature: string;
  program: string;
  version: "legacy" | 0 | 1;
  wireBase64: string;
  loadedAddresses: { writable: string[]; readonly: string[] };
}
const TXS = txFixture.transactions as FixtureTx[];
const TABLES = altFixture.accounts as Record<string, RecordedAccount | null>;
const v0WithTables = TXS.filter((t) => t.loadedAddresses.writable.length + t.loadedAddresses.readonly.length > 0);

const nodeSha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

function shortVec(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n === 0) return out.push(b), out;
    out.push(b | 0x80);
  }
}

// Deterministic PRNG so fuzz failures reproduce.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (s | 1)) >>> 0) / 2 ** 32);
}

describe("fixtures", () => {
  it("cover legacy, v0 with lookup tables, and v1", () => {
    const versions = new Set(TXS.map((t) => String(t.version)));
    expect(versions).toEqual(new Set(["legacy", "0", "1"]));
    expect(v0WithTables.length).toBeGreaterThanOrEqual(3);
  });
});

describe("sha256", () => {
  it("matches node:crypto", () => {
    const rnd = prng(7);
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1232, 4096]) {
      const b = Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256));
      expect(sha256(b)).toEqual(nodeSha(b));
    }
  });
});

describe("parseTransaction", () => {
  it.each(TXS.map((t) => [t.signature.slice(0, 12), t] as const))("parses real wire transaction %s", (_s, t) => {
    const bytes = fromBase64(t.wireBase64);
    const p = parseTransaction(t.wireBase64);
    expect(p.envelope).toBe("wire");
    expect(p.version).toBe(t.version);
    expect(p.messageHash).toBe(toBase58(nodeSha(p.messageBytes)));
    // The transaction id is the fee payer's signature.
    expect(p.signatures[0]?.signature).toBe(t.signature);
    expect(p.signatures[0]?.signer).toBe(p.staticAccounts[0]);
    // Message bytes are the exact original bytes: re-assembling the envelope gives the input back.
    const sigs = p.signatures.map((s) => fromBase58Safe(s.signature));
    const rebuilt =
      t.version === 1
        ? new Uint8Array([...p.messageBytes, ...sigs.flatMap((s) => [...s])])
        : new Uint8Array([...shortVec(sigs.length), ...sigs.flatMap((s) => [...s]), ...p.messageBytes]);
    expect(rebuilt).toEqual(bytes);
    // Every instruction's program is a static account.
    for (const ix of p.instructions) expect(ix.programIdIndex).toBeLessThan(p.staticAccounts.length);
    // Same bytes as Uint8Array and as { bytes } give the same result.
    expect(parseTransaction({ bytes }).messageHash).toBe(p.messageHash);
  });

  it("parses a bare message with the same hash and empty signatures", () => {
    for (const t of TXS) {
      const wire = parseTransaction(t.wireBase64);
      const bare = parseTransaction(wire.messageBytes);
      expect(bare.envelope).toBe("message");
      expect(bare.messageHash).toBe(wire.messageHash);
      expect(bare.signatures.every((s) => s.signature === null)).toBe(true);
      expect(bare.signatures.map((s) => s.signer)).toEqual(wire.signatures.map((s) => s.signer));
      expect(bare.instructions).toEqual(wire.instructions);
    }
  });

  it("honours an explicit kind", () => {
    const t = TXS[0]!;
    const wire = parseTransaction(t.wireBase64);
    expect(() => parseTransaction({ bytes: wire.messageBytes, kind: "wire" })).toThrow(IngestError);
    expect(() => parseTransaction({ base64: t.wireBase64, kind: "message" })).toThrow(IngestError);
  });

  it("reads v1 config values", () => {
    const v1 = TXS.find((t) => t.version === 1)!;
    const p = parseTransaction(v1.wireBase64);
    expect(p.v1Config).toBeDefined();
    expect(p.addressTableLookups).toEqual([]);
  });

  it("marks the fee payer as a writable signer", async () => {
    const s = await ingestSession(TXS.map((t) => t.wireBase64), { reader: createFixtureAccountReader(TABLES) });
    for (const tx of s.transactions) {
      expect(tx.accounts[0]).toMatchObject({ index: 0, signer: true, writable: true });
      expect(tx.accounts.filter((a) => a.signer).length).toBe(tx.header.numSignerAccounts);
    }
  });
});

describe("lookup tables", () => {
  it("resolve to exactly the addresses the cluster loaded", async () => {
    for (const t of v0WithTables) {
      const s = await ingestSession([t.wireBase64], { reader: createFixtureAccountReader(TABLES) });
      const tx = s.transactions[0]!;
      expect(tx.complete).toBe(true);
      const loaded = tx.accounts.filter((a) => a.source.kind === "lookup");
      expect(loaded.filter((a) => a.writable).map((a) => a.address)).toEqual(t.loadedAddresses.writable);
      expect(loaded.filter((a) => !a.writable).map((a) => a.address)).toEqual(t.loadedAddresses.readonly);
      expect(loaded.every((a) => !a.signer)).toBe(true);
      // Instruction accounts point into the full key list.
      for (const ix of tx.instructions) {
        expect(ix.accounts.every((a) => a.address !== null)).toBe(true);
        expect(ix.programAddress).toBe(tx.staticAccounts[ix.programIdIndex]);
      }
    }
  });

  it("are read once per session in a single batched call", async () => {
    const reader = createFixtureAccountReader(TABLES);
    const s = await ingestSession([...v0WithTables, ...v0WithTables].map((t) => t.wireBase64), { reader });
    expect(reader.calls.length).toBe(1);
    expect(new Set(reader.calls[0]).size).toBe(reader.calls[0]!.length);
    expect(Object.keys(s.lookupTables).sort()).toEqual([...new Set(reader.calls[0])].sort());
  });

  it("missing tables leave addresses null and the session incomplete", async () => {
    const t = v0WithTables[0]!;
    const s = await ingestSession([t.wireBase64], { reader: createFixtureAccountReader({}) });
    const tx = s.transactions[0]!;
    expect(s.complete).toBe(false);
    expect(tx.complete).toBe(false);
    expect(tx.lookupProblems.some((p) => p.kind === "table_missing")).toBe(true);
    expect(tx.accounts.filter((a) => a.source.kind === "lookup").every((a) => a.address === null)).toBe(true);
  });

  it("an account owned by another program is not a lookup table", async () => {
    const t = v0WithTables[0]!;
    const fake = Object.fromEntries(
      Object.entries(TABLES).map(([k, v]) => [k, v && { ...v, owner: "11111111111111111111111111111111" }])
    );
    const s = await ingestSession([t.wireBase64], { reader: createFixtureAccountReader(fake) });
    expect(s.transactions[0]!.lookupProblems.every((p) => p.kind === "not_a_lookup_table")).toBe(true);
    expect(s.complete).toBe(false);
  });

  it("without a reader, lookups are an IngestError", async () => {
    await expect(ingestSession([v0WithTables[0]!.wireBase64])).rejects.toMatchObject({ code: "READER_FAILED" });
  });

  it("a failing reader becomes an IngestError", async () => {
    const reader = { getMultipleAccounts: async () => { throw new Error("429"); } };
    await expect(ingestSession([v0WithTables[0]!.wireBase64], { reader })).rejects.toMatchObject({ code: "READER_FAILED" });
  });
});

describe("sessions", () => {
  it("keep input order as stable indices and a deterministic id", async () => {
    const reader = createFixtureAccountReader(TABLES);
    const inputs = TXS.map((t, i) => ({ base64: t.wireBase64, label: `tx${i}` }));
    const a = await ingestSession(inputs, { reader });
    const b = await ingestSession(inputs, { reader });
    expect(a.id).toBe(b.id);
    expect(a.transactions.map((t) => t.index)).toEqual(TXS.map((_, i) => i));
    expect(a.transactions.map((t) => t.label)).toEqual(inputs.map((i) => i.label));
    expect(a.transactions.map((t) => t.signatures[0]?.signature)).toEqual(TXS.map((t) => t.signature));
    expect(a.complete).toBe(true);
    const reversed = await ingestSession([...inputs].reverse(), { reader });
    expect(reversed.id).not.toBe(a.id);
  });

  it("a malformed member names its index", async () => {
    const err = await ingestSession([TXS[0]!.wireBase64, "AAAA"]).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err.transactionIndex).toBe(1);
  });

  it("an empty session is an IngestError", async () => {
    await expect(ingestSession([])).rejects.toBeInstanceOf(IngestError);
  });
});

describe("hostile input (G2: errors, never crashes)", () => {
  const expectErrorOrParse = (input: Uint8Array | string) => {
    try {
      parseTransaction(input);
      return "parsed";
    } catch (e) {
      if (!(e instanceof IngestError)) throw new Error(`non-IngestError escaped: ${String(e)}`);
      return "error";
    }
  };

  it("1,000 random byte arrays produce IngestErrors", () => {
    const rnd = prng(1);
    let errors = 0;
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(rnd() * 1500);
      const b = Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256));
      if (expectErrorOrParse(b) === "error") errors++;
    }
    expect(errors).toBe(1000);
  });

  it("1,000 mutated real transactions never crash", () => {
    const rnd = prng(2);
    const bases = TXS.map((t) => fromBase64(t.wireBase64));
    for (let i = 0; i < 1000; i++) {
      const b = bases[i % bases.length]!.slice();
      const flips = 1 + Math.floor(rnd() * 4);
      for (let f = 0; f < flips; f++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const cut = rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
      expectErrorOrParse(cut);
    }
  });

  it("rejects non-base64, empty and oversized input", () => {
    expect(() => parseTransaction("not base64!")).toThrow(IngestError);
    expect(() => parseTransaction("")).toThrow(IngestError);
    expect(() => parseTransaction(new Uint8Array(70_000))).toThrow(IngestError);
    expect(() => parseTransaction({})).toThrow(IngestError);
  });
});

function fromBase58Safe(s: string | null): Uint8Array {
  if (!s) return new Uint8Array(64);
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = new Uint8Array(64);
  for (let i = 63; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
