// Discriminator prefilter for Codama roots. Codama's identifyData walks every instruction of a
// program on each call (37 ms per miss on Drift's 241 instructions). We precompute each
// instruction's constant discriminator bytes and hand parseInstruction a root pruned to the
// instructions whose bytes match. Instructions with a discriminator we cannot precompute stay
// candidates, so pruning never hides a match Codama would have found.
import type { InstructionNode, ProgramNode, RootNode } from "@codama/nodes";
import { fromBase58, fromBase64 } from "../util/encoding.js";

interface Constant {
  offset: number;
  bytes: Uint8Array;
}
interface Candidate {
  node: InstructionNode;
  /** null: discriminator not precomputable, always a candidate. */
  constants: Constant[] | null;
}

const NUMBER_SIZES: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, i8: 1, i16: 2, i32: 4, i64: 8 };

function hex(s: string): Uint8Array | null {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) return null;
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}

/** Encode a constant argument default as bytes, or null when we cannot do it exactly. */
function constantBytes(type: unknown, value: unknown): Uint8Array | null {
  const t = type as { kind?: string; format?: string; endian?: string; size?: number; type?: { kind?: string } };
  const v = value as { kind?: string; number?: number; data?: string; encoding?: string };
  if (t?.kind === "numberTypeNode" && v?.kind === "numberValueNode" && typeof v.number === "number") {
    const size = NUMBER_SIZES[t.format ?? ""];
    if (!size || !Number.isSafeInteger(v.number)) return null;
    let n = BigInt.asUintN(size * 8, BigInt(v.number));
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      out[t.endian === "be" ? size - 1 - i : i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return out;
  }
  if (t?.kind === "fixedSizeTypeNode" && t.type?.kind === "bytesTypeNode" && v?.kind === "bytesValueNode" && typeof v.data === "string") {
    let bytes: Uint8Array | null = null;
    try {
      bytes = v.encoding === "base16" ? hex(v.data) : v.encoding === "base58" ? fromBase58(v.data) : v.encoding === "base64" ? fromBase64(v.data) : null;
    } catch {
      return null;
    }
    return bytes && bytes.length === t.size ? bytes : null;
  }
  return null;
}

function constantsOf(ix: InstructionNode): Constant[] | null {
  const ds = ix.discriminators ?? [];
  if (ds.length === 0) return null;
  const out: Constant[] = [];
  for (const d of ds) {
    if (d.kind === "constantDiscriminatorNode") return null;
    if (d.kind !== "fieldDiscriminatorNode") return null;
    const arg = (ix.arguments ?? []).find((a) => a.name === d.name);
    if (!arg?.defaultValue) return null;
    const bytes = constantBytes(arg.type, arg.defaultValue);
    if (!bytes) return null;
    out.push({ offset: d.offset, bytes });
  }
  return out;
}

const matches = (data: Uint8Array, cs: Constant[]): boolean =>
  cs.every(({ offset, bytes }) => offset + bytes.length <= data.length && bytes.every((b, i) => data[offset + i] === b));

/** Defined types of the program that the given instructions reach through definedTypeLinkNodes (transitively). */
function reachableTypes(program: ProgramNode, instructions: InstructionNode[]): ProgramNode["definedTypes"] {
  const byName = new Map((program.definedTypes ?? []).map((t) => [t.name, t]));
  const seen = new Set<string>();
  const queue: unknown[] = [...instructions];
  while (queue.length) {
    const v = queue.pop();
    if (Array.isArray(v)) {
      for (const x of v) queue.push(x);
    } else if (v && typeof v === "object") {
      const o = v as { kind?: string; name?: string; program?: { name?: string } };
      if (o.kind === "definedTypeLinkNode" && typeof o.name === "string" && (!o.program || o.program.name === program.name) && !seen.has(o.name)) {
        seen.add(o.name);
        const t = byName.get(o.name as never);
        if (t) queue.push(t);
      }
      for (const x of Object.values(o)) if (x && typeof x === "object") queue.push(x);
    }
  }
  return (program.definedTypes ?? []).filter((t) => seen.has(t.name));
}

export interface Prefilter {
  /** A root that holds only this program's candidate instructions for the data, or null when none can match. */
  rootFor(data: Uint8Array): RootNode | null;
}

export function createPrefilter(root: RootNode, program: ProgramNode): Prefilter {
  const candidates: Candidate[] = (program.instructions ?? []).map((node) => ({ node, constants: constantsOf(node) }));
  const cache = new Map<string, RootNode | null>();
  return {
    rootFor(data) {
      const picked = candidates.filter((c) => c.constants === null || matches(data, c.constants));
      if (picked.length === 0) return null;
      const key = picked.map((c) => c.node.name).join(",");
      let pruned = cache.get(key);
      if (pruned === undefined) {
        // Other programs stay (type links may point at them); parseInstruction filters by program address.
        const others = [root.program, ...(root.additionalPrograms ?? [])].filter((p) => p.publicKey !== program.publicKey);
        // Codama re-visits every node of the root it is given on each parse (its visitor dispatch costs a
        // regex case conversion per node: ~13 ms per marginfi call with all 91 instructions' types), so keep
        // only the defined types the candidates reach; accounts, PDAs and errors play no part in parsing.
        const nodes = picked.map((c) => c.node);
        pruned = { ...root, program: { ...program, instructions: nodes, definedTypes: reachableTypes(program, nodes), accounts: [], pdas: [], errors: [] }, additionalPrograms: others };
        if (cache.size < 4096) cache.set(key, pruned);
      }
      return pruned;
    }
  };
}
