#!/usr/bin/env node
// G8 real test: Drift's real attack transactions are flagged, and both devnet scenarios run.
// Inputs (PENDING until they exist):
//   fixtures/tx/drift-replay/<signature>.json         both Drift txs (scenarios layout), sha256 must match bytes
//   packages/cli/package.json "bin.kelvara"            -> node <bin> replay --json [--live] <sig1> <sig2>
//       prints the session report as JSON on stdout; cached fixtures by default, Helius with --live.
//   packages/scenarios/package.json "scenario:admin-devnet", "scenario:trap-devnet"
//       must exist. With --live (KELVARA_LIVE=1) each runs headless end to end on devnet through
//       packages/scenarios/e2e-devnet/demo-devnet.test.mjs (--reset --attack plus on-chain assertions),
//       spending devnet SOL. In cached mode they are reported as SKIP and do not block: devnet has no
//       cached form, and PLAN.md requires both modes only at M8.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, finish, pass, fail, pending, makeRedactor, loadEnv } from "./lib.mjs";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { DRIFT_SIGNATURES, evaluateReplay, parseReportOutput, checkTxFixture, devnetCommand, evaluateDevnetRun, DEVNET_TEST_FILE } from "./replay-checks.mjs";

const live = process.env.KELVARA_LIVE === "1" || process.argv.includes("--live");
// Children get the key through the environment (never argv or logs), so a plain clean clone works too: the CLI only
// looks in its own git common dir, while loadEnv also follows a local-path origin to the main checkout (V11).
const childEnv = { ...process.env };
{ const k = loadEnv().HELIUS_API_KEY; if (k && !childEnv.HELIUS_API_KEY) childEnv.HELIUS_API_KEY = k; }
const redact = makeRedactor();
const readJson = (p) => { try { return JSON.parse(readFileSync(path.join(ROOT, p), "utf8")); } catch { return null; } };
const firstLines = (s, n = 3) => redact(s).trim().split("\n").filter(Boolean).slice(-n).join(" | ").slice(0, 240);
// node:test failures: the first "Error: ..." line says why; the last lines are only stack frames.
const errorLine = (s) => { const m = redact(s).match(/^\s*(?:\w*Error|AssertionError)[^\n]*:\s[^\n]+/m); return m ? m[0].trim().slice(0, 240) : null; };
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
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 5 * 60_000, env: childEnv
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

// 2. Devnet scenarios: cached mode reports SKIP (no live RPC, no devnet SOL spent); --live runs each one end to end.
const scen = readJson("packages/scenarios/package.json")?.scripts ?? {};
const hasDevnetTest = existsSync(path.join(ROOT, "packages/scenarios", DEVNET_TEST_FILE));
for (const s of ["scenario:admin-devnet", "scenario:trap-devnet"]) {
  const short = s.split(":")[1];
  if (!scen[s]) { checks.push(pending(s, "script not defined in packages/scenarios")); continue; }
  if (!live) { checks.push({ name: s, status: "SKIP", detail: "devnet runs only with --live", summary: `${short} skipped (cached)` }); continue; }
  if (!hasDevnetTest) { checks.push(fail(s, `packages/scenarios/${DEVNET_TEST_FILE} missing`)); continue; }
  const { cmd, args, cwdRel } = devnetCommand(s);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: path.join(ROOT, cwdRel), encoding: "utf8", maxBuffer: 64 << 20, timeout: 20 * 60_000, env: { ...childEnv, KELVARA_CHECK: "1" }
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(redact(out));
  const ev = evaluateDevnetRun(r.status ?? -1, out);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  checks.push(ev.status === "PASS" ? pass(s, `${ev.detail} (${secs}s)`, `${short} ok (live)`) : fail(s, `${ev.detail}: ${errorLine(out) ?? firstLines(out)}`));
}

finish("G8", checks);
