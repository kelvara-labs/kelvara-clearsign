/* global document, setTimeout */
// Dev-only: D3 evidence screenshots. Report step 1 and step 2, popup, options sections at 360/375/1280.
//   node preview/shoot-d3.mjs <siteDir> <outDir>
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, "../../../tools/selfcheck/package.json"))("@playwright/test");
const site = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const port = 47744;
mkdirSync(out, { recursive: true });
const server = spawn("node", [path.join(here, "serve.mjs"), site, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
const base = `http://127.0.0.1:${port}`;
const widths = [[360, 740], [375, 667], [1280, 800]];
const cases = ["L0-memo", "L2-intent", "L3", "L4", "blocked-null", "jupiter", "velocity", "msg-siws-ok", "msg-siws-mismatch", "msg-text", "msg-binary", "msg-hidden-tx"];
const browser = await chromium.launch();
let n = 0;
for (const [w, h] of widths) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const snap = async (name, url, prep, full = false) => {
    await page.goto(`${base}/${url}`);
    await page.waitForTimeout(900);
    if (prep) await prep(page);
    await page.screenshot({ path: path.join(out, `${name}-${w}.png`), fullPage: full });
    n++;
  };
  const frame = (p) => p.frames().find((f) => f.url().includes("report.html"));
  for (const c of cases) {
    await snap(`report-${c}-step1`, `host.html?case=${c}`);
    await snap(`report-${c}-step2`, `host.html?case=${c}`, async (p) => {
      const f = frame(p);
      const yes = await f.$("[data-intent-confirm]");
      if (yes) { await p.waitForTimeout(500); await yes.evaluate((e) => e.scrollIntoView({ block: "center" })); await p.waitForTimeout(200); await yes.click().catch(() => {}); await p.waitForTimeout(500); }
    });
  }
  for (const s of ["ready", "setup", "activity", "error"]) await snap(`popup-${s}`, `popup.html?state=${s}`, null, true);
  for (const sec of ["connection", "network", "ai", "programs", "status", "about"]) {
    await snap(`options-${sec}`, "options.html", async (p) => { await p.evaluate((s) => { if (s === "ai") document.getElementById("ai-provider").open = true; document.getElementById(`sec-${s}`).scrollIntoView(); }, sec); await p.waitForTimeout(300); });
  }
  await snap("options-programs-expanded", "options.html", async (p) => { await p.evaluate(() => { document.querySelectorAll(".list-toggle").forEach((b) => b.click()); document.getElementById("sec-programs").scrollIntoView(); }); await p.waitForTimeout(300); });
  await snap("options-full", "options.html", null, true);
  await page.close();
}
await browser.close();
server.kill();
console.log(n, "screenshots ->", out);
