import { describe, expect, it } from "vitest";
import { b64encode } from "../src/bytes.js";
import { sampleMessage, signInInput } from "../src/messages.js";

const origin = { host: "localhost:5174", origin: "http://localhost:5174" };
const ADDRESS = "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez";
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("message samples", () => {
  it("siws is the standard text for the page origin", () => {
    const t = dec(sampleMessage("siws", origin, ADDRESS, undefined, NOW));
    expect(t.split("\n").slice(0, 2)).toEqual(["localhost:5174 wants you to sign in with your Solana account:", ADDRESS]);
    expect(t).toContain("URI: http://localhost:5174\nVersion: 1\nChain ID: devnet\nNonce: ");
    expect(t).toContain("Issued At: 2026-11-08T12:00:00.000Z\nExpiration Time: 2026-11-08T12:10:00.000Z");
  });
  it("mismatch and expired variants differ only where documented", () => {
    expect(dec(sampleMessage("siws-domain-mismatch", origin, ADDRESS, undefined, NOW))).toContain("evil.example wants you");
    expect(dec(sampleMessage("siws-expired", origin, ADDRESS, undefined, NOW))).toContain("Expiration Time: 2026-11-08T11:59:00.000Z");
  });
  it("binary is not UTF-8; tx passes the given bytes through; tx without bytes throws", () => {
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(sampleMessage("binary", origin, ADDRESS))).toThrow();
    const tx = Uint8Array.from([1, 2, 3, 4]);
    expect(Array.from(sampleMessage("tx", origin, ADDRESS, b64encode(tx)))).toEqual([1, 2, 3, 4]);
    expect(() => sampleMessage("tx", origin, ADDRESS)).toThrow();
  });
  it("signIn input is valid for the page", () => {
    expect(signInInput(origin, ADDRESS, NOW)).toMatchObject({ domain: "localhost:5174", uri: "http://localhost:5174", address: ADDRESS, version: "1" });
  });
});
