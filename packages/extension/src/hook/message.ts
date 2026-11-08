// Reading the arguments of message-signing calls (signMessage / signIn) into private snapshots.
import { b58decode } from "../shared/codec.js";
import { SIGNIN_STRING_FIELDS, validateSignInInput, type SignInInput } from "../shared/protocol.js";
import type { Pristine } from "./pristine.js";
import { safeGet } from "./wallet-standard.js";

/** A private copy of the bytes to sign; throws on anything but a byte array (or base58 text when allowed). */
export function messageBytes(x: unknown, allowBase58 = false): Uint8Array {
  if (x instanceof Uint8Array) return x.slice();
  if (allowBase58 && typeof x === "string") return b58decode(x);
  throw new Error("message must be bytes");
}

/**
 * A snapshot of a signIn input: only the standard keys, strings only (resources: list of strings).
 * Throws on any other key or type, so nothing the review cannot show ever reaches the wallet.
 */
export function readSignIn(p: Pristine, input: unknown): SignInInput {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("signIn input must be an object");
  const allowed: readonly PropertyKey[] = [...SIGNIN_STRING_FIELDS, "resources"];
  const out: Record<string, unknown> = {};
  for (const key of p.ownKeys(input)) {
    if (!p.getOwnPropertyDescriptor(input, key)?.enumerable) continue;
    if (!allowed.includes(key)) throw new Error("unexpected signIn field");
  }
  for (const key of SIGNIN_STRING_FIELDS) {
    const v = safeGet(p, input, key);
    if (v !== undefined) out[key] = v;
  }
  const resources = safeGet(p, input, "resources");
  if (resources !== undefined) out.resources = Array.isArray(resources) ? resources.slice() : resources;
  if (!validateSignInInput(out)) throw new Error("invalid signIn input");
  return out;
}
