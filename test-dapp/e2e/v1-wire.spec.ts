// G7 v1 (message-first) wire transactions (X11): a v1 request through the test wallet reaches the engine and gets
// the engine's level, instead of being blocked before analysis ("could not read the transaction message").
//
// Case: the only v1 fixture, a real Kamino Lending mainnet transaction (first byte 0x81, message first, signatures
// after). `kelvara analyze --network mainnet --inventory` on these bytes gives alertLevel L0 online and offline
// (V11, 2026-11-07). X12 holds it in a full L0 modal: Continue forwards identical bytes once, Block rejects
// without a wallet call. Capture logs must retain engine level 0 rather than a pre-analysis bypass.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  armContinue, calls, expect, expectRejected, hasRealEngine, heliusKey, openDapp, pending, reportLevel, ROOT, SEL, startSign, test, waitForModal, WALLET_NAMES, within
} from "./support.js";

interface V1Case { file: string; tx: string }

function v1Case(): V1Case | null {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "fixtures/tx/manifest.json"), "utf8")) as { fixtures?: { path?: string; slug?: string }[] };
  for (const e of manifest.fixtures ?? []) {
    if (e.slug !== "kamino-lending" || typeof e.path !== "string") continue;
    const file = path.join(ROOT, "fixtures", e.path);
    if (!existsSync(file)) continue;
    const d = JSON.parse(readFileSync(file, "utf8")) as { transaction?: unknown; encoding?: unknown; network?: unknown };
    if (typeof d.transaction !== "string" || d.encoding !== "base64" || d.network !== "mainnet") continue;
    if (Buffer.from(d.transaction, "base64")[0] === 0x81) return { file: e.path, tx: d.transaction };
  }
  return null;
}

for (const walletPath of ["ws-app-ready", "legacy"] as const) {
  for (const decision of ["continue", "block"] as const) test(`${walletPath}: v1 message-first Kamino request is held at L0; ${decision} decides wallet forwarding`, async ({ ext }) => {
    const c = v1Case();
    expect(c, "no v1 (0x81) kamino-lending mainnet fixture in fixtures/tx").not.toBeNull();
    if (!hasRealEngine()) pending("real engine not wired into the extension");
    if (!heliusKey()) pending("HELIUS_API_KEY missing from the main checkout .env");
    const page = await openDapp(ext, "mainnet");
    const before = (await ext.captureLog()).length;
    const p = startSign(page, { path: walletPath, txs: [c!.tx], chain: "solana:mainnet", legacyArg: "bytes" });
    const modal = await waitForModal(ext, 45_000);
    expect(modal, "v1 request did not show its L0 modal").not.toBeNull();
    const m = modal!;
    expect(await reportLevel(m)).toBe("L0");
    await expect(m.locator("[data-kelvara-limited]")).toHaveCount(0);
    expect(await m.locator("[data-kelvara-hash]").count()).toBeGreaterThan(0);
    await expect(m.locator(SEL.continue)).toHaveText("Continue to wallet");
    await expect(m.locator(SEL.signAnyway)).toHaveCount(0);
    expect(await m.locator(SEL.block).first().evaluate(el => el === el.ownerDocument.activeElement)).toBe(true);
    expect(await within(p, 1_000), "v1 request settled without a decision").toBe("pending");
    expect((await calls(page)).count).toBe(0);
    if (decision === "block") {
      await m.locator(SEL.block).first().click();
      expectRejected(await within(p, 10_000), "v1 Block");
      expect((await calls(page)).count).toBe(0);
    } else {
      await armContinue(m);
      await m.locator(SEL.continue).evaluate(el => (el as HTMLButtonElement).click());
      expect(await within(p, 500), "untrusted v1 Continue forwarded request").toBe("pending");
      expect((await calls(page)).count).toBe(0);
      await m.locator(SEL.continue).first().click();
      expect(await within(p, 15_000), "Continue did not forward v1 request").toMatchObject({ ok: true });
      const log = await calls(page);
      expect(log.count, "the wallet must be called exactly once").toBe(1);
      expect(log.calls[0]!.received, "the wallet must get the identical v1 bytes").toEqual([c!.tx]);
    }

    const entries = await ext.captureLog();
    const mine = entries.slice(0, entries.length - before).filter((e) => e.wallet === WALLET_NAMES[walletPath]);
    expect(mine.length, "service worker never logged the v1 request").toBeGreaterThanOrEqual(1);
    const entry = mine[0]! as typeof mine[0] & { reason?: string };
    expect(entry.allow).toBe(decision === "continue");
    expect(entry.level, "v1 request did not get the engine's level (L0 = 0)").toBe(0);
    expect(entry.reason ?? "", "v1 request logged a pre-analysis reason").not.toMatch(/could not read|pass-through|engine error/);
  });
}
