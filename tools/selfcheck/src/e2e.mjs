#!/usr/bin/env node
// G7 e2e: headless Chromium (Playwright's bundled "chromium" channel) with the built extension
// against the test dApp. Specs: test-dapp/e2e (contract in its README.md).
// Steps: build packages/extension -> pick a free port -> playwright test -> classify the JSON report.
// Exit 0 PASS, 1 FAIL, 78 PENDING (cases whose feature has not landed; never for a regression).
// The Helius key goes to the specs through the child env only; output is redacted.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, finish, fail, loadEnv, makeRedactor, pass, pending } from "./lib.mjs";
import { classifyReport, gateVerdict } from "./e2e-checks.mjs";

const HERE = path.resolve(ROOT, "tools/selfcheck");
const LOGS = path.join(HERE, "logs");
const JSON_OUT = path.join(LOGS, "e2e-report.json");
const redact = makeRedactor();

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...opts });
    const pipe = (src, dst) => src.on("data", (d) => dst.write(redact(d.toString())));
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const checks = [];

// 1. Playwright and its bundled Chromium.
const require = createRequire(path.join(HERE, "package.json"));
let pwBin;
try {
  pwBin = path.join(path.dirname(require.resolve("@playwright/test/package.json")), "cli.js");
  const { chromium } = require("@playwright/test");
  const exe = chromium.executablePath();
  if (!existsSync(exe)) {
    checks.push(fail("chromium", `Playwright Chromium missing (${exe}); run: pnpm --filter @kelvara/selfcheck exec playwright install chromium`));
    finish("G7", checks);
  }
} catch (e) {
  checks.push(fail("playwright", `@playwright/test not installed in tools/selfcheck: ${e.message}`));
  finish("G7", checks);
}

// 2. Fresh extension build (the tree under test, not a stale dist).
console.log("G7 building packages/extension");
if ((await run("pnpm", ["--filter", "@kelvara/extension", "build"])) !== 0) {
  checks.push(fail("extension build", "pnpm --filter @kelvara/extension build failed"));
  finish("G7", checks);
}
if (!existsSync(path.join(ROOT, "packages/extension/dist/manifest.json"))) {
  checks.push(fail("extension build", "packages/extension/dist/manifest.json missing after build"));
  finish("G7", checks);
}

// 3. Specs typecheck (Playwright only strips types), then run.
if ((await run(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "test-dapp/e2e/tsconfig.json"])) !== 0) {
  checks.push(fail("spec typecheck", "tsc -p test-dapp/e2e/tsconfig.json failed"));
  finish("G7", checks);
}
mkdirSync(LOGS, { recursive: true });
rmSync(JSON_OUT, { force: true });
const env = { ...process.env, TEST_DAPP_PORT: String(await freePort()), E2E_JSON: JSON_OUT, FORCE_COLOR: "0" };

