/* global document, setTimeout, requestAnimationFrame */
// Dev-only: at real viewports, scroll every options control into view and check elementFromPoint at its centre
// hits the control (nothing, e.g. the sticky save bar, covers it). Run after build.mjs: node preview/check-hit.mjs [siteDir]
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, "../../../tools/selfcheck/package.json"))("@playwright/test");
const site = path.resolve(process.argv[2] ?? "/tmp/signguard-design/site");
const server = spawn("node", [path.join(here, "serve.mjs"), site, "47743"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch();
let bad = 0;
for (const [w, h] of [[360, 640], [375, 667], [1280, 800]]) {
  for (const dirty of [false, true]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto("http://127.0.0.1:47743/options.html");
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.getElementById("ai-provider").open = true; });
    if (dirty) await page.fill("#helius-key", "abcdef12-3456-7890-abcd-ef1234567890");
    const ids = await page.evaluate(() => [...document.querySelectorAll("main input, main button, main select, summary, nav a")].filter((e) => !e.classList.contains("visually-hidden")).map((e, i) => { e.setAttribute("data-hit", String(i)); return i; }));
    for (const i of ids) {
      const r = await page.evaluate(async (i) => {
        const e = document.querySelector(`[data-hit="${i}"]`);
        if (!e.getClientRects().length) return { ok: true };
        e.scrollIntoView({ block: "nearest", behavior: "instant" });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const b = e.getBoundingClientRect();
        const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { ok: !!top && (e === top || e.contains(top) || top.contains(e)), name: e.id || e.textContent.trim().slice(0, 24), hit: top && (top.id || top.className || top.tagName) };
      }, i);
      if (!r.ok) { bad++; console.log(`${w}x${h} dirty=${dirty}: ${r.name} covered by ${r.hit}`); }
    }
    await page.close();
  }
}
await browser.close();
server.kill();
console.log(bad ? `${bad} covered controls` : "all controls reachable");
process.exit(bad ? 1 : 0);
