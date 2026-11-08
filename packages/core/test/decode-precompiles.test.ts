// E27: signature-verification precompiles (Ed25519, secp256k1, secp256r1) on real Velocity transactions that carry
// an Ed25519 check (Pyth Lazer oracle update). Malformed layouts are explicit synthetic mutations.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEd25519Instruction, decodeSecp256k1Instruction, decodeSecp256r1Instruction, ED25519_PROGRAM, explainReport, type DecodedInstruction } from "../src/index.js";
import { analyze, decoder, sessionFromRuntime } from "./rules-helpers.js";

const dir = new URL("./fixtures/velocity/", import.meta.url);
const sessions = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const fx = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
  return { f, session: sessionFromRuntime(fx.transaction, fx.meta.loadedAddresses ?? { writable: [], readonly: [] }) };
});
const edIxs = (s: (typeof sessions)[number]): DecodedInstruction[] => decoder.decodeSession(s.session).flat().filter((i) => i.programAddress === ED25519_PROGRAM);

describe("Ed25519 precompile on real transactions", () => {
  it("names every Ed25519SigVerify instruction with signer and message length", () => {
    let seen = 0;
    for (const s of sessions) for (const ix of edIxs(s)) {
      expect(ix.status, s.f).toBe("named");
      expect(ix.decoder).toBe("builtin");
      expect(ix.name).toBe("verifySignatures");
      const sigs = ix.args!.signatures as { signer: string | null; messageLength: number; selfContained: boolean }[];
      expect(ix.args!.numSignatures).toBe(sigs.length);
      for (const g of sigs) {
        // The real Pyth Lazer check holds only offsets: signature, key and message live in instruction 3 (Velocity's).
        expect(g.signer).toBeNull();
        expect(g).toMatchObject({ keyInstruction: 3, keyLength: 32, selfContained: false });
        expect(g.messageLength).toBeGreaterThan(0);
      }
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("states the check as an L0 fact, counts as understood, never asks an intent question, and fixes the header", () => {
    let checked = 0;
    for (const s of sessions) {
      if (!edIxs(s).length) continue;
      const r = analyze(s.session);
      const f = r.claims.filter((c) => c.ruleId === "fact.signature_check");
      expect(f.length, s.f).toBe(edIxs(s).length);
      for (const c of f) {
        expect(c.level).toBe("L0");
        expect(c.statement).toMatch(/^Transaction 0 checks 1 Ed25519 signature \(signer [1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}, \d+-byte message\) inside this transaction; it moves no funds and grants no permission\.$/);
        expect(r.alert.claimIds).not.toContain(c.id);
      }
      expect(r.claims.some((c) => c.ruleId === "fact.unknown_instruction"), s.f).toBe(false);
      expect(explainReport(r).headline).not.toMatch(/Can't fully verify/);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

});

describe("precompile layouts", () => {
  it("rejects malformed Ed25519 / secp256r1 / secp256k1 data (synthetic mutations of the real instruction)", () => {
    const ix = edIxs(sessions.find((x) => edIxs(x).length)!)[0]!;
    const data = ix.data;
    expect(decodeEd25519Instruction(data)).not.toBeNull();
    expect(decodeEd25519Instruction(new Uint8Array())).toBeNull();
    expect(decodeEd25519Instruction(data.subarray(0, 10))).toBeNull();
    const zero = Uint8Array.from(data);
    zero[0] = 0;
    expect(decodeEd25519Instruction(zero)).toBeNull();
    const pad = Uint8Array.from(data);
    pad[1] = 1;
    expect(decodeEd25519Instruction(pad)).toBeNull();
    const far = Uint8Array.from(data);
    far[2 + 4] = 0xff; far[2 + 5] = 0x7f; far[2 + 6] = 0xff; far[2 + 7] = 0xff;
    expect(decodeEd25519Instruction(far)).toBeNull();
    expect(decodeSecp256r1Instruction(new Uint8Array([1, 0]))).toBeNull();
    expect(decodeSecp256k1Instruction(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeSecp256k1Instruction(new Uint8Array())).toBeNull();
  });
});
