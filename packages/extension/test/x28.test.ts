// X28: critical info first. Real recorded L3 admin, L2 trap and L4 sweep reports from the engine's own rules.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fallbackExplanation } from "../src/shared/explanation.js";
import type { ReportView } from "../src/shared/report-view.js";
import { fromReport } from "../src/sw/from-report.js";
import { analyzedState } from "../../core/test/rules-helpers.js";

const CASES = [["admin-local", 3], ["trap-local", 2], ["sweep-local", 4]] as const;
async function real(name: (typeof CASES)[number][0]) {
  const { report } = await analyzedState(name);
  const m = fromReport(report, report.session.transactions.map((t) => t.messageHash));
  if (!m.ok) throw new Error(m.reason);
  return { m, report };
}

describe("critical info first (real admin L3, trap L2, sweep L4)", () => {
  for (const [name, level] of CASES) {
    it(`${name}: short title, at most 3 key risks once each, no evidence prefixes, short explanation`, async () => {
      const { m, report } = await real(name);
      expect(m.level).toBe(level);
      const v = m.report;
      expect(v.title.length).toBeLessThanOrEqual(80);
      expect(v.title).not.toMatch(/;/);
      expect(v.fullTitle).toMatch(/^(Warning|Critical|Blocked): /);
      const alert = report.alert.claimIds;
      const shown = v.keyRisks!.map((k) => k.id);
      expect(shown.length).toBe(Math.min(3, alert.length));
      expect(shown).toEqual(alert.slice(0, shown.length));
      expect(new Set(shown).size).toBe(shown.length);
      expect(v.moreRisks ?? 0).toBe(Math.max(0, alert.length - 1));
      const visible = [v.title, v.summary, v.authorizes ?? "", ...v.claims.map((c) => c.text), ...v.keyRisks!.map((k) => `${k.headline} ${k.text}`)].join("\n");
      expect(visible).not.toMatch(/Proven from|Derived from|Not determined:|Possible, under/);
      const e = fallbackExplanation(v);
      expect(e.sentences.length).toBeLessThanOrEqual(3);
      expect(e.sentences.map((s) => s.text).join(" ")).not.toMatch(/Proven from|Derived from/);
    });
  }
  it("the admin case reads as plain headlines and sentences", async () => {
    const { m } = await real("admin-local");
    expect(m.report.keyRisks!.map((k) => k.headline)).toEqual(["Hands program upgrade control to another key", "Never expires, so it can be submitted later", "Set up by an outside account"]);
    expect(m.report.keyRisks![0]!.text).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44} would get program upgrade control over [1-9A-HJ-NP-Za-km-z]{32,44}\. The current holder loses it\.$/);
  });
});

describe("page layout at 360 px", () => {
  it("each real case renders its key risks once, collapsed findings, no evidence prefixes, and nothing wider than the frame", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const site = mkdtempSync(path.join(tmpdir(), "x28-site-"));
    execFileSync("node", [path.join(here, "../preview/build.mjs"), site], { stdio: "ignore" });
    const verdicts: Record<string, unknown> = {};
    const views: Record<string, ReportView> = {};
    for (const [name] of CASES) {
      const { m } = await real(name);
      views[name] = m.report;
      verdicts[name] = { allow: false, hold: m.level < 4, level: m.level, reason: m.report.title, report: { ...m.report, origin: "https://app.example", network: "mainnet" } };
    }
    writeFileSync(path.join(site, "verdicts.json"), JSON.stringify(verdicts));
    const port = 47890 + Math.floor(Math.random() * 100);
    const server = spawn("node", [path.join(here, "../preview/serve.mjs"), site, String(port)], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 700));
    const { chromium } = createRequire(path.resolve(here, "../../../tools/selfcheck/package.json"))("@playwright/test");
    const browser = await chromium.launch();
    try {
      for (const [name, level] of CASES) {
        const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
        await page.goto(`http://127.0.0.1:${port}/host.html?case=${name}`);
        const frame = await (async () => { for (let i = 0; i < 60; i++) { const f = page.frames().find((x: { url(): string }) => x.url().includes("report.html")); if (f) return f; await page.waitForTimeout(100); } throw new Error("no frame"); })();
        await frame.waitForSelector("#title");
        if (level < 4) {
          await frame.waitForSelector("[data-intent-confirm]");
          for (let i = 0; i < 80; i++) { if (await frame.evaluate(() => !document.querySelector<HTMLButtonElement>("[data-intent-confirm]")?.disabled)) break; await page.waitForTimeout(100); }
          await frame.click("[data-intent-confirm]");
        }
        await frame.waitForSelector("[data-key-risks]");
        const count = await frame.locator("[data-key-risk]").count();
        expect(count, name).toBe(Math.min(3, views[name]!.keyRisks!.length));
        for (const id of views[name]!.keyRisks!.map((k) => k.id)) expect(await frame.locator(`[data-key-risk="${id}"]`).count(), `${name} ${id}`).toBe(1);
        expect(await frame.locator("details.all-findings:not([open])").count(), name).toBe(1);
        expect(await frame.locator("details.collapsed-instructions:not([open])").count(), name).toBe(1);
        const title = await frame.locator("#title").innerText();
        expect(title.length, name).toBeLessThanOrEqual(80);
        const text = await frame.evaluate(() => document.body.innerText);
        expect(text, name).not.toMatch(/Proven from|Derived from the/);
        const offenders = await frame.evaluate(() => {
          const limit = document.documentElement.clientWidth;
          const bad: string[] = [];
          for (const e of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
            if (e.closest("details:not([open]) > :not(summary)")) continue;
            const r = e.getBoundingClientRect();
            if (r.width > 0 && (r.right > limit + 1 || r.left < -1)) bad.push(`${e.tagName}.${e.className} ${Math.round(r.left)}..${Math.round(r.right)} > ${limit}`);
          }
          if (document.documentElement.scrollWidth > limit + 1) bad.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${limit}`);
          return bad;
        });
        expect(offenders, name).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      server.kill();
    }
  }, 180000);
});
