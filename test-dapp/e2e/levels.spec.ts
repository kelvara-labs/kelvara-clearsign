// G7 per-level behavior (PLAN M5 Report UI):
//   L4 sweep: rejected at once with 4001, no Sign anyway, wallet call count 0. Both shapes: the plain sweep and the
//             realistic ATA create + close sweep (l4-sweep-ata, default since V11: E16 proves it L4).
//   L3 admin: held, Block is the default; Block -> 4001 and count 0;
//             Sign anyway needs hold-to-confirm and then calls the wallet once with identical bytes.
//   L2 trap:  held with both buttons; Block -> 4001 and count 0.
//   Benign L0/L1: full modal; held until Continue or Block, wallet never called before Continue.
// Levels L2-L4 run on LIVE LOCALNET scenarios in their pre-execution state (coordinator, V10): admin-local,
// trap-local, sweep-local from scenarios S12 (+ S12b l4-sweep-ata via --with-ata-sweep), served by e2e.mjs; the extension's network is localnet and the test
// wallet presents the scenario's signer (SignArgs.account). Benign keeps a real mainnet fixture: its level does not
// depend on chain state.
import {
  armContinue, armSignAnyway, calls, CASES_MISSING, expect, expectRejected, hasRealEngine, hasReportUi, heliusKey, holdSignAnyway, localCase, openDapp,
  pending, reportLevel, SEL, startSign, test, txCase, waitForModal, within, type Ext, type LocalRole
} from "./support.js";

async function needLocal(role: LocalRole) {
  if (!hasRealEngine()) pending("real engine not wired into the extension (stub engine says L2 for everything)");
  if (CASES_MISSING) pending(`localnet cases unavailable: ${CASES_MISSING}`);
  return localCase(role);
}
function needBenign() {
  if (!hasRealEngine()) pending("real engine not wired into the extension (stub engine says L2 for everything)");
  const c = txCase("benign");
  if (!c) pending('no benign fixture in fixtures/tx/manifest.json');
  if (c.network !== "localnet" && !heliusKey()) pending("HELIUS_API_KEY missing from the main checkout .env");
  return c;
}

async function modalOrFail(ext: Ext, what: string) {
  const m = await waitForModal(ext, 45_000);
  expect(m, `${what}: no report modal within 45 s`).not.toBeNull();
  return m!;
}

for (const role of ["l4-sweep", "l4-sweep-ata"] as const) test(`L4 ${role === "l4-sweep" ? "sweep" : "realistic ATA create + close sweep"} (localnet) is rejected at once with no Sign anyway; wallet never called`, async ({ ext }) => {
  const c = await needLocal(role);
  expect(c.expectLevel).toBe("L4");
  const page = await openDapp(ext, "localnet");
  const p = startSign(page, { path: "ws-app-ready", txs: [c.tx], chain: c.chain, account: c.signer });
  // No user action: L4 rejects by itself.
  expectRejected(await within(p, 45_000), "L4 sweep");
  expect((await calls(page)).count).toBe(0);
  if (!hasReportUi()) pending("report UI not landed: cannot check the L4 report and the absent Sign anyway");
  const m = await modalOrFail(ext, "L4 report");
  expect(await reportLevel(m)).toBe("L4");
  await expect(m.locator(SEL.signAnyway), "L4 must not offer Sign anyway").toHaveCount(0);
  expect((await calls(page)).count).toBe(0);
});

test("L3 admin approval (localnet) is held with Block as default; Block leaves the wallet uncalled", async ({ ext }) => {
  const c = await needLocal("l3-admin");
  expect(c.expectLevel).toBe("L3");
  const page = await openDapp(ext, "localnet");
  const p = startSign(page, { path: "legacy", method: "signAllTransactions", txs: [c.tx], chain: c.chain, account: c.signer });
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
  test(`${path}: L3 admin (localnet) Sign anyway needs a hold, then calls the wallet once with identical bytes`, async ({ ext }) => {
    const c = await needLocal("l3-admin");
    if (!hasReportUi()) pending("report UI not landed: Sign anyway");
    const page = await openDapp(ext, "localnet");
    const p = startSign(page, { path, txs: [c.tx], chain: c.chain, legacyArg: "bytes", account: c.signer });
    const m = await modalOrFail(ext, "L3 report");
    expect(await reportLevel(m)).toBe("L3");
    // A plain click on the armed button is not a deliberate second step.
    await armSignAnyway(m);
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

test("L2 trap purchase (localnet) is held with both buttons; Block leaves the wallet uncalled", async ({ ext }) => {
  const c = await needLocal("l2-trap");
  expect(c.expectLevel).toBe("L2");
  if (!hasReportUi()) pending("report UI not landed: L2 hold");
  const page = await openDapp(ext, "localnet");
  const p = startSign(page, { path: "ws-register", txs: [c.tx], chain: c.chain, account: c.signer });
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
  for (const decision of ["continue", "block"] as const) {
    test(`${path}: benign transfer is held with a full L0/L1 modal; ${decision} decides wallet forwarding`, async ({ ext }) => {
      const c = needBenign();
      const page = await openDapp(ext, c.network);
      const p = startSign(page, { path, txs: [c.tx], chain: c.chain });
      const m = await modalOrFail(ext, "benign report");
      expect(await reportLevel(m), "harmless level must not be raised to force a hold").toMatch(/^L[01]$/);
      await expect(m.locator("[data-kelvara-limited]")).toHaveCount(0);
      expect(await m.locator("[data-kelvara-hash]").count(), "full report must include message hashes").toBeGreaterThan(0);
      await expect(m.locator(SEL.continue)).toHaveText("Continue to wallet");
      await expect(m.locator(SEL.signAnyway)).toHaveCount(0);
      expect(await m.locator(SEL.block).first().evaluate(el => el === el.ownerDocument.activeElement), "Block must have default focus").toBe(true);
      expect(await within(p, 1_000), "benign request settled without a decision").toBe("pending");
      expect((await calls(page)).count).toBe(0);
      if (decision === "block") {
        await m.locator(SEL.block).first().click();
        expectRejected(await within(p, 10_000), "benign Block");
        expect((await calls(page)).count).toBe(0);
      } else {
        await armContinue(m);
        await m.locator(SEL.continue).evaluate(el => (el as HTMLButtonElement).click());
        expect(await within(p, 500), "untrusted Continue forwarded the request").toBe("pending");
        expect((await calls(page)).count).toBe(0);
        await m.locator(SEL.continue).first().click();
        expect(await within(p, 15_000), "Continue did not forward benign request").toMatchObject({ ok: true });
        const log = await calls(page);
        expect(log.count).toBe(1);
        expect(log.calls[0]!.received).toEqual([c.tx]);
      }
    });
  }
}
