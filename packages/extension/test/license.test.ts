// X4 license gate: Ed25519 license verified offline; without one, only risk level and top finding.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { limitReport, LIMITED_SUMMARY } from "../src/license/limit.js";
import { LICENSE_PUBLIC_KEY } from "../src/license/public-key.js";
import { b64urlEncode, describeLicense, signingInput, verifyLicense, type License } from "../src/license/verify.js";
import { licenseStatus, removeLicense, saveLicense, type Store } from "../src/options/actions.js";
import { b58encode, b64encode, messageToWireTx } from "../src/shared/codec.js";
import { validateReportView, type ReportView } from "../src/shared/report-view.js";
import type { SignRequest } from "../src/shared/protocol.js";
import type { EngineLike } from "../src/sw/engine-stub.js";
import { decide } from "../src/sw/policy.js";
import { readSettings } from "../src/sw/settings.js";

const subtle = globalThis.crypto.subtle;
const NOW = Date.UTC(2026, 10, 7);
const YEAR = 365 * 24 * 3600;

// Throwaway test issuer generated per run. The real private key is the human's and never enters the repo.
async function issuer() {
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b58encode(new Uint8Array(await subtle.exportKey("raw", kp.publicKey)));
  const sign = async (payload: unknown, raw?: string) => {
    const part = b64urlEncode(new TextEncoder().encode(raw ?? JSON.stringify(payload)));
    const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, kp.privateKey, new Uint8Array(signingInput(part))));
    return `KSG1.${part}.${b64urlEncode(sig)}`;
  };
  return { pub, sign };
}
const LIC: License = { email: "buyer@example.com", plan: "pro", exp: Math.floor(NOW / 1000) + YEAR };

