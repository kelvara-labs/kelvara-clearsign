import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { sha256 } from "./sha256.js";

const b58dec = getBase58Decoder();
const b58enc = getBase58Encoder();
const b64dec = getBase64Decoder();
const b64enc = getBase64Encoder();

export const toBase58 = (bytes: Uint8Array): string => b58dec.decode(bytes);
export const fromBase58 = (s: string): Uint8Array => new Uint8Array(b58enc.encode(s));
export const toBase64 = (bytes: Uint8Array): string => b64dec.decode(bytes);
export const fromBase64 = (s: string): Uint8Array => new Uint8Array(b64enc.encode(s));
export const sha256Base58 = (bytes: Uint8Array): string => toBase58(sha256(bytes));
