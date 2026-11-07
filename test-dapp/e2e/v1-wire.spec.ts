// G7 v1 (message-first) wire transactions (X11): a v1 request through the test wallet reaches the engine and gets
// the engine's level, instead of being blocked before analysis ("could not read the transaction message").
//
// Case: the only v1 fixture, a real Kamino Lending mainnet transaction (first byte 0x81, message first, signatures
// after). `kelvara analyze --network mainnet --inventory` on these bytes gives alertLevel L0 online and offline
// (V11, 2026-11-07), so the extension must pass it through with no modal, call the wallet once with the identical
// bytes, and log level 0 with the engine's report title as the reason. A request that skipped the engine would log
// level null; one blocked before analysis would reject with 4001.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  calls, expect, hasRealEngine, heliusKey, openDapp, pending, ROOT, settleOrModal, startSign, test, waitForModal, WALLET_NAMES
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
  test(`${walletPath}: v1 message-first Kamino request reaches the engine (L0) and the wallet once with identical bytes`, async ({ ext }) => {
    const c = v1Case();
    expect(c, "no v1 (0x81) kamino-lending mainnet fixture in fixtures/tx").not.toBeNull();
    if (!hasRealEngine()) pending("real engine not wired into the extension");
    if (!heliusKey()) pending("HELIUS_API_KEY missing from the main checkout .env");
    const page = await openDapp(ext, "mainnet");
    const before = (await ext.captureLog()).length;
    const p = startSign(page, { path: walletPath, txs: [c!.tx], chain: "solana:mainnet", legacyArg: "bytes" });
    const first = await settleOrModal(ext, p, 45_000);
    expect(first, "v1 request still pending after 45 s").not.toBe("timeout");
    expect(first !== "timeout" && "modal" in first, "v1 L0 request showed a modal").toBe(false);
    expect(await waitForModal(ext, 1_000), "v1 L0 request showed a modal").toBeNull();
    expect((first as { result: unknown }).result, "v1 request was blocked").toMatchObject({ ok: true });
    const log = await calls(page);
    expect(log.count, "the wallet must be called exactly once").toBe(1);
    expect(log.calls[0]!.received, "the wallet must get the identical v1 bytes").toEqual([c!.tx]);

    const entries = await ext.captureLog();
    const mine = entries.slice(0, entries.length - before).filter((e) => e.wallet === WALLET_NAMES[walletPath]);
    expect(mine.length, "service worker never logged the v1 request").toBeGreaterThanOrEqual(1);
    const entry = mine[0]! as typeof mine[0] & { reason?: string };
    expect(entry.allow).toBe(true);
    expect(entry.level, "v1 request did not get the engine's level (L0 = 0)").toBe(0);
    expect(entry.reason ?? "", "v1 request logged a pre-analysis reason").not.toMatch(/could not read|pass-through|engine error/);
  });
}
