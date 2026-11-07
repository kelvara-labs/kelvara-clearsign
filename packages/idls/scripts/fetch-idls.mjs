#!/usr/bin/env node
/* global fetch, setTimeout, Buffer */
// Fetch and pin the P0 IDLs (E2 spike; extended in M3 by idls:build).
//  - Native programs: the official Codama root (idl.json) from each solana-program repo,
//    at the commit that published the @solana-program/* client we pin.
//  - Anchor programs: the on-chain anchor:idl account over Helius mainnet RPC
//    (8-byte discriminator, 32-byte authority, u32 length, zlib JSON).
// Writes packages/idls/raw/<name>.json and packages/idls/manifest.json.
// Reads HELIUS_API_KEY from the main checkout's .env. Never prints the key.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createAddressWithSeed, getProgramDerivedAddress } from "@solana/kit";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const rawDir = path.join(pkgDir, "raw");
mkdirSync(rawDir, { recursive: true });

const common = execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd: here }).toString().trim();
const envText = readFileSync(path.join(common, "..", ".env"), "utf8");
const key = envText.match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${key}`;
const redact = (s) => String(s).replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    const body = await res.json();
    if (body.error) throw new Error(redact(`${method}: ${JSON.stringify(body.error)}`));
    return body.result;
  }
  throw new Error(`${method}: rate limited`);
}

const NATIVE = [
  { name: "system", programId: "11111111111111111111111111111111", repo: "solana-program/system", commit: "e9cb05138ea802b01f1ddf79ea140dcd765c9db6", client: "@solana-program/system@0.16.0" },
  { name: "token", programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", repo: "solana-program/token", commit: "31646dce3df0a03d468a14913f01b9fd3c3adad0", client: "@solana-program/token@0.18.0" },
  { name: "token-2022", programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", repo: "solana-program/token-2022", commit: "e6b4af36a3dbdfe6f66aaf0c564427fa56671bb0", client: "@solana-program/token-2022@0.20.0" }
];
const ANCHOR = [
  { name: "squads-v4", programId: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf" },
  { name: "drift-v2", programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" }
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const manifest = { generatedAt: new Date().toISOString(), idls: [] };

for (const n of NATIVE) {
  const url = `https://raw.githubusercontent.com/${n.repo}/${n.commit}/idl.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  if (json.kind !== "rootNode") throw new Error(`${n.name}: not a Codama root`);
  writeFileSync(path.join(rawDir, `${n.name}.json`), text);
  manifest.idls.push({ name: n.name, programId: n.programId, format: "codama", source: `github.com/${n.repo}/blob/${n.commit}/idl.json`, client: n.client, commit: n.commit, sha256: sha256(text), verified: false });
}


for (const a of ANCHOR) {
  const [base] = await getProgramDerivedAddress({ programAddress: a.programId, seeds: [] });
  const idlAddress = await createAddressWithSeed({ baseAddress: base, programAddress: a.programId, seed: "anchor:idl" });
  const acct = await rpc("getAccountInfo", [idlAddress, { encoding: "base64", commitment: "finalized" }]);
  if (!acct?.value) throw new Error(`${a.name}: no anchor:idl account at ${idlAddress}`);
  const data = Buffer.from(acct.value.data[0], "base64");
  const authority = (await import("@solana/kit")).getBase58Decoder().decode(data.subarray(8, 40));
  const len = data.readUInt32LE(40);
  const text = inflateSync(data.subarray(44, 44 + len)).toString("utf8");
  const json = JSON.parse(text);
  const pretty = JSON.stringify(json, null, 2) + "\n";
  writeFileSync(path.join(rawDir, `${a.name}.json`), pretty);
  manifest.idls.push({
    name: a.name, programId: a.programId, format: json.metadata?.spec ? `anchor-${json.metadata.spec}` : "anchor-legacy",
    source: `anchor:idl account ${idlAddress} (Helius mainnet)`, slot: acct.context.slot, idlAuthority: authority,
    sha256: sha256(pretty), inflatedSha256: sha256(text),
    // verified needs idlAuthority === upgrade authority; checked in M3 (G5).
    verified: false
  });
}

writeFileSync(path.join(pkgDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const m of manifest.idls) console.log(`${m.name.padEnd(11)} ${m.format.padEnd(13)} ${m.sha256.slice(0, 12)} ${m.source}`);
