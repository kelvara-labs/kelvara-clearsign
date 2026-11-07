// Offline license check (PLAN M5). A license is
//   KSG1.<base64url(JSON {"email","plan","exp"})>.<base64url(Ed25519 signature)>
// signed over the ASCII bytes of "KSG1.<payload part>" with the key whose public half
// is LICENSE_PUBLIC_KEY. exp is Unix seconds. No network: WebCrypto only.
// A license only unlocks the full report text; it never changes what is held or blocked.
import { b58decode } from "../shared/codec.js";
import { LICENSE_PUBLIC_KEY } from "./public-key.js";

export const LICENSE_PREFIX = "KSG1";
export const LICENSE_MAX = 2048;

export interface License {
  email: string;
  plan: string;
  /** Expiry, Unix seconds. */
  exp: number;
}

export type LicenseFailure = "missing" | "malformed" | "bad-signature" | "expired" | "unsupported";
export type LicenseResult = { ok: true; license: License } | { ok: false; reason: LicenseFailure; license?: License };

const FORMAT = /^KSG1\.([A-Za-z0-9_-]{4,1500})\.([A-Za-z0-9_-]{86})$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const PLAN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parsePayload(bytes: Uint8Array): License | null {
  let x: unknown;
  try {
    x = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 3 || !["email", "plan", "exp"].every((k) => keys.includes(k))) return null;
  if (typeof o.email !== "string" || !EMAIL.test(o.email)) return null;
  if (typeof o.plan !== "string" || !PLAN.test(o.plan)) return null;
  if (!Number.isSafeInteger(o.exp) || (o.exp as number) <= 0) return null;
  return { email: o.email, plan: o.plan, exp: o.exp as number };
}

/** The bytes the issuer signs: "KSG1.<payload part>". */
export function signingInput(payloadPart: string): Uint8Array {
  return new TextEncoder().encode(`${LICENSE_PREFIX}.${payloadPart}`);
}

/**
 * Verify a license string. Anything unexpected (bad shape, bad signature, a browser
 * without Ed25519 in WebCrypto) is "not licensed": the user still gets every hold and
 * block, only the limited report.
 */
export async function verifyLicense(
  raw: unknown,
  now: number = Date.now(),
  publicKey: string = LICENSE_PUBLIC_KEY,
  subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<LicenseResult> {
  if (raw === undefined || raw === null || raw === "") return { ok: false, reason: "missing" };
  if (typeof raw !== "string" || raw.length > LICENSE_MAX) return { ok: false, reason: "malformed" };
  const m = FORMAT.exec(raw.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const [, payloadPart = "", sigPart = ""] = m;
  let license: License | null;
  let sig: Uint8Array;
  try {
    license = parsePayload(b64urlDecode(payloadPart));
    sig = b64urlDecode(sigPart);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!license || sig.length !== 64) return { ok: false, reason: "malformed" };
  let valid: boolean;
  try {
    const pk = b58decode(publicKey);
    if (pk.length !== 32) return { ok: false, reason: "unsupported" };
    const key = await subtle.importKey("raw", new Uint8Array(pk), { name: "Ed25519" }, false, ["verify"]);
    valid = await subtle.verify({ name: "Ed25519" }, key, new Uint8Array(sig), new Uint8Array(signingInput(payloadPart)));
  } catch {
    return { ok: false, reason: "unsupported" };
  }
  if (!valid) return { ok: false, reason: "bad-signature" };
  if (license.exp * 1000 <= now) return { ok: false, reason: "expired", license };
  return { ok: true, license };
}

const FAILURE_TEXT: Record<LicenseFailure, string> = {
  missing: "No license: reports show the risk level and top finding only.",
  malformed: "That is not a SignGuard license key.",
  "bad-signature": "That license key's signature does not check out against SignGuard's public key.",
  expired: "This license has expired: reports show the risk level and top finding only.",
  unsupported: "This browser cannot check license signatures (Ed25519 needs Chrome 137 or later): reports show the risk level and top finding only."
};

export const expiryDate = (exp: number): string => new Date(exp * 1000).toISOString().slice(0, 10);

/** One line for the options page. Text only. */
export function describeLicense(r: LicenseResult): string {
  if (r.ok) return `Licensed to ${r.license.email}, plan ${r.license.plan}, valid until ${expiryDate(r.license.exp)} (UTC).`;
  if (r.reason === "expired" && r.license) return `License for ${r.license.email} (plan ${r.license.plan}) expired ${expiryDate(r.license.exp)}. Reports show the risk level and top finding only.`;
  return FAILURE_TEXT[r.reason];
}
