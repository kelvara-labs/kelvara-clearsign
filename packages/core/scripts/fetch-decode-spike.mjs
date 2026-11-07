#!/usr/bin/env node
/* global fetch, setTimeout */
// E2 spike fixtures: real mainnet transactions that invoke each P0 program at top level,
// plus Drift's two attack transactions (PLAN.md section 8). Spike-only: scenarios owns
// fixtures/ and will replace these with fixtures/tx/** for G2.
// Writes packages/core/test/fixtures/decode/spike.json. Reads HELIUS_API_KEY from the
// main checkout's .env and never prints it.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTransactionDecoder, getCompiledTransactionMessageDecoder, getBase64Encoder } from "@solana/kit";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../test/fixtures/decode");
mkdirSync(outDir, { recursive: true });
const common = execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd: here }).toString().trim();
const envText = readFileSync(path.join(common, "..", ".env"), "utf8");
const key = envText.match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const url = `https://mainnet.helius-rpc.com/?api-key=${key}`;
const redact = (s) => String(s).replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    const body = await res.json();
    if (body.error) throw new Error(redact(`${method}: ${JSON.stringify(body.error)}`));
    return body.result;
  }
  throw new Error(`${method}: rate limited`);
}

const getTx = (signature) => rpc("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
const toFixture = (program, signature, tx, label) => ({
  source: "helius-mainnet getTransaction", program, signature, slot: tx.slot, blockTime: tx.blockTime, version: tx.version, label,
  wireBase64: tx.transaction[0], loadedAddresses: tx.meta?.loadedAddresses ?? { writable: [], readonly: [] }
});

function topLevelPrograms(wireBase64) {
  const wire = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  const msg = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
  return (msg.instructions ?? []).map((ix) => msg.staticAccounts[ix.programAddressIndex]);
}

const PROGRAMS = [
  ["system", "11111111111111111111111111111111"],
  ["token", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  ["token-2022", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
  ["squads-v4", "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"],
  ["drift-v2", "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"]
];
const PER_PROGRAM = 3;

const txs = [];
for (const [name, program] of PROGRAMS) {
  let got = 0;
  let before;
  for (let page = 0; page < 5 && got < PER_PROGRAM; page++) {
  const sigs = await rpc("getSignaturesForAddress", [program, { limit: 200, before }]);
  if (!sigs.length) break;
  before = sigs.at(-1).signature;
  for (const s of sigs) {
    if (got >= PER_PROGRAM) break;
    if (s.err) continue;
    const tx = await getTx(s.signature);
    if (!tx || tx.meta?.err) continue;
    if (!topLevelPrograms(tx.transaction[0]).includes(program)) continue;
    txs.push(toFixture(name, s.signature, tx));
    got++;
  }
  }
  console.log(`${name}: ${got}`);
}

const DRIFT_ATTACK = [
  ["2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H", "drift-attack create and approve"],
  ["4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1", "drift-attack approve and execute"],
  ["4a5962Rdqd9pkXtk9DMQ9ZYhdGb2k9gPw71GvukJgELhxbCY5gm1c1hhKdwuGefyqJ3XMvihUTDNDn3qbXnst82X", "drift-attack new admin initialize_spot_market", "drift-v2"]
];
for (const [sig, label, prog = "squads-v4"] of DRIFT_ATTACK) {
  const tx = await getTx(sig);
  if (!tx) { console.log(`${label}: not found`); continue; }
  txs.push(toFixture(prog, sig, tx, label));
  console.log(`${label}: ok`);
}

// Lookup tables referenced by v0 transactions, in the ingest fixture format.
const altSet = new Set();
for (const t of txs) {
  if (t.version === "legacy") continue;
  const wire = getTransactionDecoder().decode(getBase64Encoder().encode(t.wireBase64));
  const msg = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
  for (const l of msg.addressTableLookups ?? []) altSet.add(l.lookupTableAddress);
}
const alts = [...altSet];
const lookupTables = {};
for (let i = 0; i < alts.length; i += 100) {
  const chunk = alts.slice(i, i + 100);
  const r = await rpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
  chunk.forEach((addr, j) => {
    const a = r.value[j];
    lookupTables[addr] = a ? { owner: a.owner, dataBase64: a.data[0], lamports: a.lamports, executable: a.executable, contextSlot: r.context.slot } : null;
  });
}

writeFileSync(path.join(outDir, "spike.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), cluster: "mainnet-beta", transactions: txs, lookupTables }, null, 1) + "\n");
console.log(`wrote ${txs.length} transactions, ${alts.length} lookup tables`);
