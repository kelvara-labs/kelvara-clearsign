#!/usr/bin/env node
// Probe Helius (mainnet, devnet) and localnet: which methods answer, and where rate limiting starts.
// node tools/selfcheck/src/helius-probe.mjs [--burst N] [--skip-burst]
// Reads HELIUS_API_KEY from the main checkout's .env. Every URL and body is redacted before printing.
// Cost: about 10 single calls per network plus one burst of N getSlot calls on devnet and mainnet (1 credit each).
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { loadEnv, makeRedactor } from "./lib.mjs";

const { fetch } = globalThis;

const args = process.argv.slice(2);
const burstIdx = args.indexOf("--burst");
const BURST = burstIdx >= 0 ? Number(args[burstIdx + 1]) : 60;
const skipBurst = args.includes("--skip-burst");
const env = loadEnv();
const key = env.HELIUS_API_KEY ?? process.env.HELIUS_API_KEY;
if (!key) { console.error("HELIUS_API_KEY missing from .env"); process.exit(2); }
const redact = makeRedactor([key]);

const NETS = {
  mainnet: { rpc: `https://mainnet.helius-rpc.com/?api-key=${key}`, api: `https://api.helius.xyz/v0`, sig: "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H" },
  devnet: { rpc: `https://devnet.helius-rpc.com/?api-key=${key}`, api: `https://api-devnet.helius.xyz/v0`, sig: null }
};
const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const USDC = "EPjFWJd5AswuuGZ8eaLnvB6ycMqYMuftz5HyuwzLf8nC";

async function rpc(url, method, params = []) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const ms = Math.round(performance.now() - t0);
    const headers = Object.fromEntries([...res.headers].filter(([k]) => /rate|limit|retry|credit/i.test(k)));
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { http: res.status, ms, headers, error: body?.error, result: body?.result };
  } catch (e) {
    return { http: 0, ms: Math.round(performance.now() - t0), error: { message: e.message } };
  }
}

const brief = (r) => r.http === 200 && !r.error ? `ok ${r.ms}ms` : `http ${r.http}${r.error ? ` err ${JSON.stringify(r.error).slice(0, 120)}` : ""}`;

const report = {};
for (const [net, n] of Object.entries(NETS)) {
  const out = (report[net] = {});
  out.getHealth = brief(await rpc(n.rpc, "getHealth"));
  out.getSlot = brief(await rpc(n.rpc, "getSlot"));
  const acct = await rpc(n.rpc, "getAccountInfo", [SQUADS_V4, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  out.getAccountInfo = brief(acct) + (acct.result ? ` executable=${acct.result.value?.executable}` : "");
  out.getMultipleAccounts = brief(await rpc(n.rpc, "getMultipleAccounts", [[SQUADS_V4, USDC], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]));
  const sigs = await rpc(n.rpc, "getSignaturesForAddress", [SQUADS_V4, { limit: 5 }]);
  out.getSignaturesForAddress = brief(sigs) + (sigs.result ? ` n=${sigs.result.length}` : "");
  const someSig = n.sig ?? sigs.result?.[0]?.signature;
  if (someSig) {
    const tx = await rpc(n.rpc, "getTransaction", [someSig, { encoding: "base64", maxSupportedTransactionVersion: 0 }]);
    out.getTransaction = brief(tx) + (tx.result ? ` slot=${tx.result.slot}` : tx.http === 200 ? " (null)" : "");
  }
  const bh = await rpc(n.rpc, "getLatestBlockhash");
  out.getLatestBlockhash = brief(bh);
  // simulateTransaction with an invalid tx still proves the method is enabled (expects a decode error, not 'method not found').
  const sim = await rpc(n.rpc, "simulateTransaction", ["AQ==", { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
  out.simulateTransaction = sim.error?.code === -32601 ? "method not found" : `enabled (${sim.error ? `err ${sim.error.code}` : "ok"})`;
  out.getAsset_DAS = brief(await rpc(n.rpc, "getAsset", { id: USDC }));
  out.getAssetsByOwner_DAS = brief(await rpc(n.rpc, "getAssetsByOwner", { ownerAddress: SQUADS_V4, page: 1, limit: 1 }));
  out.getPriorityFeeEstimate = brief(await rpc(n.rpc, "getPriorityFeeEstimate", [{ accountKeys: [SQUADS_V4], options: { recommended: true } }]));
  try {
    const t0 = performance.now();
    const res = await fetch(`${n.api}/addresses/${SQUADS_V4}/transactions?api-key=${key}&limit=1`);
    out.enhancedHistory = `http ${res.status} ${Math.round(performance.now() - t0)}ms`;
    await res.text();
  } catch (e) { out.enhancedHistory = `error ${e.message}`; }
  if (someSig) {
    try {
      const res = await fetch(`${n.api}/transactions?api-key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactions: [someSig] }) });
      out.parseTransactions = `http ${res.status}`;
      await res.text();
    } catch (e) { out.parseTransactions = `error ${e.message}`; }
  }

  if (!skipBurst) {
    // Fire BURST getSlot calls at once and count 429s; then a paced 1-second window.
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: BURST }, () => rpc(n.rpc, "getSlot")));
    const wall = Math.round(performance.now() - t0);
    const by = {};
    for (const r of rs) by[r.http] = (by[r.http] ?? 0) + 1;
    const limited = rs.find((r) => r.http === 429);
    out.burst = `${BURST} concurrent getSlot in ${wall}ms -> ${JSON.stringify(by)}`;
    if (limited) out.burst429 = { error: limited.error, headers: limited.headers };
    const okHeaders = rs.find((r) => r.http === 200)?.headers;
    if (okHeaders && Object.keys(okHeaders).length) out.rateHeaders = okHeaders;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Localnet: only if a validator is already up.
const local = await rpc("http://127.0.0.1:8899", "getHealth");
report.localnet = { getHealth: local.http ? brief(local) : "no validator running" };

console.log(redact(JSON.stringify(report, null, 2)));
