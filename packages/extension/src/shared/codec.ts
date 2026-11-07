// Byte helpers shared by the hook, bridge and service worker.
// Ported from sol-sign-preview src/inject.js (ISC), with string guessing removed:
// a value we cannot serialize is an error, and the caller fails closed.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const c of str) {
    const p = B58.indexOf(c);
    if (p < 0) throw new Error("invalid base58");
    let carry = p;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const out = bytes.reverse();
  // strip the leading zero byte produced by the seed [0] unless input was all '1'
  let start = 0;
  while (start < out.length && out[start] === 0) start++;
  const body = out.slice(start);
  const res = new Uint8Array(zeros + body.length);
  res.set(body, zeros);
  return res;
}

export function b64encode(bytes: Uint8Array, btoaFn: (s: string) => string = btoa): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoaFn(s);
}

export function b64decode(str: string, atobFn: (s: string) => string = atob): Uint8Array {
  const bin = atobFn(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isByteView(x: unknown): x is ArrayBufferView {
  return ArrayBuffer.isView(x) && !(x instanceof DataView);
}

/**
 * Wire bytes of a transaction object as handed to a wallet: Uint8Array (Wallet
 * Standard), a web3.js Transaction or VersionedTransaction (legacy providers),
 * or a byte array. Always returns a fresh copy the page cannot mutate.
 */
export function txToBytes(tx: unknown): Uint8Array {
  if (tx == null) throw new Error("no transaction");
  if (isByteView(tx)) return new Uint8Array(tx.buffer.slice(tx.byteOffset, tx.byteOffset + tx.byteLength));
  if (tx instanceof ArrayBuffer) return new Uint8Array(tx.slice(0));
  if (Array.isArray(tx) && tx.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Uint8Array.from(tx as number[]);
  if (typeof tx === "object") {
    const ser = (tx as { serialize?: unknown }).serialize;
    if (typeof ser === "function") {
      let out: unknown;
      try {
        // web3.js legacy Transaction: allow unsigned
        out = ser.call(tx, { requireAllSignatures: false, verifySignatures: false });
      } catch {
        out = ser.call(tx); // VersionedTransaction.serialize() takes no args
      }
      if (isByteView(out)) return txToBytes(out);
    }
  }
  throw new Error("cannot serialize transaction");
}

/**
 * Phantom's request({ method: 'signTransaction', params: { message } }) passes a
 * base58 message, not a transaction. Build the wire transaction with empty
 * signatures so the engine sees the same bytes the wallet will sign.
 */
export function messageToWireTx(message: Uint8Array): Uint8Array {
  if (message.length < 3) throw new Error("message too short");
  const versioned = (message[0]! & 0x80) !== 0;
  const numSigs = versioned ? message[1]! : message[0]!;
  if (numSigs < 1 || numSigs > 127) throw new Error("bad signature count");
  const out = new Uint8Array(1 + 64 * numSigs + message.length);
  out[0] = numSigs;
  out.set(message, 1 + 64 * numSigs);
  return out;
}
