#!/usr/bin/env node
/* global fetch, setTimeout */
// Fetch real mainnet transactions over Helius for the ingest tests (E1).
// Writes packages/core/test/fixtures/ingest/{transactions,lookup-tables}.json.
// Usage: node packages/core/scripts/fetch-ingest-fixtures.mjs
// Reads HELIUS_API_KEY from the main checkout's .env. Never prints the key.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../test/fixtures/ingest");
const common = execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd: here }).toString().trim();
const envText = readFileSync(path.join(common, "..", ".env"), "utf8");
const key = envText.match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("HELIUS_API_KEY missing from .env");
const url = `https://mainnet.helius-rpc.com/?api-key=${key}`;
const redact = (s) => String(s).replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
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

// Programs whose recent transactions give us both message versions and many lookup tables.
const SOURCES = [
  { program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", want: { 0: 3, legacy: 0, 1: 1 } },
  { program: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", want: { 0: 1, legacy: 2 } },
  { program: "ComputeBudget111111111111111111111111111111", want: { 0: 1, legacy: 2, 1: 2 } },
  { program: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", want: { 0: 1, legacy: 1 } }
];

const txs = [];
for (const { program, want } of SOURCES) {
  const sigs = await rpc("getSignaturesForAddress", [program, { limit: 100 }]);
  const left = { ...want };
  for (const s of sigs) {
    if (s.err) continue;
    if (Object.values(left).every((n) => n <= 0)) break;
    const tx = await rpc("getTransaction", [s.signature, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    if (!tx) continue;
    const v = String(tx.version);
    if (!(left[v] > 0)) continue;
    left[v]--;
    txs.push({
      source: "helius-mainnet getTransaction",
      program,
      signature: s.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      version: tx.version,
      wireBase64: tx.transaction[0],
      loadedAddresses: tx.meta?.loadedAddresses ?? { writable: [], readonly: [] }
    });
  }
}

// Lookup tables referenced by the v0 transactions, read once with getMultipleAccounts.
const { getTransactionDecoder, getCompiledTransactionMessageDecoder, getBase64Encoder } = await import("@solana/kit");
const altSet = new Set();
for (const t of txs) {
  if (t.version !== 0) continue;
  const wire = getTransactionDecoder().decode(getBase64Encoder().encode(t.wireBase64));
  const msg = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
  for (const l of msg.addressTableLookups ?? []) altSet.add(l.lookupTableAddress);
}
const alts = [...altSet];
const tables = {};
for (let i = 0; i < alts.length; i += 100) {
  const chunk = alts.slice(i, i + 100);
  const r = await rpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
  chunk.forEach((addr, j) => {
    const a = r.value[j];
    tables[addr] = a ? { owner: a.owner, dataBase64: a.data[0], lamports: a.lamports, executable: a.executable, contextSlot: r.context.slot } : null;
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "transactions.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), cluster: "mainnet-beta", transactions: txs }, null, 2) + "\n");
writeFileSync(path.join(outDir, "lookup-tables.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), cluster: "mainnet-beta", method: "getMultipleAccounts", accounts: tables }, null, 2) + "\n");
console.log(`wrote ${txs.length} transactions (${txs.filter((t) => t.version === 0).length} v0), ${alts.length} lookup tables`);
