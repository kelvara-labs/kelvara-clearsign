// Built-in Anchor decoder: 8-byte discriminator plus Borsh arguments.
// Used only for a program whose IDL Codama could not convert (PLAN.md, "Fallback").
// Throws on anything it cannot read; the caller turns that into Unknown.
import { sha256 } from "../util/sha256.js";
import { toBase58 } from "../util/encoding.js";
import type { AnchorIdlAccountItem, AnchorIdlInstruction, AnchorIdlJson, AnchorIdlType, AnchorIdlTypeDef } from "./types.js";

const MAX_DEPTH = 32;
const MAX_LEN = 1 << 20;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** heck-style snake_case as Anchor uses for sighashes: "initializeSpotMarket" -> "initialize_spot_market". */
export function anchorSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Anchor instruction discriminator: the IDL's own (0.1.0 spec) or sha256("global:<snake_name>")[0..8]. */
export function anchorInstructionDiscriminator(ix: AnchorIdlInstruction): Uint8Array {
  if (ix.discriminator) return Uint8Array.from(ix.discriminator);
  return sha256(textEncoder.encode(`global:${anchorSnakeCase(ix.name)}`)).subarray(0, 8);
}

export const toCamelCase = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Flatten nested account groups (legacy IDLs nest composite accounts) in declaration order. */
export function flattenAnchorAccounts(items: AnchorIdlAccountItem[], prefix = ""): string[] {
  const out: string[] = [];
  for (const item of items) {
    const name = prefix ? `${prefix}.${toCamelCase(item.name)}` : toCamelCase(item.name);
    if (Array.isArray(item.accounts)) out.push(...flattenAnchorAccounts(item.accounts as AnchorIdlAccountItem[], name));
    else out.push(name);
  }
  return out;
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw new RangeError("borsh: out of bounds");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  uint(bytes: number): bigint {
    const b = this.take(bytes);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] as number);
    return v;
  }
  int(bytes: number): bigint {
    const u = this.uint(bytes);
    const bits = BigInt(bytes * 8);
    return u >= 1n << (bits - 1n) ? u - (1n << bits) : u;
  }
  u32(): number {
    return Number(this.uint(4));
  }
}

/** Decode an IDL-defined Borsh value; account padding may follow the value. */
export function decodeAnchorType(data: Uint8Array, type: AnchorIdlType, types: AnchorIdlTypeDef[]): unknown {
  return readType(new Reader(data), type, new Map(types.map((d) => [d.name, d])), 0);
}

type Defs = Map<string, AnchorIdlTypeDef>;

function definedName(t: Record<string, unknown>): string {
  const d = t.defined;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string") return (d as { name: string }).name;
  throw new Error("borsh: bad defined type");
}

function readFields(r: Reader, fields: unknown[], defs: Defs, depth: number): Record<string, unknown> | unknown[] {
  if (fields.length > 0 && typeof fields[0] === "object" && fields[0] !== null && "name" in (fields[0] as object)) {
    const out: Record<string, unknown> = {};
    for (const f of fields as { name: string; type: AnchorIdlType }[]) out[toCamelCase(f.name)] = readType(r, f.type, defs, depth + 1);
    return out;
  }
  return (fields as AnchorIdlType[]).map((t) => readType(r, t, defs, depth + 1));
}

