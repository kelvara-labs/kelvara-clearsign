// V16 Options (X18 + D2): segmented network control, Test keeps the unsaved form, Save keeps the chosen network,
// provider base URL normalization, collapsed AI section and sticky Save bar never covering a focused input.
// No key and no provider secret is used. Runs on a temp dist copy that grants http://127.0.0.1/* (see ai-support.ts).
import { AI_DIR, saveProvider, startMock } from "./ai-support.js";
import { expect, test, type Ext } from "./support.js";
import type { Page } from "../../tools/selfcheck/src/playwright.mjs";

test.use({ extDir: AI_DIR });

const stored = (ext: Ext) => ext.sw.evaluate(async () => {
  const c = (globalThis as unknown as { chrome: { storage: { local: { get(k: string[]): Promise<Record<string, unknown>> } } } }).chrome;
  return await c.storage.local.get(["network", "aiProvider"]);
});

async function openOptions(ext: Ext, size?: { width: number; height: number }): Promise<Page> {
  const page = await ext.context.newPage();
  if (size) await page.setViewportSize(size);
  await page.goto(`chrome-extension://${ext.extId}/options.html`);
  return page;
}

test("Devnet via the segmented control: Test connection (no key) keeps the form; Save stores devnet and the select stays devnet", async ({ ext }) => {
  const page = await openOptions(ext);
  const seg = page.locator('.segmented button[data-value="devnet"]');
  await expect(seg, "visible segmented network control").toBeVisible();
  await seg.click();
  await expect(page.locator("#network")).toHaveValue("devnet");
  await page.locator("#test").click();
  await expect(page.locator("#result")).toContainText(/^Devnet:/);
  await expect(page.locator("#network"), "Test must not reset the unsaved network").toHaveValue("devnet");
  await expect(seg).toHaveAttribute("aria-checked", "true");
  await page.locator("#save").click();
  await expect.poll(async () => (await stored(ext)).network).toBe("devnet");
  await expect(page.locator("#network")).toHaveValue("devnet");
  await expect(seg).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.locator("#network")).toHaveValue("devnet");
  await page.close();
});

test("AI base URL .../v1 is saved as .../v1/chat/completions and #ai-url shows the normalized URL", async ({ ext }) => {
  const mock = await startMock("select-highest");
  try {
    await saveProvider(ext, `${mock.url}/v1`);
    const saved = (await stored(ext)).aiProvider as { url: string };
    expect(saved.url).toBe(`${mock.url}/v1/chat/completions`);
    const page = await openOptions(ext);
    await expect(page.locator("#ai-provider")).not.toHaveAttribute("open", /.*/);
    await page.locator("#ai-provider summary").click();
    await expect(page.locator("#ai-url")).toHaveValue(`${mock.url}/v1/chat/completions`);
    await expect(page.locator("#ai-key"), "key never prefilled").toHaveValue("");
    await page.close();
    // The message itself, through the UI, on a fresh options page with the same provider.
    const again = await openOptions(ext);
    await again.locator("#ai-provider summary").click();
    await again.locator("#ai-url").fill(`${mock.url}/v1`);
    await again.locator("#ai-save").click();
    await expect(again.locator("#ai-result")).toContainText(`Saved as ${mock.url}/v1/chat/completions`);
    await expect(again.locator("#ai-url")).toHaveValue(`${mock.url}/v1/chat/completions`);
    await again.close();
  } finally { await mock.close(); }
});

for (const size of [{ width: 375, height: 667 }, { width: 1280, height: 800 }]) {
  test(`sticky Save bar never covers a focused input at ${size.width}x${size.height}`, async ({ ext }) => {
    const page = await openOptions(ext, size);
    await page.locator("#ai-provider summary").click();
    for (const id of ["helius-key", "ai-url", "ai-key", "ai-model"]) {
      const input = page.locator(`#${id}`);
      await input.scrollIntoViewIfNeeded();
      await input.focus(); // the browser's own focus scroll is what a keyboard user gets
      const covered = await input.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === el ? null : `${hit?.tagName}.${(hit as HTMLElement | null)?.className} covers #${el.id} (rect top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, viewport ${window.innerHeight})`;
      });
      expect(covered, `designer: sticky Save bar / overlay covers #${id} at ${size.width}x${size.height}`).toBeNull();
    }
    await page.close();
  });
}
