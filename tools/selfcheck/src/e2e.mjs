#!/usr/bin/env node
// G7 e2e: headless Chromium (Playwright's bundled "chromium" channel) with the built extension
// against the test dApp. Specs: test-dapp/e2e (contract in its README.md).
// Steps: build packages/extension -> pick a free port -> playwright test -> classify the JSON report.
// Exit 0 PASS, 1 FAIL, 78 PENDING (cases whose feature has not landed; never for a regression).
// The Helius key goes to the specs through the child env only; output is redacted.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
const key = loadEnv().HELIUS_API_KEY ?? process.env.HELIUS_API_KEY;
if (key) env.HELIUS_API_KEY = key;
const extra = process.argv.slice(2); // e.g. a spec file or -g "pattern" for spot checks
const code = await run(process.execPath, [pwBin, "test", "-c", path.join(HERE, "playwright.config.mjs"), ...extra], { env });

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
const verdict = gateVerdict(result);
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
