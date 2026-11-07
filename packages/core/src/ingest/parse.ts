// Parse raw bytes (wire transaction or bare message; legacy, v0 or v1) into a ParsedTransaction.
// Decoding is done with @solana/kit codecs; envelope detection, bounds and header checks are ours,
// so any malformed input becomes an IngestError and never an uncaught exception.
import {
  getCompiledTransactionMessageDecoder,
  getShortU16Decoder,
  type Address
} from "@solana/kit";
import { IngestError } from "./errors.js";
import type {
  AddressTableLookup,
  CompiledInstruction,
  IngestInput,
  MessageHeader,
  MessageVersion,
  ParsedTransaction,
  SignatureSlot,
  V1Config
} from "./types.js";
import { fromBase64, sha256Base58, toBase58 } from "../util/encoding.js";

/** v1 transactions may be up to 4 KiB; anything past 64 KiB is not a transaction. */
export const MAX_INPUT_BYTES = 64 * 1024;
const SIG_LEN = 64;
const messageDecoder = getCompiledTransactionMessageDecoder();
const shortU16 = getShortU16Decoder();

// Kit's compiled message shape, read loosely: field presence differs by version.
interface KitCompiledMessage {
  version: MessageVersion;
  header: MessageHeader;
  staticAccounts: Address[];
  lifetimeToken: string;
  instructions?: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
  configValues?: { kind: "u32" | "u64"; value: number | bigint }[];
  configMask?: number;
  instructionHeaders?: { programAccountIndex: number }[];
  instructionPayloads?: { instructionAccountIndices: number[]; instructionData: Uint8Array }[];
}

interface Candidate {
  envelope: "wire" | "message";
  msg: KitCompiledMessage;
  messageBytes: Uint8Array;
  signatures: Uint8Array[];
}

function readMessage(bytes: Uint8Array, offset: number): [KitCompiledMessage, number] | null {
  if (offset >= bytes.length) return null;
  try {
    const [msg, end] = messageDecoder.read(bytes, offset);
    return [msg as unknown as KitCompiledMessage, end];
  } catch {
    return null;
  }
}

function asWireSignaturesFirst(bytes: Uint8Array): Candidate | null {
  let n: number, off: number;
  try {
    [n, off] = shortU16.read(bytes, 0);
  } catch {
    return null;
  }
  const msgStart = off + n * SIG_LEN;
  const r = readMessage(bytes, msgStart);
  if (!r) return null;
  const [msg, end] = r;
  if (msg.version === 1 || end !== bytes.length || n !== msg.header.numSignerAccounts) return null;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++) signatures.push(bytes.slice(off + i * SIG_LEN, off + (i + 1) * SIG_LEN));
  return { envelope: "wire", msg, messageBytes: bytes.slice(msgStart), signatures };
}

function asMessageFirst(bytes: Uint8Array): Candidate[] {
  const r = readMessage(bytes, 0);
  if (!r) return [];
  const [msg, end] = r;
  const out: Candidate[] = [];
  if (end === bytes.length) out.push({ envelope: "message", msg, messageBytes: bytes.slice(), signatures: [] });
  // v1 wire transactions put the message first and the signatures after it.
  if (msg.version === 1 && bytes.length - end === msg.header.numSignerAccounts * SIG_LEN && end < bytes.length) {
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < msg.header.numSignerAccounts; i++) {
      signatures.push(bytes.slice(end + i * SIG_LEN, end + (i + 1) * SIG_LEN));
    }
    out.push({ envelope: "wire", msg, messageBytes: bytes.slice(0, end), signatures });
  }
  return out;
}

function inputBytes(input: IngestInput | Uint8Array | string): { bytes: Uint8Array; kind: "auto" | "wire" | "message" } {
  if (input instanceof Uint8Array) return { bytes: input, kind: "auto" };
  if (typeof input === "string") return { bytes: decodeB64(input), kind: "auto" };
  const kind = input.kind ?? "auto";
  if (input.bytes) return { bytes: input.bytes, kind };
  if (typeof input.base64 === "string") return { bytes: decodeB64(input.base64), kind };
  throw new IngestError("EMPTY_INPUT", "input has neither bytes nor base64");
}

function decodeB64(s: string): Uint8Array {
  const t = s.trim();
  if (t.length > Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 4) throw new IngestError("INPUT_TOO_LARGE", "base64 input too large");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) throw new IngestError("BAD_BASE64", "input is not base64");
  try {
    return fromBase64(t);
  } catch {
    throw new IngestError("BAD_BASE64", "input is not base64");
  }
}

function validate(c: Candidate): void {
  const { header, staticAccounts } = c.msg;
  const n = staticAccounts.length;
  if (
    header.numSignerAccounts < 1 ||
    header.numSignerAccounts > n ||
    header.numReadonlySignerAccounts >= header.numSignerAccounts ||
    header.numReadonlyNonSignerAccounts > n - header.numSignerAccounts
  ) {
    throw new IngestError("BAD_HEADER", "message header is inconsistent with its account list");
  }
  if (new Set(staticAccounts).size !== n) throw new IngestError("DUPLICATE_ACCOUNT", "an account appears twice");
}

