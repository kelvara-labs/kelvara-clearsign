// Message-signing samples for the extension's message review (X17). Pure functions, no dependencies.
import { b64decode } from "./bytes.js";

export type MessageSample = "siws" | "siws-domain-mismatch" | "siws-expired" | "text" | "binary" | "tx";

/** Standard Sign-In With Solana text. */
export interface SiwsFields { domain: string; address: string; uri: string; nonce: string; issuedAt: string; statement?: string; expirationTime?: string; chainId?: string }
export function siwsText(f: SiwsFields): string {
  const lines = [`${f.domain} wants you to sign in with your Solana account:`, f.address, ""];
  if (f.statement) lines.push(f.statement);
  lines.push("", `URI: ${f.uri}`, "Version: 1");
  if (f.chainId) lines.push(`Chain ID: ${f.chainId}`);
  lines.push(`Nonce: ${f.nonce}`, `Issued At: ${f.issuedAt}`);
  if (f.expirationTime) lines.push(`Expiration Time: ${f.expirationTime}`);
  return lines.join("\n");
}

/** signIn input object for this page (domain and URI are the page's own unless overridden). */
export function signInInput(origin: { host: string; origin: string }, address: string, now = Date.now()): SiwsFields & { version: string } {
  return {
    domain: origin.host,
    address,
    statement: "Sign in to the Kelvara test dApp.",
    uri: origin.origin,
    version: "1",
    nonce: "n" + Math.floor(now / 1000).toString(36),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 10 * 60_000).toISOString()
  };
}

/** The bytes a sample message signs. `tx` needs the base64 of a serialized transaction (a real fixture). */
export function sampleMessage(kind: MessageSample, origin: { host: string; origin: string }, address: string, txBase64?: string, now = Date.now()): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const input = signInInput(origin, address, now);
  switch (kind) {
    case "siws":
      return enc(siwsText({ ...input, chainId: "devnet" }));
    case "siws-domain-mismatch":
      return enc(siwsText({ ...input, domain: "evil.example", uri: "https://evil.example/login" }));
    case "siws-expired":
      return enc(siwsText({ ...input, expirationTime: new Date(now - 60_000).toISOString() }));
    case "text":
      return enc("Kelvara test message");
    case "binary":
      return Uint8Array.from([0xff, 0xfe, 0xfd, 0x00, 0x80, 0x81]);
    case "tx":
      if (!txBase64) throw new Error("kind 'tx' needs the base64 of a serialized transaction");
      return b64decode(txBase64);
  }
}