describe("bundled public key", () => {
  it("equals config/license-public-key.txt (G10 looks for it in the bundle)", () => {
    const cfg = readFileSync(fileURLToPath(new URL("../../../config/license-public-key.txt", import.meta.url)), "utf8").trim();
    expect(LICENSE_PUBLIC_KEY).toBe(cfg);
  });
  it("is a 32-byte Ed25519 key WebCrypto accepts", async () => {
    // A well-formed license signed by someone else fails on the signature, not on the key.
    const other = await issuer();
    expect(await verifyLicense(await other.sign(LIC), NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("verifyLicense (offline)", () => {
  it("accepts a license signed by the issuer and returns email, plan, expiry", async () => {
    const { pub, sign } = await issuer();
    expect(await verifyLicense(await sign(LIC), NOW, pub)).toEqual({ ok: true, license: LIC });
    expect(await verifyLicense(`  ${await sign(LIC)}\n`, NOW, pub)).toMatchObject({ ok: true });
  });
  it("rejects a license from another key", async () => {
    const a = await issuer();
    const b = await issuer();
    expect(await verifyLicense(await a.sign(LIC), NOW, b.pub)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("rejects a tampered payload (plan or expiry swapped under the old signature)", async () => {
    const { pub, sign } = await issuer();
    const good = await sign(LIC);
    const sig = good.split(".")[2];
    for (const forged of [{ ...LIC, plan: "enterprise" }, { ...LIC, exp: LIC.exp + 10 * YEAR }, { ...LIC, email: "x@evil.test" }]) {
      const part = b64urlEncode(new TextEncoder().encode(JSON.stringify(forged)));
      expect(await verifyLicense(`KSG1.${part}.${sig}`, NOW, pub)).toEqual({ ok: false, reason: "bad-signature" });
    }
    // One flipped signature character.
    const flipped = good.slice(0, -2) + (good.at(-2) === "A" ? "B" : "A") + good.at(-1);
    expect((await verifyLicense(flipped, NOW, pub)).ok).toBe(false);
  });
  it("expired: not licensed, but the license is returned for the status line", async () => {
    const { pub, sign } = await issuer();
    const old = { ...LIC, exp: Math.floor(NOW / 1000) - 1 };
    expect(await verifyLicense(await sign(old), NOW, pub)).toEqual({ ok: false, reason: "expired", license: old });
    expect(await verifyLicense(await sign({ ...LIC, exp: NOW / 1000 }), NOW, pub)).toMatchObject({ ok: false, reason: "expired" });
  });
  it("missing and malformed", async () => {
    const { pub, sign } = await issuer();
    for (const x of [undefined, null, ""]) expect(await verifyLicense(x, NOW, pub)).toEqual({ ok: false, reason: "missing" });
    const good = await sign(LIC);
    const bad = [
      42,
      {},
      "hello",
      good.replace("KSG1.", "KSG2."),
      good.replace(".", ".."),
      good + "x".repeat(3000),
      `${good.split(".").slice(0, 2).join(".")}.${b64urlEncode(new Uint8Array(63))}`,
      await sign({ ...LIC, extra: 1 }),
      await sign({ email: LIC.email, plan: LIC.plan }),
      await sign({ ...LIC, exp: "2027-01-01" }),
      await sign({ ...LIC, exp: 1.5 }),
      await sign({ ...LIC, email: "no-at-sign" }),
      await sign({ ...LIC, plan: "Pro Plan<script>" }),
      await sign(null, "[1,2,3]"),
      await sign(null, "{not json")
    ];
    for (const x of bad) expect(await verifyLicense(x, NOW, pub), String(x).slice(0, 40)).toEqual({ ok: false, reason: "malformed" });
  });
  it("a browser without Ed25519 in WebCrypto is unlicensed, never an error", async () => {
    const { pub, sign } = await issuer();
    const noEd = { ...subtle, importKey: async () => Promise.reject(new DOMException("Unrecognized name", "NotSupportedError")) } as unknown as SubtleCrypto;
    expect(await verifyLicense(await sign(LIC), NOW, pub, noEd)).toEqual({ ok: false, reason: "unsupported" });
  });
  it("status lines name email, plan, expiry and never echo the key", async () => {
    const { pub, sign } = await issuer();
    const key = await sign(LIC);
    const ok = describeLicense(await verifyLicense(key, NOW, pub));
    expect(ok).toBe(`Licensed to buyer@example.com, plan pro, valid until ${new Date(LIC.exp * 1000).toISOString().slice(0, 10)} (UTC).`);
    expect(ok).not.toContain(key.split(".")[2]);
    expect(describeLicense({ ok: false, reason: "missing" })).toMatch(/risk level and top finding only/);
  });
});

const full: ReportView = {
  title: "Upgrade authority passes to a key outside the session",
  summary: "secret sauce summary",
  simulation: "0 tokens move",
  authorizes: "control of program X",
  capabilities: [
    { rank: 2, change: "revoked", authority: "upgrade authority of X", holder: "you", risk: "high" },
    { rank: 1, change: "granted", authority: "upgrade authority of X", holder: "Attacker111", risk: "critical" }
  ],
  preview: [{ authority: "upgrade authority of X", confidence: "verified", can: [{ name: "can deploy any code", detail: "" }] }],
  claims: [{ id: "c1", kind: "Fact", level: "L3", rule: "authority.transfer", title: "T", text: "t", advice: "a", evidenceIds: ["e1"], moreEvidence: 0 }],
  evidence: [{ id: "e1", type: "instruction", source: "message", summary: "secret sauce evidence", tx: 0, path: "0", address: null, idl: null, fields: [{ key: "args.x", value: "1" }] }],
  messageHashes: ["11111111111111111111111111111111"],
  limited: false
};

describe("limited report", () => {
  it("keeps only the risk header and the top-ranked capability change (plus Ledger hashes)", () => {
    const r = limitReport(full);
    expect(r).toEqual({
      title: full.title,
      summary: LIMITED_SUMMARY,
      simulation: null,
      authorizes: null,
      capabilities: [full.capabilities[1]],
      preview: [],
      claims: [],
      evidence: [],
      messageHashes: full.messageHashes,
      limited: true
    });
    expect(validateReportView(r)).not.toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/secret sauce|0 tokens move|can deploy|"e1"/);
  });
  it("with no capability change the top finding is the first claim, without evidence", () => {
    const r = limitReport({ ...full, capabilities: [], claims: [full.claims[0]!, { ...full.claims[0]!, id: "c2", kind: "Unknown", evidenceIds: [] }] });
    expect(r.claims).toEqual([{ ...full.claims[0]!, evidenceIds: [], moreEvidence: 0 }]);
    expect(r.evidence).toEqual([]);
    expect(validateReportView(r)).not.toBeNull();
    expect(limitReport({ ...full, capabilities: [], claims: [] }).claims).toEqual([]);
  });
  it("the validator requires the limited flag", () => {
    const noFlag: Record<string, unknown> = { ...full };
    delete noFlag.limited;
    expect(validateReportView(noFlag)).toBeNull();
    expect(validateReportView({ ...full, limited: "yes" })).toBeNull();
  });
});

describe("service worker: MVP full reports require no license", () => {
  const tx = b64encode(messageToWireTx(Uint8Array.from([1, 0, 0, 1, ...new Uint8Array(32), ...new Uint8Array(32), 0])));
  const req: SignRequest = { v: 1, kind: "sign", id: "a".repeat(32), method: "solana:signTransaction", wallet: "W", account: null, chain: "solana:devnet", txs: [tx] };
  const settings = { heliusApiKey: "0123abcd-4567-89ef-0123-456789abcdef", network: "devnet" as const, passThrough: false, licenseKey: "KSG1.x.y" };
  const engineAt = (level: 0 | 1 | 2 | 3 | 4): EngineLike => ({
    analyze: async () => {
      const { title, summary, simulation, authorizes, capabilities, preview, claims, evidence } = full;
      return { title, summary, simulation, authorizes, capabilities, preview, claims, evidence, level };
    }
  });
  it("MVP: full report and correct decision at every level without a license", async () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      for (const licenseKey of [undefined, "invalid", settings.licenseKey]) {
        const v = await decide(req, { ...settings, licenseKey }, engineAt(level));
        expect(v).toMatchObject({ level, allow: false, hold: level < 4 });
        expect(v.report?.limited).toBe(false);
        expect(v.report?.summary).toBe(full.summary);
        expect(v.report?.evidence).toEqual(full.evidence);
        expect(v.report?.capabilities).toEqual(full.capabilities);
      }
    }
  });
  it("license is passed through from storage, capped in size", () => {
    expect(readSettings({ licenseKey: "KSG1.a.b" }).licenseKey).toBe("KSG1.a.b");
    expect(readSettings({ licenseKey: "x".repeat(5000) }).licenseKey).toBeUndefined();
    expect(readSettings({ licenseKey: 5 }).licenseKey).toBeUndefined();
  });
});

function memStore(init: Record<string, unknown> = {}, fail: Partial<Record<"get" | "set" | "remove", boolean>> = {}) {
  const data: Record<string, unknown> = { ...init };
  const store: Store = {
    async get(keys) {
      if (fail.get) throw new Error("get");
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      if (fail.set) throw new Error("set");
      Object.assign(data, items);
    },
    async remove(keys) {
      if (fail.remove) throw new Error("remove");
      for (const k of [keys].flat()) delete data[k];
    }
  };
  return { store, data };
}

describe("options: license field", () => {
  it("saves only a license that verifies now", async () => {
    const { pub, sign } = await issuer();
    const verify = (raw: unknown) => verifyLicense(raw, NOW, pub);
    const { store, data } = memStore();
    const expired = await sign({ ...LIC, exp: 1 });
    for (const bad of ["", "junk", expired, await (await issuer()).sign(LIC)]) {
      const o = await saveLicense(store, bad, verify);
      expect(o).toMatchObject({ kind: "err", clearField: false });
      expect(data).toEqual({});
    }
    const key = await sign(LIC);
    const o = await saveLicense(store, `${key}\n`, verify);
    expect(o).toMatchObject({ kind: "ok", clearField: true });
    expect(o.text).toMatch(/License saved\. Licensed to buyer@example\.com, plan pro/);
    expect(data).toEqual({ licenseKey: key });
    expect(await licenseStatus(store, verify)).toMatch(/^Licensed to buyer@example\.com/);
  });
  it("storage failures never report success", async () => {
    const { pub, sign } = await issuer();
    const verify = (raw: unknown) => verifyLicense(raw, NOW, pub);
    expect((await saveLicense(memStore({}, { set: true }).store, await sign(LIC), verify)).kind).toBe("err");
    const r = await removeLicense(memStore({ licenseKey: "k" }, { remove: true }).store);
    expect(r.text).toMatch(/may still be saved/);
    expect(await licenseStatus(memStore({}, { get: true }).store, verify)).toMatch(/Could not read/);
  });
  it("remove clears it; status falls back to limited", async () => {
    const { store, data } = memStore({ licenseKey: "KSG1.x.y" });
    expect(await removeLicense(store)).toMatchObject({ kind: "info", clearField: true });
    expect(data).toEqual({});
    expect(await licenseStatus(store)).toMatch(/No license/);
  });
});
