// Canonical JSON (RFC 8785 / JCS shape): object keys sorted by UTF-16 code units, no
// whitespace, ECMAScript number and string serialization. The same value always gives the
// same bytes, so the report digest is stable across runs, Node and the service worker.
import { sha256 } from "../util/sha256.js";
import { toBase64 } from "../util/encoding.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || "$"}`);
    this.name = "CanonicalJsonError";
  }
}

/** Serializes a JSON value canonically. Throws on anything that is not plain JSON (bigint, undefined, NaN, Infinity, functions, class instances). */
export function canonicalJson(value: unknown): string {
  return write(value, "$", new Set());
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number", path);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value}`, path);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError("cycle", path);
  seen.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    out = "[" + obj.map((v, i) => write(v, `${path}[${i}]`, seen)).join(",") + "]";
  } else {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError("not a plain object", path);
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v === undefined) throw new CanonicalJsonError("undefined value", `${path}.${k}`);
      parts.push(JSON.stringify(k) + ":" + write(v, `${path}.${k}`, seen));
    }
    out = "{" + parts.join(",") + "}";
  }
  seen.delete(obj);
  return out;
}

/**
 * Converts decoder output into plain JSON for evidence: bigint -> decimal string,
 * Uint8Array -> { base64 }, Map -> object (keys stringified), undefined object fields dropped,
 * undefined array items -> null. Throws on non-finite numbers and functions.
 */
export function toJsonValue(value: unknown, path = "$"): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number", path);
      return Object.is(value, -0) ? 0 : value;
    case "bigint":
      return value.toString();
    case "undefined":
      return null;
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value}`, path);
  }
  if (value instanceof Uint8Array) return { base64: toBase64(value) };
  if (Array.isArray(value)) return value.map((v, i) => toJsonValue(v, `${path}[${i}]`));
  if (value instanceof Map) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of value) out[String(k)] = toJsonValue(v, `${path}.${String(k)}`);
    return out;
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = toJsonValue(v, `${path}.${k}`);
  }
  return out;
}

const HEX = "0123456789abcdef";
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 15]!;
  return s;
}

/** "sha256:<hex>" over the UTF-8 bytes of the canonical JSON of value. */
export function canonicalDigest(value: unknown): string {
  return "sha256:" + toHex(sha256(new TextEncoder().encode(canonicalJson(value))));
}
