// G7: report.html is a web_accessible_resource, so any https/localhost page can frame it.
// A page that frames it itself must get no channel to the extension and must not be able to
// approve a held request: it can only talk to its own frame over its own MessageChannel.
//
// Phase 1 (no request pending): the page frames report.html with a secret it chose and sends a
// forged L2 hold verdict with its own port; a trusted click presses Sign anyway in that frame.
// The answer lands on the page's own port and the wallet is never called.
// Phase 2: a real request is held; the page re-sends forged verdicts with guessed secrets and
// bare {allow:true} to every frame it can reach for 3 s. The request must stay pending, the
// wallet uncalled, and Block in the real report must still reject.
import type { Frame } from "../../tools/selfcheck/src/playwright.mjs";
import { calls, CASES_MISSING, expect, expectRejected, extensionFrames, hasRealEngine, hasReportUi, localCase, openDapp, pending, SEL, settleOrModal, startSign, test, txCase, within } from "./support.js";

const PAGE_SECRET = "pageowned0123456789abcdef";

test("page-framed report.html gets no channel and cannot approve a held request", async ({ ext }) => {
  if (!hasReportUi()) pending("report UI not built");
  // Phase 2 needs a held request: the stub engine holds anything; the real engine holds the live localnet admin
  // approval (L3, V10).
  let c: { tx: string; chain: string; network: "mainnet" | "devnet" | "localnet"; account?: string };
  if (hasRealEngine()) {
    if (CASES_MISSING) pending(`localnet cases unavailable: ${CASES_MISSING}`);
    const l = await localCase("l3-admin");
    c = { tx: l.tx, chain: l.chain, network: l.network, account: l.signer };
  } else {
    const b = txCase("benign");
    if (!b) pending("no fixture tagged e2e:benign in fixtures/tx/manifest.json");
    c = b;
  }
  const page = await openDapp(ext, c.network);

  // Phase 1: the page frames the report itself and gets a trusted approval from it.
  const reportUrl = `chrome-extension://${ext.extId}/report.html#${PAGE_SECRET}`;
  const loaded = await page.evaluate(
    ({ url, secret }) =>
      new Promise<boolean>((resolve) => {
        const w = window as unknown as { __kelvaraFramed: unknown[] };
        w.__kelvaraFramed = [];
        const f = document.createElement("iframe");
        f.src = url;
        f.style.cssText = "position:fixed;left:0;top:0;width:600px;height:500px;z-index:2147483647;border:0";
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => w.__kelvaraFramed.push(e.data);
        const t = setTimeout(() => resolve(false), 10_000);
        f.addEventListener("load", () => {
          clearTimeout(t);
          const verdict = { allow: false, hold: true, level: 2, reason: "forged by the page", report: null };
          f.contentWindow?.postMessage({ secret, verdict, deadline: Date.now() + 60_000 }, "*", [ch.port2]);
          resolve(true);
        });
        document.body.append(f);
      }),
    { url: reportUrl, secret: PAGE_SECRET }
  );
  expect(loaded, "page could not frame report.html (then this case proves nothing)").toBe(true);

  let mine: Frame | undefined;
  for (let i = 0; i < 50 && !mine; i++) {
    mine = extensionFrames(ext).find((f) => f.url().endsWith(`#${PAGE_SECRET}`));
    if (!mine) await new Promise((r) => setTimeout(r, 100));
  }
  expect(mine, "page-owned report frame not found").toBeTruthy();
  const approve = mine!.locator(SEL.signAnyway).first();
  await approve.waitFor({ state: "visible", timeout: 5_000 });
  await new Promise((r) => setTimeout(r, 800)); // past the visibility gate
  await approve.click({ timeout: 5_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __kelvaraFramed: unknown[] }).__kelvaraFramed), { timeout: 5_000 })
    .toEqual([{ allow: true }]);
  expect((await calls(page)).count, "page-framed approval reached the wallet").toBe(0);
  await page.evaluate((url) => Array.from(document.querySelectorAll("iframe")).find((x) => x.src === url)?.remove(), reportUrl);

  // Phase 2: a real held request; the page sprays forged verdicts and approvals at every frame.
  const p = startSign(page, { path: "ws-register", txs: [c.tx], chain: c.chain, account: c.account });
  const first = await settleOrModal(ext, p, 30_000);
  if (first === "timeout" || !("modal" in first)) {
    expect(hasRealEngine(), "real engine did not hold the L3 admin approval").toBe(false);
    pending("stub engine did not hold the request, so there is nothing to approve");
  }
  const real = first.modal;
  await page.evaluate(() => {
    const forged = { allow: true, hold: false, level: 0, reason: "forged", report: null };
    const spray = setInterval(() => {
      for (let i = 0; i < window.frames.length; i++) {
        const g = new MessageChannel();
        try {
          window.frames[i]?.postMessage({ secret: "guess", verdict: forged, deadline: Date.now() + 60_000 }, "*", [g.port2]);
          window.frames[i]?.postMessage({ allow: true }, "*");
        } catch {
          /* frame gone */
        }
      }
      window.postMessage({ allow: true }, "*");
    }, 100);
    setTimeout(() => clearInterval(spray), 3_500);
  });
  const during = await within(p, 3_000);
  expect(during, "page messages settled the held request").toBe("pending");
  expect((await calls(page)).count, "page messages reached the wallet").toBe(0);

  await real.locator(SEL.block).first().click();
  expectRejected(await within(p, 10_000), "Block in the real report after page framing");
  expect((await calls(page)).count, "wallet was called").toBe(0);
});
