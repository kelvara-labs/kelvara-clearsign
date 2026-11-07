import { describe, expect, it } from "vitest";
import { b58decode, b64encode, messageToWireTx, txToBytes } from "../src/shared/codec.js";
import { parseDecision, parseHandshake, parseHookMessage, validateWorkerVerdict } from "../src/shared/protocol.js";
import { pickEndpoint, redactUrl } from "../src/sw/endpoint.js";
import type { EngineLike } from "../src/sw/engine-stub.js";
import { decide } from "../src/sw/policy.js";

const id = "0123456789abcdef0123456789abcdef";
const sign = { v: 1, kind: "sign", id, method: "solana:signTransaction", wallet: "W", chain: null, txs: ["AQID"] };

describe("strict message shapes", () => {
  it("accepts the exact sign shape and rejects anything else", () => {
    expect(parseHookMessage(JSON.stringify(sign))).not.toBeNull();
    expect(parseHookMessage(sign)).toBeNull(); // objects are not accepted, only JSON strings
    expect(parseHookMessage(JSON.stringify({ ...sign, extra: 1 }))).toBeNull();
    expect(parseHookMessage(JSON.stringify({ ...sign, id: "1" }))).toBeNull();
    expect(parseHookMessage(JSON.stringify({ ...sign, method: "eth_sign" }))).toBeNull();
    expect(parseHookMessage(JSON.stringify({ ...sign, chain: "solana:evil" }))).toBeNull();
    expect(parseHookMessage(JSON.stringify({ ...sign, txs: [] }))).toBeNull();
    expect(parseHookMessage(JSON.stringify({ ...sign, txs: ["not base64!"] }))).toBeNull();
    expect(parseHookMessage(JSON.stringify({ ...sign, wallet: "x".repeat(65) }))).toBeNull();
  });
  it("decision, handshake and verdict shapes", () => {
    expect(parseDecision(JSON.stringify({ v: 1, kind: "decision", id, allow: true }))).not.toBeNull();
    expect(parseDecision(JSON.stringify({ v: 1, kind: "decision", id, allow: 1 }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ v: 1, channel: id }))).toBe(id);
    expect(parseHandshake(JSON.stringify({ v: 1, channel: id.toUpperCase() }))).toBeNull();
    const v = { allow: true, hold: false, level: 0, reason: "", report: null };
    expect(validateWorkerVerdict(v)).not.toBeNull();
    expect(validateWorkerVerdict({ allow: true, level: 0, reason: "" })).toBeNull();
    expect(validateWorkerVerdict({ ...v, level: 5 })).toBeNull();
    expect(validateWorkerVerdict({ ...v, allow: "yes" })).toBeNull();
    // hold only at L2/L3 and never together with allow; L4 never allows
    expect(validateWorkerVerdict({ ...v, allow: false, hold: true, level: 3 })).not.toBeNull();
    expect(validateWorkerVerdict({ ...v, allow: false, hold: true, level: 4 })).toBeNull();
    expect(validateWorkerVerdict({ ...v, allow: true, hold: true, level: 2 })).toBeNull();
    expect(validateWorkerVerdict({ ...v, allow: true, level: 4 })).toBeNull();
    expect(validateWorkerVerdict({ ...v, report: { title: "x" } })).toBeNull();
  });
});

describe("codec", () => {
  it("base58 decodes with leading zeros", () => {
    expect(Array.from(b58decode("1112"))).toEqual([0, 0, 0, 1]);
    expect(Array.from(b58decode("Ldp"))).toEqual([1, 2, 3]);
    expect(Array.from(b58decode("LUw"))).toEqual([1, 0, 0]);
  });
  it("builds a wire tx from a legacy or v0 message", () => {
    expect(Array.from(messageToWireTx(new Uint8Array([2, 0, 0])).slice(0, 1))).toEqual([2]);
    expect(messageToWireTx(new Uint8Array([2, 0, 0])).length).toBe(1 + 128 + 3);
    expect(messageToWireTx(new Uint8Array([0x80, 1, 0, 0])).length).toBe(1 + 64 + 4);
  });
  it("copies byte views and refuses strings", () => {
    const a = new Uint8Array([1, 2, 3]);
    const c = txToBytes(a);
    a[0] = 9;
    expect(c[0]).toBe(1);
    expect(() => txToBytes("AQID")).toThrow();
  });
});

describe("service worker policy", () => {
  // A wire transaction: 1 empty signature + a (minimal) legacy message.
  const wire = b64encode(messageToWireTx(new Uint8Array([1, 0, 0, 0])));
  const req = parseHookMessage(JSON.stringify({ ...sign, chain: "solana:devnet", txs: [wire] }))! as never;
  const view = { summary: "", simulation: null, authorizes: null, capabilities: [], preview: [], claims: [] };
  const engine = (level: 0 | 1 | 2 | 3 | 4): EngineLike => ({ analyze: async () => ({ level, title: `L${level}`, ...view }) });
  const s = { heliusApiKey: "k", network: "mainnet" as const, passThrough: false };

  it("no Helius key: held and blocked, and says so", async () => {
    const v = await decide(req, { ...s, heliusApiKey: "" }, engine(0));
    expect(v).toMatchObject({ allow: false, hold: false, level: null, reason: expect.stringContaining("no Helius API key set: request held and blocked") });
    expect(v.report?.title).toMatch(/^Blocked/);
  });
  it("levels: L0/L1 pass, L4 block, L2/L3 held for the user (never allowed by the worker)", async () => {
    const pick = (v: { allow: boolean; hold: boolean }) => [v.allow, v.hold];
    expect(pick(await decide(req, s, engine(0)))).toEqual([true, false]);
    expect(pick(await decide(req, s, engine(1)))).toEqual([true, false]);
    expect(pick(await decide(req, s, engine(2)))).toEqual([false, true]);
    expect(pick(await decide(req, s, engine(3)))).toEqual([false, true]);
    expect(pick(await decide(req, s, engine(4)))).toEqual([false, false]);
  });
  it("an engine report that fails validation blocks", async () => {
    const bad: EngineLike = { analyze: async () => ({ ...view, level: 0, title: "x".repeat(500) }) };
    expect(await decide(req, s, bad)).toMatchObject({ allow: false, hold: false, level: null });
  });
  it("engine error blocks", async () => {
    const bad: EngineLike = { analyze: async () => Promise.reject(new Error("boom")) };
    expect((await decide(req, s, bad)).allow).toBe(false);
  });
  it("endpoints: Helius by chain, localnet without key, redaction", () => {
    const m = pickEndpoint("solana:mainnet", "devnet", "abc");
    expect(m.ok && m.url).toBe("https://mainnet.helius-rpc.com/?api-key=abc");
    const d = pickEndpoint(null, "devnet", "abc");
    expect(d.ok && d.url).toBe("https://devnet.helius-rpc.com/?api-key=abc");
    expect(pickEndpoint("solana:localnet", "mainnet", undefined)).toMatchObject({ ok: true, url: "http://localhost:8899" });
    expect(pickEndpoint("solana:testnet", "mainnet", "abc").ok).toBe(false);
    expect(redactUrl("https://mainnet.helius-rpc.com/?api-key=abc")).toBe("https://mainnet.helius-rpc.com/?api-key=REDACTED");
  });
});
