// X11: the worker hashes the message bytes core's own parser finds, so the worker's hashes and the
// engine report's hashes agree for legacy, v0 and v1 (message-first) wire transactions. Every
// recorded transaction in fixtures/tx is checked, Kamino's v1 mainnet transactions included.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingestSession, parseTransaction } from "@kelvara/core";
import { b58decode, b58encode, b64decode, b64encode, messageToWireTx } from "../src/shared/codec.js";
import type { SignRequest } from "../src/shared/protocol.js";
import { stubEngine } from "../src/sw/engine-stub.js";
import { decide, messageHashes, wireMessageBytes, type Sha256 } from "../src/sw/policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = (JSON.parse(readFileSync(path.join(ROOT, "fixtures/tx/manifest.json"), "utf8")) as { fixtures: { path: string; slug: string }[] }).fixtures;
const fixtures = manifest.map((m) => ({
  path: m.path,
  slug: m.slug,
  transaction: (JSON.parse(readFileSync(path.join(ROOT, "fixtures", m.path), "utf8")) as { transaction: string }).transaction
}));
const nodeSha256: Sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());
const versionOf = (tx: string) => {
  const b = b64decode(tx);
  if (b[0] === 0x81) return "v1";
  const n = b[0]!; // fixtures have < 128 signatures: one-byte compact-u16
  return b[1 + 64 * n]! & 0x80 ? "v0" : "legacy";
};
const v1 = fixtures.filter((f) => versionOf(f.transaction) === "v1");
const req = (txs: string[]): SignRequest => ({
  v: 1,
  kind: "sign",
  id: "c".repeat(32),
  method: "solana:signTransaction",
  wallet: "W",
  account: null,
  chain: "solana:mainnet",
  txs
});
const settings = { heliusApiKey: "k", network: "mainnet" as const, passThrough: false };

describe("worker message hashes = engine message hashes", () => {
  it("fixtures cover legacy, v0 and v1 (Kamino)", () => {
    expect(fixtures.length).toBeGreaterThan(50);
    const versions = new Set(fixtures.map((f) => versionOf(f.transaction)));
    expect([...versions].sort()).toEqual(["legacy", "v0", "v1"]);
    expect(v1.some((f) => f.slug === "kamino-lending")).toBe(true);
  });

  it("every fixture in fixtures/tx: worker hash == engine messageHash, also as a batch", async () => {
    const txs = fixtures.map((f) => f.transaction);
    const worker = await messageHashes(txs, nodeSha256);
    // core's parser + its own sha256 (what the report carries) for every fixture
    expect(worker).toEqual(txs.map((base64) => parseTransaction({ base64, kind: "wire" }).messageHash));
    // and the full engine session (no RPC: only transactions without lookup tables)
    const noLookups = txs.filter((base64) => parseTransaction({ base64, kind: "wire" }).addressTableLookups.length === 0);
    expect(noLookups.length).toBeGreaterThan(20);
    const session = await ingestSession(noLookups.map((base64) => ({ base64, kind: "wire" as const })));
    expect(session.transactions.map((t) => t.messageHash)).toEqual(await messageHashes(noLookups, nodeSha256));
    // and the default WebCrypto hash agrees with node's
    expect(await messageHashes(txs.slice(0, 5))).toEqual(worker.slice(0, 5));
  });

  it("v1: the hashed message is the prefix before the signatures, not the bytes after them", () => {
    for (const f of v1) {
      const wire = b64decode(f.transaction);
      const msg = wireMessageBytes(f.transaction);
      const n = msg[1]!;
      expect(msg.length).toBe(wire.length - 64 * n);
      expect(Array.from(wire.subarray(0, msg.length))).toEqual(Array.from(msg));
    }
  });

  it("v1 message passed as base58 (Phantom request({ message })) becomes a message-first wire tx with the same hash", async () => {
    for (const f of v1) {
      const msg = wireMessageBytes(f.transaction);
      const wire = messageToWireTx(b58decode(b58encode(msg)));
      expect(wire.length).toBe(msg.length + 64 * msg[1]!);
      expect(await messageHashes([b64encode(wire)], nodeSha256)).toEqual(await messageHashes([f.transaction], nodeSha256));
    }
  });

  it("a v1 request reaches the engine instead of blocking before analysis", async () => {
    const v = await decide(req([v1[0]!.transaction]), settings, stubEngine, nodeSha256);
    expect(v).toMatchObject({ allow: false, hold: true, level: 2 });
    expect(v.report?.messageHashes).toEqual(await messageHashes([v1[0]!.transaction], nodeSha256));
  });
});

describe("fail closed on wire bytes neither can parse", () => {
  const kamino = b64decode(v1[0]!.transaction);
  const legacy = b64decode(fixtures.find((f) => versionOf(f.transaction) === "legacy")!.transaction);
  const bad: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["v1 truncated by one byte", kamino.subarray(0, kamino.length - 1)],
    ["v1 with one byte extra", Uint8Array.from([...kamino, 0])],
    ["v1 with no signatures", kamino.subarray(0, wireMessageBytes(v1[0]!.transaction).length)],
    ["legacy truncated by one byte", legacy.subarray(0, legacy.length - 1)],
    ["legacy with a trailing byte", Uint8Array.from([...legacy, 0])],
    ["signatures only", new Uint8Array([1, ...new Array(64).fill(0)])],
    ["garbage", new Uint8Array([0, 1, 2])]
  ];
  for (const [name, bytes] of bad) {
    it(`${name}: blocked before the engine runs`, async () => {
      let ran = false;
      const engine = { analyze: async () => ((ran = true), stubEngine.analyze(req([]), { ok: true, network: "mainnet", url: "x" } as never)) };
      const v = await decide(req([b64encode(bytes)]), settings, engine, nodeSha256);
      expect(v).toMatchObject({ allow: false, hold: false, level: null, reason: "could not read the transaction message" });
      expect(ran).toBe(false);
      await expect(ingestSession([{ base64: b64encode(bytes), kind: "wire" }])).rejects.toThrow();
    });
  }
  it("a bare message (no signature slots) is not accepted as a wire transaction", async () => {
    const legacyMsg = wireMessageBytes(b64encode(legacy));
    await expect(messageHashes([b64encode(legacyMsg)], nodeSha256)).rejects.toThrow();
  });
});
