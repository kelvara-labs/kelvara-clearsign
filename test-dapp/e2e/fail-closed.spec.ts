// G7 fail closed: a held request that nobody answers within 90 s is blocked, and a page that
// removes the report UI gets its request blocked. The wallet is never called in either case.
import { calls, CASES_MISSING, localCase, expect, expectRejected, extensionFrames, hasRealEngine, hasReportUi, HOLD_TIMEOUT_MS, openDapp, pending, startSign, test, txCase, waitForModal, within } from "./support.js";

/** Any request the extension holds for a decision: stub engine holds everything (L2); the real engine holds the live
 * localnet admin approval (L3; executed fixtures no longer reproduce their pre-execution level, V10). */
async function heldCase(): Promise<{ tx: string; chain: string; network: "mainnet" | "devnet" | "localnet"; account?: string }> {
  if (!hasReportUi()) pending("report UI not landed: nothing is held yet (L2/L3 block at once)");
  if (!hasRealEngine()) {
    const b = txCase("benign");
    if (!b) pending("no benign fixture in fixtures/tx/manifest.json");
    return b;
  }
  if (CASES_MISSING) pending(`localnet cases unavailable: ${CASES_MISSING}`);
  const c = await localCase("l3-admin");
  return { tx: c.tx, chain: c.chain, network: c.network, account: c.signer };
}

test("held request with no answer is blocked after the 90 s timeout", async ({ ext }) => {
  test.setTimeout(HOLD_TIMEOUT_MS + 90_000);
  const c = await heldCase();
  const page = await openDapp(ext, c.network);
  const t0 = Date.now();
  const p = startSign(page, { path: "ws-register", txs: [c.tx], chain: c.chain, account: c.account });
  expect(await waitForModal(ext, 45_000), "request not held with a report").not.toBeNull();
  // Not before the timeout...
  expect(await within(p, Math.max(0, HOLD_TIMEOUT_MS - 5_000 - (Date.now() - t0))), "blocked before 85 s").toBe("pending");
  expect((await calls(page)).count).toBe(0);
  // ...but by it.
  expectRejected(await within(p, 25_000), "timeout");
  expect(Date.now() - t0, "timeout fired too late").toBeLessThan(HOLD_TIMEOUT_MS + 25_000);
  expect((await calls(page)).count).toBe(0);
});

test("page removing the report UI gets the request blocked", async ({ ext }) => {
  const c = await heldCase();
  const page = await openDapp(ext, c.network);
  // Remember every element that exists before the request; the report UI's host is added after.
  await page.evaluate(() => {
    (window as unknown as { __before: Set<Element> }).__before = new Set(Array.from(document.querySelectorAll("*")));
  });
  const p = startSign(page, { path: "legacy", txs: [c.tx], chain: c.chain, account: c.account });
  expect(await waitForModal(ext, 45_000), "request not held with a report").not.toBeNull();
  expect(extensionFrames(ext).length).toBeGreaterThan(0);
  // The page cannot reach into the closed shadow root, but it can remove its host.
  const removed = await page.evaluate(() => {
    const before = (window as unknown as { __before: Set<Element> }).__before;
    let n = 0;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (!before.has(el) && el.isConnected) {
        el.remove();
        n++;
      }
    }
    return n;
  });
  expect(removed, "found no element added by the extension to remove").toBeGreaterThan(0);
  expectRejected(await within(p, 5_000), "iframe removal");
  expect((await calls(page)).count).toBe(0);
});
