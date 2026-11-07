#!/usr/bin/env node
// Issue a SignGuard license (for the human who holds the license private key; agents never run it
// with a real key). Offline, Node only, never bundled into the extension.
//   node packages/extension/scripts/issue-license.mjs --key <path outside the repo> --email a@b.c --plan pro --days 365
// --key: Solana keypair JSON (64 numbers) or a base58 64-byte secret key or 32-byte seed.
// Refuses a key file inside the repo and a key whose public half is not config/license-public-key.txt.
// Format verified by src/license/verify.ts: KSG1.<b64url JSON {email,plan,exp}>.<b64url Ed25519 sig over "KSG1.<payload>">
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58decode = (s) => {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of s) if (c === "1") bytes.unshift(0); else break;
  return Uint8Array.from(bytes);
};
const b58encode = (b) => {
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let s = "";
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (const x of b) if (x === 0) s = "1" + s; else break;
  return s;
};
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const die = (m) => {
  console.error(`issue-license: ${m}`);
  process.exit(1);
};

const keyPath = arg("key");
const email = arg("email");
const plan = arg("plan") ?? "pro";
const days = Number(arg("days") ?? "365");
if (!keyPath || !email) die("usage: --key <path> --email <email> [--plan pro] [--days 365]");
if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) die("bad email");
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(plan)) die("plan: lowercase letters, digits, dashes");
if (!Number.isInteger(days) || days < 1) die("days: a positive integer");

const real = realpathSync(keyPath);
if (real === root || real.startsWith(realpathSync(root) + path.sep)) die("the private key must live outside the repo");
const text = readFileSync(real, "utf8").trim();
let secret;
try {
  secret = text.startsWith("[") ? Uint8Array.from(JSON.parse(text)) : b58decode(text);
} catch {
  die("key file: expected a Solana keypair JSON or a base58 secret key");
}
if (secret.length !== 64 && secret.length !== 32) die("key file: expected 32 or 64 bytes");
const seed = secret.subarray(0, 32);
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
const expected = readFileSync(path.join(root, "config/license-public-key.txt"), "utf8").trim();
if (b58encode(pub) !== expected) die("this key does not match config/license-public-key.txt");

const exp = Math.floor(Date.now() / 1000) + days * 86400;
const part = b64url(JSON.stringify({ email, plan, exp }));
const sig = sign(null, Buffer.from(`KSG1.${part}`), priv);
console.log(`KSG1.${part}.${b64url(sig)}`);
