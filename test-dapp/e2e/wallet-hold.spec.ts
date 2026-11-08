// V16 wallet-hold ordering (X16). The fixture wallet records every call with Date.now()/performance.now() in
// calls().timeline. For every held signing path: nothing reaches the wallet before the trusted Continue click, exactly
// one call after it with identical bytes; Block leaves the timeline empty and rejects with 4001. Vendor/unknown signing
// features are rejected with 4001 before the wallet is called. A wallet that registers late is still held.
import {
  armContinue, calls, expect, expectRejected, hasRealEngine, hasReportUi, heliusKey, openDapp, pending, SEL, startSign, test, txCase, waitForModal,
  within, type Ext, type SignArgs, type WalletPath
} from "./support.js";

function needBenign() {
  if (!hasRealEngine()) pending("real engine not wired into the extension");
  if (!hasReportUi()) pending("report UI not landed");
  const c = txCase("benign");
  if (!c) pending("no benign fixture in fixtures/tx/manifest.json");
  if (c.network !== "localnet" && !heliusKey()) pending("HELIUS_API_KEY missing from the main checkout .env");
  return c;
}

const HELD: { name: string; args: Omit<SignArgs, "txs" | "chain"> }[] = [
  { name: "ws-register signTransaction", args: { path: "ws-register", method: "signTransaction" } },
  { name: "ws-register signAndSendTransaction", args: { path: "ws-register", method: "signAndSendTransaction" } },
  { name: "ws-app-ready signTransaction", args: { path: "ws-app-ready", method: "signTransaction" } },
  { name: "ws-app-ready signAndSendTransaction", args: { path: "ws-app-ready", method: "signAndSendTransaction" } },
  { name: "legacy signTransaction", args: { path: "legacy", method: "signTransaction", legacyArg: "bytes" } },
  { name: "legacy signAllTransactions", args: { path: "legacy", method: "signAllTransactions", legacyArg: "object" } },
  { name: "legacy signAndSendTransaction", args: { path: "legacy", method: "signAndSendTransaction", legacyArg: "bytes" } }
];

async function heldModal(ext: Ext, what: string) {
  const m = await waitForModal(ext, 45_000);
  expect(m, `${what}: no report modal within 45 s`).not.toBeNull();
  return m!;
}
const timeline = (page: Ext["page"]) => calls(page).then((c) => c.timeline);

for (const h of HELD) {
  test(`${h.name}: wallet timeline is empty until the trusted Continue; then exactly one call with identical bytes`, async ({ ext }) => {
    const c = needBenign();
    const page = await openDapp(ext, c.network);
    const p = startSign(page, { ...h.args, txs: [c.tx], chain: c.chain });
    const m = await heldModal(ext, h.name);
    expect(await within(p, 1_500), `${h.name}: settled without a decision`).toBe("pending");
    expect(await timeline(page), `${h.name}: wallet reached while held`).toEqual([]);
    await armContinue(m);
    const clickedAt = Date.now();
    await m.locator(SEL.continue).first().click();
    expect(await within(p, 15_000), `${h.name}: Continue did not forward`).toMatchObject({ ok: true });
    const log = await calls(page);
    expect(log.timeline, `${h.name}: exactly one wallet call`).toHaveLength(1);
    expect(log.timeline[0]!.at, `${h.name}: wallet called before the Continue click`).toBeGreaterThanOrEqual(clickedAt);
    expect(log.count).toBe(1);
    expect(log.calls[0]!.received, `${h.name}: forwarded bytes differ`).toEqual([c.tx]);
  });
}

for (const h of HELD) {
  test(`${h.name}: Block rejects with 4001 and the wallet timeline stays empty`, async ({ ext }) => {
    const c = needBenign();
    const page = await openDapp(ext, c.network);
    const p = startSign(page, { ...h.args, txs: [c.tx], chain: c.chain });
    const m = await heldModal(ext, h.name);
    await m.locator(SEL.block).first().click();
    expectRejected(await within(p, 10_000), `${h.name} Block`);
    expect(await timeline(page)).toEqual([]);
    expect((await calls(page)).count).toBe(0);
  });
}

