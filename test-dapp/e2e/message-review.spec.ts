// V16 message review (X17): signMessage / signIn are held and reviewed like a transaction. Offline: no Helius key, no
// chain reads. The wallet timeline must be empty until the trusted Continue and an L4 or blocked message leaves it empty.
import { armContinue, armSignAnyway, calls, expect, expectRejected, hasReportUi, openDapp, pending, reportLevel, SEL, test, txCase, waitForModal, within, type Ext, type WalletPath } from "./support.js";
import type { Frame } from "../../tools/selfcheck/src/playwright.mjs";

type Kind = "siws" | "siws-domain-mismatch" | "siws-expired" | "text" | "binary" | "tx";

async function begin(ext: Ext) {
  if (!hasReportUi()) pending("report UI not landed");
  const page = await openDapp(ext, "mainnet", null);
  return { page, path: "ws-app-ready" as WalletPath };
}
async function review(ext: Ext, what: string): Promise<Frame> {
  const m = await waitForModal(ext, 30_000);
  expect(m, `${what}: no report modal within 30 s`).not.toBeNull();
  await expect(m!.locator("[data-kelvara-message-review]"), `${what}: no message review view`).toHaveCount(1);
  return m!;
}
const attr = (m: Frame, name: string) => m.locator("[data-kelvara-message-review]").first().getAttribute(name);

function sample(ext: Ext, kind: Kind, path: WalletPath = "ws-app-ready") {
  const tx = kind === "tx" ? txCase("benign")?.tx : undefined;
  if (kind === "tx" && !tx) pending("no benign fixture for the tx-as-message case");
  return ext.page.evaluate(([p, k, t]) => window.kelvaraTestDapp.signSample(p as WalletPath, k as Kind, t ?? undefined), [path, kind, tx ?? null] as const);
}
const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

test("siws ok: L1 'Sign-in request'; Continue forwards the identical message once, after the click", async ({ ext }) => {
  const { page, path } = await begin(ext);
  const p = sample(ext, "siws", path);
  const m = await review(ext, "siws");
  expect(await reportLevel(m)).toBe("L1");
  expect(await attr(m, "data-message-kind")).toBeTruthy();
  expect(await m.locator("body").innerText()).toContain("Sign-in request");
  expect(await within(p, 1_500)).toBe("pending");
  expect((await calls(page)).timeline, "wallet reached while the sign-in was held").toEqual([]);
  await armContinue(m);
  const clickedAt = Date.now();
  await m.locator(SEL.continue).first().click();
  expect(await within(p, 15_000)).toMatchObject({ ok: true });
  const log = await calls(page);
  expect(log.timeline).toHaveLength(1);
  expect(log.timeline[0]!.at).toBeGreaterThanOrEqual(clickedAt);
  expect(log.messages).toHaveLength(1);
  const text = decode(log.messages[0]!.message);
  expect(text).toContain("wants you to sign in with your Solana account:");
  expect(text.split("\n")[0]).toBe(`${new URL(page.url()).host} wants you to sign in with your Solana account:`);
});

test("siws-domain-mismatch: L3 with rule siws.domain-mismatch; Block leaves zero wallet calls", async ({ ext }) => {
  const { page, path } = await begin(ext);
  const p = sample(ext, "siws-domain-mismatch", path);
  const m = await review(ext, "siws-domain-mismatch");
  expect(await reportLevel(m)).toBe("L3");
  await expect(m.locator('[data-message-rule="siws.domain-mismatch"]').first()).toBeAttached();
  expect(await within(p, 1_000)).toBe("pending");
  await m.locator(SEL.block).first().click();
  expectRejected(await within(p, 10_000), "siws-domain-mismatch Block");
  expect((await calls(page)).timeline).toEqual([]);
});

test("siws-expired: L2; text: L1; binary: L3 (each held, nothing reaches the wallet before a decision)", async ({ ext }) => {
  for (const [kind, level] of [["siws-expired", "L2"], ["text", "L1"], ["binary", "L3"]] as const) {
    const { page, path } = await begin(ext);
    const p = sample(ext, kind, path);
    const m = await review(ext, kind);
    expect(await reportLevel(m), `${kind} level`).toBe(level);
    expect(await attr(m, "data-message-kind"), `${kind} kind`).toBeTruthy();
    expect((await calls(page)).timeline, `${kind}: wallet reached while held`).toEqual([]);
    await m.locator(SEL.block).first().click();
    expectRejected(await within(p, 10_000), `${kind} Block`);
    expect((await calls(page)).timeline).toEqual([]);
    await page.reload();
    await page.evaluate(() => window.kelvaraTestDapp.ready);
  }
});

