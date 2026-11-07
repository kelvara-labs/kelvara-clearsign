// G7: a page that forges an approval message gets a rejection and the wallet is never called.
// The test dApp's forge mode (test-dapp/src/forge.ts) sniffs dispatchEvent/CustomEvent for the
// channel, replays the hook-ready handshake, offers a fake bridge, and sprays approval
// postMessages and decision events every 100 ms while the request is pending.
import { calls, expect, expectRejected, forgeReport, hasRealEngine, hasReportUi, openDapp, PATHS, pending, SEL, settleOrModal, startSign, test, txCase, within } from "./support.js";

/** A request that must be held or blocked, never passed: the stub engine holds everything (L2); the real engine needs the L3 fixture. */
function heldCase() {
  if (!hasRealEngine()) return txCase("benign");
  return txCase("l3-batch");
}

for (const path of PATHS) {
  test(`${path}: forged approval is rejected and the wallet is never called`, async ({ ext }) => {
    const c = heldCase();
    if (!c) pending("real engine wired but no fixture tagged e2e:l3-batch in fixtures/tx/manifest.json");
    const page = await openDapp(ext, c.network);

    const p = startSign(page, { path, txs: [c.tx], chain: c.chain, forge: true });
    const first = await settleOrModal(ext, p, 30_000);
    expect(first, "request neither settled nor showed a report within 30 s").not.toBe("timeout");

    if (first !== "timeout" && "modal" in first) {
      // Held: let the forger spray approvals for 3 s. Nothing may get through.
      const during = await within(p, 3_000);
      expect(during, "forged approval settled a held request").toBe("pending");
      expect((await calls(page)).count, "forged approval reached the wallet").toBe(0);
      await first.modal.locator(SEL.block).first().click();
      expectRejected(await within(p, 10_000), "Block after forging");
    } else {
      expectRejected((first as { result: Awaited<typeof p> }).result, "forged approval");
    }

    expect((await calls(page)).count, "wallet was called").toBe(0);
    const forge = await forgeReport(page);
    expect(forge, "forge mode did not run").not.toBeNull();
    expect(forge!.learnedChannels, "page learned the private channel").toEqual([]);
    expect(forge!.answeredRequests, "page answered a request on the channel").toEqual([]);

    if (!hasReportUi()) pending("forge ran only against an immediate block; rerun while the report UI holds the request");
  });
}
