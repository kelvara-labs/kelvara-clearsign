import { AccountRole, type Address } from "@solana/kit";
import { parseInstruction } from "@codama/dynamic-parsers";
import type { RootNode } from "@codama/nodes";
import { fromBase58, fromBase64 } from "../util/encoding.js";
import type { ResolvedInstruction, Session } from "../ingest/types.js";
import { createAnchorFallbackDecoder, type AnchorFallbackDecoder } from "./anchor-fallback.js";
import { createPrefilter, type Prefilter } from "./prefilter.js";
import { BUILTIN_PROGRAMS, type BuiltinProgram } from "./builtin.js";
import type { DecodedAccount, DecodedInstruction, ProgramEntry } from "./types.js";

interface Registered {
  name: string;
  prefilter?: Prefilter;
  fallback?: AnchorFallbackDecoder;
  builtin?: BuiltinProgram["decode"];
}

export interface DecoderOptions {
  /** Register the hand-written decoders (upgradeable loader, Memo). Default true. Registry entries win on the same id. */
  builtins?: boolean;
}

export interface Decoder {
  /** Program ids this decoder can name instructions for. */
  readonly programIds: readonly string[];
  decodeInstruction(ix: ResolvedInstruction): DecodedInstruction;
  /** Decoded top-level instructions of every transaction, by transaction index. */
  decodeSession(session: Session): DecodedInstruction[][];
}

const role = (signer: boolean, writable: boolean): AccountRole =>
  signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;

function baseAccounts(ix: ResolvedInstruction): DecodedAccount[] {
  return ix.accounts.map((a, position) => ({ name: null, position, address: a.address, signer: a.signer, writable: a.writable }));
}

function unknown(ix: ResolvedInstruction, programName: string | null, reason: NonNullable<DecodedInstruction["reason"]>): DecodedInstruction {
  return { index: ix.index, programAddress: ix.programAddress, programName, status: "unknown", decoder: "none", name: null, args: null, accounts: baseAccounts(ix), reason, data: ix.data };
}

const BYTE_ENCODINGS = new Set(["base16", "base58", "base64", "utf8"]);

/**
 * Canonical argument values, shared by both decoders: bytes as Uint8Array, options as the value or
 * null, integers as number (up to 32 bits) or bigint, enums as { __kind, ... }.
 */
export function normalizeCodamaValue(v: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("value too deep");
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "string" && BYTE_ENCODINGS.has(v[0]) && typeof v[1] === "string") {
      return v[0] === "base64" ? fromBase64(v[1]) : v[0] === "base58" ? fromBase58(v[1]) : v[0] === "base16" ? fromHex(v[1]) : new TextEncoder().encode(v[1]);
    }
    return v.map((x) => normalizeCodamaValue(x, depth + 1));
  }
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const o = v as Record<string, unknown>;
    if (o.__option === "None") return null;
    if (o.__option === "Some") return normalizeCodamaValue(o.value, depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      // Enum variants carry __kind; the numeric __discriminator is redundant with it.
      if (k === "__discriminator" && "__kind" in o) continue;
      out[k] = normalizeCodamaValue(x, depth + 1);
    }
    return out;
  }
  return v;
}

function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}

function codamaArgs(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const { discriminator: _d, ...rest } = data as Record<string, unknown>;
  void _d;
  return normalizeCodamaValue(rest) as Record<string, unknown>;
}

/**
 * Build a decoder over a registry of programs. Codama's parseInstruction runs first; the built-in
 * Anchor decoder handles what it cannot. Anything left is Unknown with a reason, never safe.
 * Never throws on instruction bytes.
 */
export function createDecoder(entries: readonly ProgramEntry[], options: DecoderOptions = {}): Decoder {
  const byId = new Map<string, Registered>();
  if (options.builtins !== false) for (const b of BUILTIN_PROGRAMS) byId.set(b.programId, { name: b.name, builtin: b.decode });
  for (const e of entries) {
    const reg: Registered = { name: e.name };
    if (e.root) reg.prefilter = createPrefilter(e.root, { ...e.root.program, publicKey: e.programId as RootNode["program"]["publicKey"] });
    if (e.idl) reg.fallback = createAnchorFallbackDecoder(e.idl);
    byId.set(e.programId, reg);
    // Codama roots carry companion programs (the token roots include the associated token program).
    for (const extra of e.root?.additionalPrograms ?? []) {
      if (!byId.has(extra.publicKey)) byId.set(extra.publicKey, { name: extra.name, prefilter: createPrefilter(e.root as RootNode, extra) });
    }
  }

  function decodeInstruction(ix: ResolvedInstruction): DecodedInstruction {
    const reg = byId.get(ix.programAddress);
    if (!reg) return unknown(ix, null, "program_not_in_registry");
    let sawError = false;

    if (reg.builtin) {
      let d;
      try {
        d = reg.builtin(ix.data);
      } catch {
        return unknown(ix, reg.name, "args_did_not_decode");
      }
      if (!d) return unknown(ix, reg.name, "no_matching_instruction");
      const accounts = baseAccounts(ix);
      for (const acc of accounts) acc.name = d.accountNames[acc.position] ?? d.restAccountName ?? null;
      return { index: ix.index, programAddress: ix.programAddress, programName: reg.name, status: "named", decoder: "builtin", name: d.name, args: d.args, accounts, data: ix.data };
    }

    const root = reg.prefilter?.rootFor(ix.data);
    if (root) {
      try {
        const parsed = parseInstruction(root, {
          programAddress: ix.programAddress,
          // Unresolved lookup addresses get a placeholder; parsing is positional and we map back by position.
          accounts: ix.accounts.map((a) => ({ address: (a.address ?? ("11111111111111111111111111111111" as Address)), role: role(a.signer, a.writable) })),
          data: ix.data
        });
        if (parsed) {
          const accounts = baseAccounts(ix);
          parsed.accounts.forEach((a, i) => {
            const acc = accounts[i];
            if (acc) acc.name = a.name;
          });
          const node = parsed.path[parsed.path.length - 1] as { name: string };
          return { index: ix.index, programAddress: ix.programAddress, programName: reg.name, status: "named", decoder: "codama", name: node.name, args: codamaArgs(parsed.data), accounts, data: ix.data };
        }
      } catch {
        sawError = true;
      }
    }

    if (reg.fallback) {
      try {
        const d = reg.fallback.decode(ix.data);
        if (d) {
          const accounts = baseAccounts(ix);
          d.accountNames.forEach((name, i) => {
            const acc = accounts[i];
            if (acc) acc.name = name;
          });
          return { index: ix.index, programAddress: ix.programAddress, programName: reg.name, status: "named", decoder: "anchor-fallback", name: d.name, args: d.args, accounts, data: ix.data };
        }
      } catch {
        return unknown(ix, reg.name, "args_did_not_decode");
      }
    }
    return unknown(ix, reg.name, sawError ? "decoder_error" : "no_matching_instruction");
  }

  return {
    programIds: [...byId.keys()],
    decodeInstruction,
    decodeSession: (session) => session.transactions.map((t) => t.instructions.map(decodeInstruction))
  };
}
