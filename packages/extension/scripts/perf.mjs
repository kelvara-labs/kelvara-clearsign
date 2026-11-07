#!/usr/bin/env node
// X8 performance budget (PLAN M7): p95 analysis time of the service worker's real engine path
// (createRealEngine().analyze: ingest with account reads, analyzeSession, fromReport) per request.
// Budget: p95 < 1.5 s on localnet, < 3 s on Helius.
//
//   node scripts/perf.mjs --helius [--runs 3] [--limit 30]   recorded mainnet/devnet fixtures (fixtures/tx) on Helius
//   node scripts/perf.mjs --localnet <e2e-cases.json> [--runs 10]  scenarios' localnet G7 cases (S12)
//
// The engine code is bundled with the extension's own esbuild settings (browser platform, production
// defines), so the measured code is the SW's. The Helius key is read from the main checkout's .env and
// never printed; error texts are the engine's fixed strings (no URLs). Output: JSON summary on stdout.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(ext, "../..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i < 0 ? dflt : argv[i + 1];
};
const runs = Number(opt("--runs", argv.includes("--localnet") ? 10 : 3));
const limit = Number(opt("--limit", 30));

function heliusKey() {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
  const env = readFileSync(path.join(common, "..", ".env"), "utf8");
  const m = /^HELIUS_API_KEY=(.*)$/m.exec(env);
  const key = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("HELIUS_API_KEY missing in the main checkout's .env");
  return key;
}

async function loadEngine() {
  const dir = mkdtempSync(path.join(tmpdir(), "kelvara-perf-"));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(
    entry,
    [
      `export { createRealEngine } from ${JSON.stringify(path.join(ext, "src/sw/engine.ts"))};`,
      `export { registry } from ${JSON.stringify(path.join(ext, "src/sw/registry.ts"))};`,
      `export { pickEndpoint } from ${JSON.stringify(path.join(ext, "src/sw/endpoint.ts"))};`,
      `export { messageHashes } from ${JSON.stringify(path.join(ext, "src/sw/policy.ts"))};`
    ].join("\n")
  );
  const out = path.join(dir, "engine.mjs");
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "json-stable-stringify": path.join(repo, "config/esbuild-shims/json-stable-stringify.mjs") },
    logLevel: "error"
  });
  const mod = await import(pathToFileURL(out).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

const sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
};
const round = (x) => (x === null ? null : Math.round(x));

function heliusCases() {
  const manifest = JSON.parse(readFileSync(path.join(repo, "fixtures/tx/manifest.json"), "utf8"));
  // One fixture per program slug and network first (coverage), then the rest, up to --limit.
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const f0 of manifest.fixtures) {
    const f = { ...f0, network: f0.network ?? /^tx\/([a-z]+)\//.exec(f0.path)?.[1] };
    if (f.network !== "mainnet" && f.network !== "devnet") continue;
    const k = `${f.network}/${f.slug}`;
    (seen.has(k) ? rest : first).push(f);
    seen.add(k);
  }
  return [...first, ...rest].slice(0, limit).map((f) => {
    const fx = JSON.parse(readFileSync(path.join(repo, "fixtures", f.path), "utf8"));
    return { name: `${f.network}/${f.slug}/${f.signature.slice(0, 8)}`, chain: `solana:${f.network}`, tx: fx.transaction, account: null };
  });
}

function localnetCases(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  return j.cases.map((c) => ({ name: `localnet/${c.role}`, chain: "solana:localnet", tx: c.tx, account: c.signer ?? null }));
}

async function main() {
  const mode = argv.includes("--localnet") ? "localnet" : argv.includes("--helius") ? "helius" : null;
  if (!mode) throw new Error("pass --helius or --localnet <e2e-cases.json>");
  const cases = mode === "helius" ? heliusCases() : localnetCases(opt("--localnet"));
  const key = mode === "helius" ? heliusKey() : undefined;
  const { createRealEngine, registry, pickEndpoint, messageHashes } = await loadEngine();

  const t0 = performance.now();
  registry();
  const registryMs = performance.now() - t0;

  const engine = createRealEngine();
  const samples = [];
  const perCase = [];
  for (const c of cases) {
    const endpoint = pickEndpoint(c.chain, "mainnet", key);
    if (!endpoint.ok) throw new Error(endpoint.reason);
    const req = { v: 1, kind: "sign", id: "p".repeat(32), method: "solana:signTransaction", wallet: "perf", account: c.account, chain: c.chain, txs: [c.tx] };
    let hashes;
    try {
      hashes = await messageHashes(req.txs, sha256);
    } catch (e) {
      perCase.push({ case: c.name, level: null, error: `not measured: ${e instanceof Error ? e.message : "bad bytes"}`, p50: null, max: null });
      continue;
    }
    const times = [];
    let level = null;
    let error = null;
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      try {
        level = (await engine.analyze(req, endpoint, hashes)).level;
      } catch (e) {
        error = e instanceof Error ? e.message : "error"; // EngineFailure texts are fixed strings
      }
      times.push(performance.now() - s);
    }
    samples.push(...times);
    perCase.push({ case: c.name, level: level === null ? null : `L${level}`, error, p50: round(pct(times, 50)), max: round(Math.max(...times)) });
  }
  const budgetMs = mode === "helius" ? 3000 : 1500;
  const p95 = pct(samples, 95);
  const summary = {
    mode,
    budgetMs,
    cases: cases.length,
    runsPerCase: runs,
    samples: samples.length,
    registryBuildMs: round(registryMs),
    p50: round(pct(samples, 50)),
    p95: round(p95),
    max: round(Math.max(...samples)),
    pass: p95 !== null && p95 < budgetMs,
    perCase
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.pass) process.exitCode = 1;
}

main().catch((e) => {
  // Never print a URL with a key.
  process.stderr.write(`perf: ${String(e?.message ?? e).replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED")}\n`);
  process.exit(2);
});