for (const path of ["ws-register", "ws-app-ready", "legacy"] as const satisfies readonly WalletPath[]) {
  test(`${path}: vendor/unknown signing feature is rejected with 4001 before the wallet is called`, async ({ ext }) => {
    const page = await openDapp(ext, "mainnet", null);
    const r = await page.evaluate((p) => window.kelvaraTestDapp.signVendor(p), path);
    expect(r.ok, `${path}: vendor signing was not refused`).toBe(false);
    if (path !== "legacy") expect(r).toMatchObject({ ok: false, error: { code: 4001 } });
    expect(await timeline(page), `${path}: wallet reached by vendor signing`).toEqual([]);
    expect(await waitForModal(ext, 1_000), "a review modal appeared for a vendor feature").toBeNull();
  });
}

// A wallet injected after the page loaded (window.solflare is a legacy path the hook traps), driven through its own
// request({ method }) and signTransaction. The probe records the time of every call it receives.
const PROBE = `
  (() => {
    const probe = { calls: [], isProbe: true };
    const rec = (method) => probe.calls.push({ method, at: Date.now() });
    probe.request = async (a) => { rec("request:" + a.method); return { ok: true }; };
    probe.signTransaction = async (tx) => { rec("signTransaction"); return tx; };
    window.__probe = probe;
    window.solflare = probe;
  })()
`;
const bytesOf = (b64: string) => Array.from(Buffer.from(b64, "base64"));

for (const via of ["request", "signTransaction"] as const) {
  test(`late-registering wallet (window.solflare, ${via}) is still held until Continue`, async ({ ext }) => {
    const c = needBenign();
    const page = await openDapp(ext, c.network);
    await page.evaluate(PROBE);
    const bytes = bytesOf(c.tx);
    const pendingCall = page.evaluate(async ({ via, bytes }) => {
      const w = (window as unknown as { solflare: { request(a: object): Promise<unknown>; signTransaction(t: unknown): Promise<unknown> } }).solflare;
      const tx = { serialize: () => Uint8Array.from(bytes) };
      try {
        return via === "request"
          ? await w.request({ method: "signTransaction", params: { transaction: tx } })
          : await w.signTransaction(tx);
      } catch (e) { return { rejected: (e as { code?: number }).code ?? "error" }; }
    }, { via, bytes });
    const m = await heldModal(ext, `late wallet ${via}`);
    expect(await within(pendingCall, 1_500)).toBe("pending");
    expect(await page.evaluate(() => (window as unknown as { __probe: { calls: unknown[] } }).__probe.calls), "late wallet reached while held").toEqual([]);
    await armContinue(m);
    const clickedAt = Date.now();
    await m.locator(SEL.continue).first().click();
    await within(pendingCall, 15_000);
    const probeCalls = await page.evaluate(() => (window as unknown as { __probe: { calls: { method: string; at: number }[] } }).__probe.calls);
    expect(probeCalls, "late wallet: exactly one call").toHaveLength(1);
    expect(probeCalls[0]!.at).toBeGreaterThanOrEqual(clickedAt);
  });
}

test("legacy request({ method: signTransaction }) Block rejects with 4001 and the wallet is never called", async ({ ext }) => {
  const c = needBenign();
  const page = await openDapp(ext, c.network);
  await page.evaluate(PROBE);
  const bytes = bytesOf(c.tx);
  const pendingCall = page.evaluate(async (bytes) => {
    const w = (window as unknown as { solflare: { request(a: object): Promise<unknown> } }).solflare;
    try { return await w.request({ method: "signAndSendTransaction", params: { transaction: { serialize: () => Uint8Array.from(bytes) } } }); }
    catch (e) { return { rejected: (e as { code?: number }).code ?? "error" }; }
  }, bytes);
  const m = await heldModal(ext, "request Block");
  await m.locator(SEL.block).first().click();
  expect(await within(pendingCall, 10_000)).toMatchObject({ rejected: 4001 });
  expect(await page.evaluate(() => (window as unknown as { __probe: { calls: unknown[] } }).__probe.calls)).toEqual([]);
});