function compiledInstructions(msg: KitCompiledMessage): CompiledInstruction[] {
  if (msg.version === 1) {
    const hs = msg.instructionHeaders ?? [];
    const ps = msg.instructionPayloads ?? [];
    return hs.map((h, i) => ({
      programIdIndex: h.programAccountIndex,
      accountIndices: [...(ps[i]?.instructionAccountIndices ?? [])],
      data: new Uint8Array(ps[i]?.instructionData ?? [])
    }));
  }
  return (msg.instructions ?? []).map((ix) => ({
    programIdIndex: ix.programAddressIndex,
    accountIndices: [...(ix.accountIndices ?? [])],
    data: new Uint8Array(ix.data ?? [])
  }));
}

function v1Config(msg: KitCompiledMessage): V1Config | undefined {
  if (msg.version !== 1 || msg.configMask === undefined) return undefined;
  const mask = msg.configMask;
  const values = [...(msg.configValues ?? [])];
  const cfg: V1Config = {};
  if ((mask & 3) === 3) cfg.priorityFeeLamports = BigInt(values.shift()?.value ?? 0);
  if (mask & 4) cfg.computeUnitLimit = Number(values.shift()?.value ?? 0);
  if (mask & 8) cfg.loadedAccountsDataSizeLimit = Number(values.shift()?.value ?? 0);
  if (mask & 16) cfg.heapSize = Number(values.shift()?.value ?? 0);
  return cfg;
}

/** Parse one transaction or bare message. Throws IngestError on anything malformed. */
export function parseTransaction(input: IngestInput | Uint8Array | string): ParsedTransaction {
  const { bytes, kind } = inputBytes(input);
  if (bytes.length === 0) throw new IngestError("EMPTY_INPUT", "input is empty");
  if (bytes.length > MAX_INPUT_BYTES) throw new IngestError("INPUT_TOO_LARGE", `input is ${bytes.length} bytes`);

  const candidates: Candidate[] = [];
  const sigFirst = asWireSignaturesFirst(bytes);
  if (sigFirst) candidates.push(sigFirst);
  candidates.push(...asMessageFirst(bytes));
  // Prefer a wire transaction over a bare message when both readings fit.
  const pick =
    kind === "auto"
      ? candidates.find((c) => c.envelope === "wire") ?? candidates[0]
      : candidates.find((c) => c.envelope === kind);
  if (!pick) {
    throw new IngestError(
      "MALFORMED",
      kind === "auto" ? "bytes are neither a transaction nor a message" : `bytes are not a ${kind === "wire" ? "wire transaction" : "bare message"}`
    );
  }
  validate(pick);

  const { msg } = pick;
  const lookups: AddressTableLookup[] = (msg.addressTableLookups ?? []).map((l) => ({
    lookupTableAddress: l.lookupTableAddress,
    writableIndexes: [...l.writableIndexes],
    readonlyIndexes: [...l.readonlyIndexes]
  }));
  const loadedCount = lookups.reduce((s, l) => s + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  const total = msg.staticAccounts.length + loadedCount;
  if (total > 256) throw new IngestError("BAD_INDEX", `message references ${total} accounts (max 256)`);

  const instructions = compiledInstructions(msg);
  for (const [i, ix] of instructions.entries()) {
    if (ix.programIdIndex >= total || ix.accountIndices.some((a) => a >= total)) {
      throw new IngestError("BAD_INDEX", `instruction ${i} references an account index past ${total - 1}`);
    }
    if (ix.programIdIndex >= msg.staticAccounts.length) {
      throw new IngestError("PROGRAM_FROM_LOOKUP", `instruction ${i} takes its program from a lookup table`);
    }
    if (ix.programIdIndex === 0) {
      throw new IngestError("BAD_INDEX", `instruction ${i} uses the fee payer as its program`);
    }
  }

  const signatures: SignatureSlot[] = msg.staticAccounts.slice(0, msg.header.numSignerAccounts).map((signer, i) => {
    const sig = pick.signatures[i];
    return { signer, signature: sig && sig.some((b) => b !== 0) ? toBase58(sig) : null };
  });

  const parsed: ParsedTransaction = {
    version: msg.version,
    envelope: pick.envelope,
    messageBytes: pick.messageBytes,
    messageHash: sha256Base58(pick.messageBytes),
    header: { ...msg.header },
    staticAccounts: [...msg.staticAccounts],
    lifetimeToken: msg.lifetimeToken,
    signatures,
    addressTableLookups: lookups,
    instructions
  };
  const cfg = v1Config(msg);
  if (cfg) parsed.v1Config = cfg;
  return parsed;
}
