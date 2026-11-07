// G7 per-level behavior (PLAN M5 Report UI):
//   L4 sweep: rejected at once with 4001, no Sign anyway, wallet call count 0.
//   L3 batch: held, Block is the default; Block -> 4001 and count 0;
//             Sign anyway needs hold-to-confirm and then calls the wallet once with identical bytes.
//   L2 trap:  held with both buttons; Block -> 4001 and count 0.
//   Benign:   no modal; the wallet is called once with identical bytes.
// Levels come from the real engine on real fixtures tagged in fixtures/tx/manifest.json ("e2e": role).
import {
  calls, expect, expectRejected, hasRealEngine, hasReportUi, heliusKey, holdSignAnyway, openDapp, pending, reportLevel,
  SEL, settleOrModal, startSign, test, txCase, waitForModal, within, type E2eRole, type Ext
} from "./support.js";

function need(role: E2eRole) {
  if (!hasRealEngine()) pending("real engine not wired into the extension (stub engine says L2 for everything)");
  const c = txCase(role);
  if (!c) pending(`no fixture tagged "e2e": "${role}" in fixtures/tx/manifest.json`);
  if (c.network !== "localnet" && !heliusKey()) pending("HELIUS_API_KEY missing from the main checkout .env");
  return c;
}

async function modalOrFail(ext: Ext, what: string) {
  const m = await waitForModal(ext, 45_000);
  expect(m, `${what}: no report modal within 45 s`).not.toBeNull();
  return m!;
}

test("L4 sweep is rejected at once with no Sign anyway; wallet never called", async ({ ext }) => {
  const c = need("l4-sweep");
  const page = await openDapp(ext, c.network);
  const p = startSign(page, { path: "ws-app-ready", txs: [c.tx], chain: c.chain });
  // No user action: L4 rejects by itself.
  expectRejected(await within(p, 45_000), "L4 sweep");
  expect((await calls(page)).count).toBe(0);
  if (!hasReportUi()) pending("report UI not landed: cannot check the L4 report and the absent Sign anyway");
  const m = await modalOrFail(ext, "L4 report");
  expect(await reportLevel(m)).toBe("L4");
  await expect(m.locator(SEL.signAnyway), "L4 must not offer Sign anyway").toHaveCount(0);
  expect((await calls(page)).count).toBe(0);
});

test("L3 batch is held with Block as default; Block leaves the wallet uncalled", async ({ ext }) => {
  const c = need("l3-batch");
  const benign = txCase("benign")!;
  const page = await openDapp(ext, c.network);
  const txs = [c.tx, benign.tx];
  const p = startSign(page, { path: "legacy", method: "signAllTransactions", txs, chain: c.chain });
  if (!hasReportUi()) {
    expectRejected(await within(p, 45_000), "L3 without report UI must block");
    expect((await calls(page)).count).toBe(0);
    pending("report UI not landed: L3 hold, default Block");
  }
  const m = await modalOrFail(ext, "L3 report");
  expect(await reportLevel(m)).toBe("L3");
  expect(await within(p, 2_000), "L3 settled without a decision").toBe("pending");
  expect((await calls(page)).count, "wallet called while held").toBe(0);
  const blockIsDefault = await m.locator(SEL.block).first().evaluate((el) => el === el.ownerDocument.activeElement);
  expect(blockIsDefault, "Block must be the focused default button at L3").toBe(true);
  await m.locator(SEL.block).first().click();
  expectRejected(await within(p, 10_000), "Block");
  expect((await calls(page)).count).toBe(0);
});

for (const path of ["ws-register", "legacy"] as const) {
  test(`${path}: L3 Sign anyway needs a hold, then calls the wallet once with identical bytes`, async ({ ext }) => {
    const c = need("l3-batch");
    if (!hasReportUi()) pending("report UI not landed: Sign anyway");
    const page = await openDapp(ext, c.network);
    const p = startSign(page, { path, txs: [c.tx], chain: c.chain, legacyArg: "bytes" });
    const m = await modalOrFail(ext, "L3 report");
    // A plain click is not a deliberate second step.
    await m.locator(SEL.signAnyway).first().click();
    expect(await within(p, 1_500), "a plain click on Sign anyway signed an L3 request").toBe("pending");
    expect((await calls(page)).count).toBe(0);
    await holdSignAnyway(ext, m);
    const r = await within(p, 15_000);
    expect(r, "Sign anyway did not forward").not.toBe("pending");
    expect(r).toMatchObject({ ok: true });
    const log = await calls(page);
    expect(log.count, "Sign anyway must call the wallet exactly once").toBe(1);
    expect(log.calls[0]!.received, "Sign anyway must forward the identical bytes").toEqual([c.tx]);
  });
}

test("L2 trap purchase is held with both buttons; Block leaves the wallet uncalled", async ({ ext }) => {
  const c = need("l2-trap");
  if (!hasReportUi()) pending("report UI not landed: L2 hold");
  const page = await openDapp(ext, c.network);
  const p = startSign(page, { path: "ws-register", txs: [c.tx], chain: c.chain });
  const m = await modalOrFail(ext, "L2 report");
  expect(await reportLevel(m)).toBe("L2");
  await expect(m.locator(SEL.block)).toHaveCount(1);
  await expect(m.locator(SEL.signAnyway)).toHaveCount(1);
  expect(await within(p, 1_000)).toBe("pending");
  await m.locator(SEL.block).first().click();
  expectRejected(await within(p, 10_000), "Block");
  expect((await calls(page)).count).toBe(0);
});

for (const path of ["ws-app-ready", "legacy"] as const) {
  test(`${path}: benign transfer shows no modal and reaches the wallet once with identical bytes`, async ({ ext }) => {
    const c = need("benign");
    const page = await openDapp(ext, c.network);
    const p = startSign(page, { path, txs: [c.tx], chain: c.chain });
    const first = await settleOrModal(ext, p, 45_000);
    expect(first, "benign request still pending after 45 s").not.toBe("timeout");
    expect(first !== "timeout" && "modal" in first, "benign request showed a modal").toBe(false);
    expect(await waitForModal(ext, 1_000), "benign request showed a modal").toBeNull();
    expect((first as { result: unknown }).result, "benign request was blocked").toMatchObject({ ok: true });
    const log = await calls(page);
    expect(log.count).toBe(1);
    expect(log.calls[0]!.received).toEqual([c.tx]);
  });
}
