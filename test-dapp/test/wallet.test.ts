import { describe, expect, it } from "vitest";
import { b58encode, b64decode, b64encode, parseWireTx } from "../src/bytes.js";
import { FixtureKey, FixtureWalletCore } from "../src/wallet.js";

/** Minimal legacy wire tx shape for the parser: n signer slots, keys, one empty blockhash, no instructions. */
function wireTx(signers: Uint8Array[], extraKeys: Uint8Array[] = [], versioned = false): Uint8Array {
  const keys = [...signers, ...extraKeys];
  const msg = [
    ...(versioned ? [0x80] : []),
    signers.length,
    0,
    extraKeys.length,
    keys.length,
    ...keys.flatMap((k) => [...k]),
    ...new Array(32).fill(7), // blockhash
    0, // instructions
    ...(versioned ? [0] : []) // address table lookups
  ];
  return Uint8Array.from([signers.length, ...new Array(64 * signers.length).fill(0), ...msg]);
}

describe("bytes", () => {
  it("base58 matches known vectors", () => {
    expect(b58encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(b58encode(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(b58encode(Uint8Array.from([255]))).toBe("5Q");
  });
  it("base64 round-trips", () => {
    const b = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    expect(b64decode(b64encode(b))).toEqual(b);
  });
  it("parses legacy and v0 signer slots", () => {
    const k = new Uint8Array(32).fill(9);
    for (const v of [false, true]) {
      const p = parseWireTx(wireTx([k], [new Uint8Array(32)], v));
      expect(p.version).toBe(v ? 0 : "legacy");
      expect(p.numRequiredSignatures).toBe(1);
      expect(p.staticKeys[0]).toEqual(k);
    }
  });
});

describe("fixture wallet", () => {
  it("signs its own slot with a verifiable Ed25519 signature", async () => {
    const key = await FixtureKey.generate();
    const other = new Uint8Array(32).fill(3);
    for (const v of [false, true]) {
      const tx = wireTx([other, key.publicKey], [], v);
      const { bytes, signed } = await key.signWireTx(tx);
      expect(signed).toBe(true);
      const p = parseWireTx(bytes);
      expect(bytes.subarray(1, 65)).toEqual(new Uint8Array(64)); // other slot untouched
      const sig = bytes.slice(65, 129);
      const pub = await crypto.subtle.importKey("raw", key.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
      expect(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig as BufferSource, bytes.subarray(p.msgOffset) as BufferSource)).toBe(true);
      expect(bytes.subarray(p.msgOffset)).toEqual(tx.subarray(p.msgOffset)); // message unchanged
    }
  });

  it("returns a transaction it does not sign unchanged", async () => {
    const key = await FixtureKey.generate();
    const tx = wireTx([new Uint8Array(32).fill(1)]);
    const { bytes, signed } = await key.signWireTx(tx);
    expect(signed).toBe(false);
    expect(bytes).toEqual(tx);
    expect(bytes).not.toBe(tx);
  });

  it("counts calls per path before signing and records received bytes", async () => {
    const core = new FixtureWalletCore(await FixtureKey.generate());
    const tx = wireTx([core.key.publicKey]);
    let countDuringSign = -1;
    core.onChange((log) => {
      if (countDuringSign < 0) countDuringSign = log.count;
    });
    await core.signTransactions("ws-register", "solana:signTransaction", [tx]);
    await core.signTransactions("legacy", "legacy:signAllTransactions", [tx, tx]);
    expect(countDuringSign).toBe(1);
    expect(core.log.count).toBe(2);
    expect(core.log.byPath).toEqual({ "ws-register": 1, "ws-app-ready": 0, legacy: 1 });
    expect(core.log.calls[1]!.received).toEqual([b64encode(tx), b64encode(tx)]);
    expect(core.log.calls[0]!.signed).toEqual([true]);
    core.reset();
    expect(core.log.count).toBe(0);
  });
});
