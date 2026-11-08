/* global document, window, setTimeout */
// Dev-only: screenshots every surface at 360/375/1280 with the repo's Playwright Chromium (headless).
//   node preview/shoot.mjs <outDir> [siteDir]
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, "../../../tools/selfcheck/package.json"))("@playwright/test");
const out = path.resolve(process.argv[2]);
const site = path.resolve(process.argv[3] ?? "/tmp/signguard-design/site");
const port = 47741;
mkdirSync(out, { recursive: true });
const server = spawn("node", [path.join(here, "serve.mjs"), site, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
const base = `http://127.0.0.1:${port}`;
const widths = [[360, 740], [375, 667], [1280, 800]];
const reports = process.argv[4] === "d2" ? ["L2", "L3", "msg-siws-ok", "msg-siws-mismatch", "msg-text", "msg-binary", "msg-hidden-tx"] : ["L0-memo", "L1-spl", "L2", "L2-intent", "L3", "L4", "L4-intent", "poison-intent", "poison-intent-ai", "blocked-null"];
const browser = await chromium.launch();
const shots = [];
for (const [w, h] of widths) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const snap = async (name, url, prep) => {
    await page.goto(`${base}/${url}`);
    await page.waitForTimeout(700);
    if (prep) await prep(page);
    const file = path.join(out, `${name}-${w}.png`);
    await page.screenshot({ path: file, fullPage: name.startsWith("popup") || name.startsWith("options") });
    shots.push(file);
  };
  for (const c of reports) await snap(`report-${c}`, `host.html?case=${c}`);
  const frameOf = (p) => p.frames().find((f) => f.url().includes("report.html"));
  await snap("report-poison-compare-open", "host.html?case=poison-intent", async (p) => { await frameOf(p).evaluate(() => { document.querySelectorAll("details[data-intent-compare], details[data-intent-correction]").forEach((d) => (d.open = true)); document.querySelector("[data-intent-compare]")?.scrollIntoView({ block: "center" }); }); await p.waitForTimeout(200); });
  await snap("report-L3-claim-open", "host.html?case=L3", async (p) => { await frameOf(p).evaluate(() => document.querySelectorAll("details.claim, details.evidence").forEach((d) => (d.open = true))); await p.waitForTimeout(200); });
  await snap("report-L3-scrolled", "host.html?case=L3", async (p) => { await frameOf(p).evaluate(() => { const s = document.querySelector("[data-kelvara-modal]"); s.scrollTop = s.scrollHeight; window.scrollTo(0, 99999); }); await p.waitForTimeout(200); });
  for (const s of ["ready", "setup", "activity", "error"]) await snap(`popup-${s}`, `popup.html?state=${s}`);
  await snap("options", "options.html");
  await snap("options-ai-open", "options.html", (p) => p.evaluate(() => { document.getElementById("ai-provider").open = true; }));
  await snap("options-setup", "options.html?state=setup");
  await snap("options-error", "options.html", async (p) => { await p.fill("#helius-key", "bad key!"); await p.click("#test"); await p.waitForTimeout(300); });
  await snap("options-saved", "options.html", async (p) => { await p.fill("#helius-key", "abcdef12-3456-7890-abcd-ef1234567890"); await p.click("#save"); await p.waitForTimeout(500); });
  await page.close();
}
await browser.close();
server.kill();
console.log(shots.length, "screenshots ->", out);
