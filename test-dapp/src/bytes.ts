// Small byte helpers for the fixture wallet: base58, base64, Solana shortvec and wire layout.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Solana compact-u16. Returns [value, bytesRead]. */
export function readShortVec(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw new Error("truncated shortvec");
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  throw new Error("shortvec too long");
}

export interface WireTx {
  /** Offset of the first signature slot. */
  sigOffset: number;
  sigCount: number;
  /** Offset of the message (the bytes that get signed). */
  msgOffset: number;
  /** "legacy" or the version number. */
  version: "legacy" | number;
  numRequiredSignatures: number;
  /** Static account keys; signers are always the first numRequiredSignatures. */
  staticKeys: Uint8Array[];
}

/** Parse just enough of a wire transaction to find signer slots. Throws on malformed input. */
export function parseWireTx(tx: Uint8Array): WireTx {
  const [sigCount, n] = readShortVec(tx, 0);
  const sigOffset = n;
  const msgOffset = sigOffset + 64 * sigCount;
  if (msgOffset >= tx.length) throw new Error("truncated transaction");
  let at = msgOffset;
  const first = tx[at]!;
  let version: "legacy" | number = "legacy";
  if (first & 0x80) {
    version = first & 0x7f;
    at++;
  }
  const numRequiredSignatures = tx[at]!;
  at += 3;
  const [keyCount, kn] = readShortVec(tx, at);
  at += kn;
  if (at + 32 * keyCount > tx.length) throw new Error("truncated account keys");
  const staticKeys: Uint8Array[] = [];
  for (let i = 0; i < keyCount; i++) staticKeys.push(tx.slice(at + 32 * i, at + 32 * (i + 1)));
  return { sigOffset, sigCount, msgOffset, version, numRequiredSignatures, staticKeys };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