function readType(r: Reader, t: AnchorIdlType, defs: Defs, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("borsh: type too deep");
  if (typeof t === "string") {
    switch (t) {
      case "bool": {
        const b = r.take(1)[0];
        if (b !== 0 && b !== 1) throw new Error("borsh: bad bool");
        return b === 1;
      }
      case "u8": return Number(r.uint(1));
      case "i8": return Number(r.int(1));
      case "u16": return Number(r.uint(2));
      case "i16": return Number(r.int(2));
      case "u32": return Number(r.uint(4));
      case "i32": return Number(r.int(4));
      case "u64": return r.uint(8);
      case "i64": return r.int(8);
      case "u128": return r.uint(16);
      case "i128": return r.int(16);
      case "f32": return new DataView(r.take(4).slice().buffer).getFloat32(0, true);
      case "f64": return new DataView(r.take(8).slice().buffer).getFloat64(0, true);
      case "publicKey":
      case "pubkey": return toBase58(r.take(32));
      case "string": {
        const n = r.u32();
        if (n > MAX_LEN) throw new Error("borsh: string too long");
        return textDecoder.decode(r.take(n));
      }
      case "bytes": {
        const n = r.u32();
        if (n > MAX_LEN) throw new Error("borsh: bytes too long");
        return r.take(n).slice();
      }
      default: throw new Error(`borsh: unsupported type ${t}`);
    }
  }
  if ("vec" in t) {
    const n = r.u32();
    if (n > MAX_LEN) throw new Error("borsh: vec too long");
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(readType(r, t.vec as AnchorIdlType, defs, depth + 1));
    return out;
  }
  if ("option" in t) {
    const tag = r.take(1)[0];
    if (tag === 0) return null;
    if (tag !== 1) throw new Error("borsh: bad option tag");
    return readType(r, t.option as AnchorIdlType, defs, depth + 1);
  }
  if ("coption" in t) {
    const tag = r.u32();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error("borsh: bad coption tag");
    return readType(r, t.coption as AnchorIdlType, defs, depth + 1);
  }
  if ("array" in t) {
    const [inner, n] = t.array as [AnchorIdlType, number];
    if (typeof n !== "number" || n > MAX_LEN) throw new Error("borsh: bad array length");
    if (inner === "u8") return r.take(n).slice();
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(readType(r, inner, defs, depth + 1));
    return out;
  }
  if ("defined" in t) {
    const def = defs.get(definedName(t));
    if (!def) throw new Error(`borsh: unknown type ${definedName(t)}`);
    const k = def.type;
    if (k.kind === "struct") return readFields(r, k.fields ?? [], defs, depth);
    if (k.kind === "type" && k.alias !== undefined) return readType(r, k.alias, defs, depth + 1);
    if (k.kind === "enum") {
      const tag = r.take(1)[0] as number;
      const variant = k.variants?.[tag];
      if (!variant) throw new Error("borsh: bad enum tag");
      const name = toCamelCase(variant.name);
      if (!variant.fields || variant.fields.length === 0) return { __kind: name };
      // Same shape as Codama: struct variants spread their fields, tuple variants keep a fields array.
      const f = readFields(r, variant.fields, defs, depth);
      return Array.isArray(f) ? { __kind: name, fields: f } : { __kind: name, ...f };
    }
  }
  throw new Error("borsh: unsupported type");
}

/** How often each defined type is referenced anywhere in the IDL (Codama's defined type histogram). */
function definedTypeCounts(idl: AnchorIdlJson): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 64 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if ("defined" in o) {
      try {
        const n = definedName(o);
        counts.set(n, (counts.get(n) ?? 0) + 1);
      } catch { /* malformed: ignore */ }
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  const rest = idl as unknown as Record<string, unknown>;
  walk([idl.instructions.map((i) => i.args), idl.types, rest.accounts, rest.events], 0);
  return counts;
}

/**
 * Codama's anchor import inlines a defined struct used exactly once in the whole IDL as a direct
 * instruction argument, then flattens its fields to the top level. The fallback mirrors that.
 */
function flattensLikeCodama(t: AnchorIdlType, defs: Defs, counts: Map<string, number>): boolean {
  if (typeof t === "string" || !("defined" in t)) return false;
  if (counts.get(definedName(t)) !== 1) return false;
  const def = defs.get(definedName(t));
  const f = def?.type.kind === "struct" ? def.type.fields ?? [] : [];
  return f.length > 0 && typeof f[0] === "object" && f[0] !== null && "name" in (f[0] as object);
}

export interface AnchorDecoded {
  name: string;
  args: Record<string, unknown>;
  accountNames: string[];
}

export interface AnchorFallbackDecoder {
  decode(data: Uint8Array): AnchorDecoded | undefined;
}

/** Build a decoder from an Anchor IDL. decode returns undefined when no discriminator matches; throws when args do not decode. */
export function createAnchorFallbackDecoder(idl: AnchorIdlJson): AnchorFallbackDecoder {
  const defs: Defs = new Map((idl.types ?? []).map((d) => [d.name, d]));
  const counts = definedTypeCounts(idl);
  const byDisc = new Map<string, AnchorIdlInstruction>();
  for (const ix of idl.instructions) byDisc.set(toBase58(anchorInstructionDiscriminator(ix)), ix);
  return {
    decode(data) {
      if (data.length < 8) return undefined;
      const ix = byDisc.get(toBase58(data.subarray(0, 8)));
      if (!ix) return undefined;
      const r = new Reader(data);
      r.offset = 8;
      const args: Record<string, unknown> = {};
      for (const a of ix.args) {
        const v = readType(r, a.type, defs, 0);
        // Match Codama's flattenInstructionDataArgumentsVisitor: a struct argument's fields go to the top level.
        if (flattensLikeCodama(a.type, defs, counts) && v && typeof v === "object" && !Array.isArray(v)) Object.assign(args, v);
        else args[toCamelCase(a.name)] = v;
      }
      return { name: toCamelCase(ix.name), args, accountNames: flattenAnchorAccounts(ix.accounts) };
    }
  };
}
