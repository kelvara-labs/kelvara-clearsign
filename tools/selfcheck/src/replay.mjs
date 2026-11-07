#!/usr/bin/env node
// G8 real test: Drift's real attack transactions are flagged, and both devnet scenarios run.
// Inputs (PENDING until they exist):
//   fixtures/tx/drift-replay/<signature>.json         both Drift txs (scenarios layout), sha256 must match bytes
//   packages/cli/package.json "bin.kelvara"            -> node <bin> replay --json [--live] <sig1> <sig2>
//       prints the session report as JSON on stdout; cached fixtures by default, Helius with --live.
//   packages/scenarios/package.json "scenario:admin-devnet", "scenario:trap-devnet"
//       run with KELVARA_CHECK=1: headless end to end on devnet, exit 0 only if the attack was caught
//       and executed as scripted. Devnet needs live RPC and keys, so they run only with --live
//       (KELVARA_LIVE=1); in cached mode they are reported as SKIP and do not block.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, finish, pass, fail, pending, makeRedactor } from "./lib.mjs";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { DRIFT_SIGNATURES, evaluateReplay, parseReportOutput, checkTxFixture } from "./replay-checks.mjs";

const live = process.env.KELVARA_LIVE === "1" || process.argv.includes("--live");
const redact = makeRedactor();
const readJson = (p) => { try { return JSON.parse(readFileSync(path.join(ROOT, p), "utf8")); } catch { return null; } };
const firstLines = (s, n = 3) => redact(s).trim().split("\n").filter(Boolean).slice(-n).join(" | ").slice(0, 240);
const checks = [];

// 0. Drift fixtures: real mainnet bytes, cached with their sha256.
const sha256hex = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
for (const sig of DRIFT_SIGNATURES) {
  const rel = `fixtures/tx/drift-replay/${sig}.json`;
  const name = `drift fixture ${sig.slice(0, 8)}`;
  if (!existsSync(path.join(ROOT, rel))) { checks.push(pending(name, `${rel} not fetched yet`)); continue; }
  const r = checkTxFixture(readJson(rel), sig, sha256hex);
  checks.push(r.status === "PASS" ? pass(name, r.detail, `${name} ok`) : fail(name, r.detail));
}

// 1. Drift replay through the CLI.
const cliPkg = readJson("packages/cli/package.json");
const bin = typeof cliPkg?.bin === "string" ? cliPkg.bin : cliPkg?.bin?.kelvara;
if (!bin) {
  checks.push(pending("drift replay", "packages/cli has no bin.kelvara yet"));
} else {
  const binPath = path.join(ROOT, "packages/cli", bin);
  if (!existsSync(binPath)) {
    checks.push(fail("drift replay", `${path.relative(ROOT, binPath)} missing; run pnpm build`));
  } else {
    const r = spawnSync(process.execPath, [binPath, "replay", "--json", ...(live ? ["--live"] : []), ...DRIFT_SIGNATURES], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 5 * 60_000
    });
    process.stderr.write(redact(r.stderr ?? ""));
    if (r.status !== 0) {
      checks.push(fail("drift replay", `kelvara replay exit ${r.status ?? r.signal}: ${firstLines((r.stderr || r.stdout) ?? "")}`));
    } else {
      const report = parseReportOutput(r.stdout ?? "");
      const ev = report ? evaluateReplay(report) : { status: "FAIL", detail: "stdout is not a JSON report" };
      checks.push(ev.status === "PASS" ? pass("drift replay", ev.detail, `drift ${ev.detail.split(";")[0]}${live ? " (live)" : " (cached)"}`) : fail("drift replay", ev.detail));
    }
  }
}

// 2. Devnet scenarios.
const scen = readJson("packages/scenarios/package.json")?.scripts ?? {};
for (const s of ["scenario:admin-devnet", "scenario:trap-devnet"]) {
  if (!scen[s]) { checks.push(pending(s, "script not defined in packages/scenarios")); continue; }
  if (!live) { checks.push({ name: s, status: "SKIP", detail: "devnet runs only with --live", summary: `${s.split(":")[1]} skipped (cached)` }); continue; }
  const r = spawnSync("pnpm", ["--filter", "@kelvara/scenarios", "run", s], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 10 * 60_000, env: { ...process.env, KELVARA_CHECK: "1" }
  });
  process.stdout.write(redact(r.stdout ?? "") + redact(r.stderr ?? ""));
  checks.push(r.status === 0 ? pass(s, "ok", `${s.split(":")[1]} ok`) : fail(s, `exit ${r.status ?? r.signal}: ${firstLines(r.stdout + r.stderr)}`));
}

finish("G8", checks);