// 3b. Live localnet cases for the level specs (V10): scenarios S12 sets up admin-local, trap-local and sweep-local
// without attacking and serves them with a fresh blockhash. Script absent -> those cases PENDING; script present
// but failing -> FAIL (owner: scenarios). KELVARA_E2E_CASES_URL set by the caller skips the start.
const CASES_SCRIPT = path.join(ROOT, "packages/scenarios/scripts/e2e-cases.mjs");
const CASES_PORT = Number(process.env.KELVARA_E2E_CASES_PORT ?? "8784");
let casesServer = null;
if (!env.KELVARA_E2E_CASES_URL) {
  if (!existsSync(CASES_SCRIPT)) {
    env.KELVARA_E2E_CASES_MISSING = "packages/scenarios/scripts/e2e-cases.mjs not in this tree (scenarios S12)";
  } else {
    const url = `http://127.0.0.1:${CASES_PORT}`;
    console.log(`G7 starting localnet case server (${path.relative(ROOT, CASES_SCRIPT)} --serve)`);
    const caseLog = createWriteStream(path.join(LOGS, "e2e-cases.log"));
    casesServer = spawn(process.execPath, [CASES_SCRIPT, "--serve"], { cwd: path.dirname(path.dirname(CASES_SCRIPT)), stdio: ["ignore", "pipe", "pipe"] });
    casesServer.stdout.on("data", (d) => caseLog.write(redact(d.toString())));
    casesServer.stderr.on("data", (d) => caseLog.write(redact(d.toString())));
    process.on("exit", () => casesServer?.kill());
    let exited = null;
    casesServer.on("exit", (c) => (exited = c ?? 1));
    const deadline = Date.now() + Number(process.env.KELVARA_E2E_CASES_TIMEOUT_MS ?? 300_000);
    let ok = false, last = "";
    while (Date.now() < deadline && exited === null) {
      try {
        const r = await fetch(`${url}/cases`);
        if (r.ok) {
          const body = await r.json();
          const roles = (body.cases ?? []).map((c) => c.role);
          if (["l3-admin", "l2-trap", "l4-sweep"].every((x) => roles.includes(x))) { ok = true; break; }
          last = `roles ${roles.join(",")}`;
        } else last = `HTTP ${r.status}`;
      } catch (e) { last = e.cause?.code ?? e.message; }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (ok) {
      env.KELVARA_E2E_CASES_URL = url;
      console.log(`G7 localnet cases ready at ${url}`);
    } else {
      const why = exited !== null ? `case server exited ${exited}` : `case server not ready (${last})`;
      checks.push(fail("localnet cases", `${why}; log tools/selfcheck/logs/e2e-cases.log (owner: scenarios)`));
      env.KELVARA_E2E_CASES_MISSING = why;
      casesServer.kill();
    }
  }
}
const key = loadEnv().HELIUS_API_KEY ?? process.env.HELIUS_API_KEY;
if (key) env.HELIUS_API_KEY = key;
const extra = process.argv.slice(2); // e.g. a spec file or -g "pattern" for spot checks
const code = await run(process.execPath, [pwBin, "test", "-c", path.join(HERE, "playwright.config.mjs"), ...extra], { env });

casesServer?.kill();

let report;
try {
  report = JSON.parse(readFileSync(JSON_OUT, "utf8"));
} catch {
  checks.push(fail("playwright", `no JSON report (playwright exit ${code})`));
  finish("G7", checks);
}

// 4. Classify.
const result = classifyReport(report);
for (const e of result.errors) checks.push(fail("playwright error", redact(e)));
for (const c of result.cases) {
  const name = redact(c.name);
  if (c.verdict === "PASS") checks.push(pass(name, "", null));
  else if (c.verdict === "PENDING") checks.push(pending(name, redact(c.detail)));
  else checks.push(fail(name, redact(c.detail)));
}
if (!result.cases.length) checks.push(fail("specs", "no G7 specs ran"));
const counts = (v) => result.cases.filter((c) => c.verdict === v).length;
// A setup failure (e.g. the localnet case server) FAILs the gate even if every spec passed or went PENDING.
const verdict = checks.some((c) => c.status === "FAIL") ? "FAIL" : gateVerdict(result);
if (verdict === "PASS") {
  // One summary line for SELFCHECK.md instead of one per case.
  checks.length = 0;
  checks.push(pass("e2e", "", `${counts("PASS")} e2e cases pass headless`));
} else if (verdict === "PENDING") {
  // Print every case, then summarize by what is missing.
  for (const c of checks) console.log(`G7 ${c.status.padEnd(7)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  const reasons = new Map();
  for (const c of checks.filter((x) => x.status === "PENDING")) {
    const r = c.detail.split(":")[0];
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  checks.length = 0;
  checks.push(pass(`${counts("PASS")} cases pass`));
  for (const [r, n] of reasons) checks.push(pending(`${n} × ${r}`));
}
finish("G7", checks);
