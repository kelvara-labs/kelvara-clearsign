// V16 report context (X18) and engine E22. Real-engine localnet reports name the page origin (no path or query) and the
// network; a routine transfer that includes ComputeBudget instructions is not sent to the AI mock.
import { readFileSync } from "node:fs";
import path from "node:path";
import { AI_DIR, SYNTHETIC_KEY, feePayer, saveProvider, startMock } from "./ai-support.js";
import {
  CASES_MISSING, DAPP_URL, ROOT, calls, expect, expectRejected, hasRealEngine, hasReportUi, heliusKey, localCase, openDapp, pending, SEL, startSign,
  test, waitForModal, within
} from "./support.js";

test.use({ extDir: AI_DIR });

for (const role of ["l3-admin", "l2-trap"] as const) {
  test(`${role}: report shows data-kelvara-origin = the page origin and data-kelvara-network = localnet`, async ({ ext }) => {
    if (!hasRealEngine()) pending("real engine not wired into the extension");
    if (CASES_MISSING) pending(`localnet cases unavailable: ${CASES_MISSING}`);
    if (!hasReportUi()) pending("report UI not landed");
    const c = await localCase(role);
    const page = await openDapp(ext, "localnet");
    const p = startSign(page, { path: "ws-app-ready", txs: [c.tx], chain: c.chain, account: c.signer });
    const m = await waitForModal(ext, 45_000);
    expect(m, `${role}: no report modal`).not.toBeNull();
    const origin = new URL(DAPP_URL).origin;
    await expect(m!.locator("[data-kelvara-origin]")).toHaveText(origin);
    await expect(m!.locator("[data-kelvara-network]")).toHaveText("localnet");
    const text = (await m!.locator("[data-kelvara-origin]").innerText()).trim();
    expect(text, "origin must carry no path, query or fragment").toBe(origin);
    await m!.locator(SEL.block).first().click();
    expectRejected(await within(p, 10_000), `${role} Block`);
    expect((await calls(page)).count).toBe(0);
  });
}

test("E22: a routine transfer with ComputeBudget instructions does not call the AI provider", async ({ ext }) => {
  if (!hasRealEngine()) pending("real engine not wired into the extension");
  if (!hasReportUi()) pending("report UI not landed");
  if (!heliusKey()) pending("HELIUS_API_KEY missing");
  // Real mainnet fixture: ComputeBudget (limit + price) followed by one System transfer.
  const rel = "tx/mainnet/system/51AfDTHpz6Z3PoZAxLeLNXn52qghSTByFXcHbXFypAwZt7oxQ4JL6itzLP3ZypqWTkZrZgFCkR9oxPpMidYvncT7.json";
  const tx = (JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as { transaction: string }).transaction;
  const mock = await startMock("select-highest");
  try {
    await saveProvider(ext, `${mock.url}/v1/chat/completions`, SYNTHETIC_KEY);
    const page = await openDapp(ext, "mainnet");
    const p = startSign(page, { path: "ws-app-ready", txs: [tx], chain: "solana:mainnet", account: feePayer(tx) });
    const m = await waitForModal(ext, 45_000);
    expect(m, "no report modal").not.toBeNull();
    expect(await within(p, 1_500)).toBe("pending");
    const card = m!.locator("[data-kelvara-intent]").first();
    await card.waitFor({ timeout: 10_000 }).catch(() => {});
    if (await card.count()) {
      await expect(card.locator("[data-intent-source]")).toHaveAttribute("data-intent-source", "engine");
      await expect(card).toHaveAttribute("data-intent-status", "template");
    }
    await m!.locator(SEL.block).first().click();
    expectRejected(await within(p, 10_000), "E22 Block");
    expect(mock.last(), "provider was contacted for a routine transfer with ComputeBudget").toBeNull();
  } finally { await mock.close(); }
});