test("text message: Continue forwards the identical bytes once after the click", async ({ ext }) => {
  const { page, path } = await begin(ext);
  const p = sample(ext, "text", path);
  const m = await review(ext, "text");
  expect(await reportLevel(m)).toBe("L1");
  await armContinue(m);
  const clickedAt = Date.now();
  await m.locator(SEL.continue).first().click();
  expect(await within(p, 15_000)).toMatchObject({ ok: true });
  const log = await calls(page);
  expect(log.timeline).toHaveLength(1);
  expect(log.timeline[0]!.at).toBeGreaterThanOrEqual(clickedAt);
  expect(decode(log.messages[0]!.message)).toBe("Kelvara test message");
});

test("siws-expired: L2 offers Sign anyway and forwards once only after it", async ({ ext }) => {
  const { page, path } = await begin(ext);
  const p = sample(ext, "siws-expired", path);
  const m = await review(ext, "siws-expired");
  expect(await reportLevel(m)).toBe("L2");
  expect((await calls(page)).timeline).toEqual([]);
  if ((await m.locator(SEL.signAnyway).count()) === 0) { await m.locator(SEL.block).first().click(); expectRejected(await within(p, 10_000), "expired Block"); return; }
  await armSignAnyway(m);
  const clickedAt = Date.now();
  await m.locator(SEL.signAnyway).first().click();
  expect(await within(p, 15_000)).toMatchObject({ ok: true });
  const log = await calls(page);
  expect(log.timeline).toHaveLength(1);
  expect(log.timeline[0]!.at).toBeGreaterThanOrEqual(clickedAt);
});

test("transaction passed as a message: L4, rejected, no Sign anyway element, wallet never called", async ({ ext }) => {
  const { page, path } = await begin(ext);
  const p = sample(ext, "tx", path);
  const m = await review(ext, "tx-as-message");
  expect(await reportLevel(m)).toBe("L4");
  await expect(m.locator(SEL.signAnyway), "L4 message must not offer Sign anyway").toHaveCount(0);
  expectRejected(await within(p, 15_000), "L4 hidden transaction");
  expect((await calls(page)).timeline).toEqual([]);
});

for (const path of ["ws-register", "ws-app-ready", "legacy"] as const) {
  test(`${path}: solana:signIn input path is held and reviewed; Continue forwards once`, async ({ ext }) => {
    if (!hasReportUi()) pending("report UI not landed");
    const page = await openDapp(ext, "mainnet", null);
    const p = page.evaluate((w) => window.kelvaraTestDapp.signIn(w), path);
    const m = await review(ext, `signIn ${path}`);
    expect(await reportLevel(m)).toBe("L1");
    expect(await attr(m, "data-message-kind")).toBeTruthy();
    expect((await calls(page)).timeline, "wallet reached while signIn was held").toEqual([]);
    await armContinue(m);
    const clickedAt = Date.now();
    await m.locator(SEL.continue).first().click();
    expect(await within(p, 15_000)).toMatchObject({ ok: true });
    const log = await calls(page);
    expect(log.timeline).toHaveLength(1);
    expect(log.timeline[0]!.at).toBeGreaterThanOrEqual(clickedAt);
  });
}

test("signIn with a foreign domain is L3 and Block leaves the wallet uncalled", async ({ ext }) => {
  if (!hasReportUi()) pending("report UI not landed");
  const page = await openDapp(ext, "mainnet", null);
  const p = page.evaluate(() => window.kelvaraTestDapp.signIn("ws-app-ready", { domain: "evil.example" }));
  const m = await review(ext, "signIn domain");
  expect(await reportLevel(m)).toBe("L3");
  await m.locator(SEL.block).first().click();
  expectRejected(await within(p, 10_000), "signIn Block");
  expect((await calls(page)).timeline).toEqual([]);
});
