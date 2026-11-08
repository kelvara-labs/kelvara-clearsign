// V15 AI intent browser e2e. Real engine on live localnet cases; the provider is the loopback mock
// (test-dapp/scripts/mock-provider.mjs). No real AI provider, no real key: keys here are synthetic strings.
// The provider is saved through the real Options UI. Headless Chromium cannot accept the native permission prompt, so
// the extension under test is a TEMP COPY of dist whose manifest gets http://127.0.0.1/* in host_permissions
// (test-dapp/README.md). The release zip and packages/extension/dist are never modified.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CASES_MISSING, DAPP_URL, EXT_DIR, ROOT, calls, expect, expectRejected, hasRealEngine, hasReportUi, localCase, openDapp, pending, reportLevel, SEL,
  heliusKey, startSign, test, waitForModal, within, type Ext, type LocalCase, type LocalRole
} from "./support.js";
import type { Frame } from "../../tools/selfcheck/src/playwright.mjs";

const AI_DIR = mkdtempSync(path.join(os.tmpdir(), "kelvara-ai-ext-"));
cpSync(EXT_DIR, AI_DIR, { recursive: true });
{
  const mp = path.join(AI_DIR, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8")) as { host_permissions?: string[] };
  m.host_permissions = [...(m.host_permissions ?? []), "http://127.0.0.1/*"];
  writeFileSync(mp, JSON.stringify(m));
}
process.on("exit", () => rmSync(AI_DIR, { recursive: true, force: true }));
test.use({ extDir: AI_DIR });

interface Mock { url: string; last(): MockRequest | null; close(): Promise<void> }
interface MockRequest { path: string; mode: string; authorization: string | null; bodyText: string; input: Record<string, unknown> }
async function startMock(mode: string): Promise<Mock> {
  const mod = (await import(pathToFileURL(path.join(ROOT, "test-dapp/scripts/mock-provider.mjs")).href as string)) as { startMock(o: { mode: string }): Promise<Mock> };
  return mod.startMock({ mode });
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b) break; out = "1" + out; }
  return out;
}
/** Fee payer (first account key) of a wire transaction: the signer that sends the transfer. */
function feePayer(txB64: string): string {
  const raw = Buffer.from(txB64, "base64");
  let o = 0, sigs = 0, shift = 0;
  for (;;) { const b = raw[o++]!; sigs |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  o += sigs * 64;
  if (raw[o]! & 0x80) o += 1;
  o += 3;
  while (raw[o++]! & 0x80) { /* skip account count */ }
  return base58(raw.subarray(o, o + 32));
}

const SYNTHETIC_KEY = "VERIFIER_SYNTHETIC_PROVIDER_KEY_NEVER_REAL";

async function saveProvider(ext: Ext, url: string, key?: string) {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extId}/options.html`);
  await options.locator("#ai-provider summary").click();
  await options.locator("#ai-url").fill(url);
  await options.locator("#ai-model").fill("mock-model");
  if (key) await options.locator("#ai-key").fill(key);
  await options.locator("#ai-enabled").check();
  await options.locator("#ai-save").click();
  await expect(options.locator("#ai-result")).toHaveAttribute("data-kind", "ok");
  await options.close();
  await ext.approveConfiguredProvider();
}

interface Snapshot {
  level: string | null; actions: string[]; hashes: string[]; claims: string[];
  intent: { source: string | null; status: string | null; question: string | null; questionId: string | null; reasons: string[] } | null;
}
async function snapshot(m: Frame): Promise<Snapshot> {
  const card = m.locator("[data-kelvara-intent]").first();
  const has = (await card.count()) > 0;
  return {
    level: await reportLevel(m),
    actions: (await m.locator("[data-kelvara-action]").evaluateAll(els => els.map(e => e.getAttribute("data-kelvara-action") ?? ""))).sort(),
    hashes: await m.locator("[data-kelvara-hash]").allInnerTexts(),
    claims: await m.locator("[data-claim]").allInnerTexts(),
    intent: has ? {
      source: await card.locator("[data-intent-source]").getAttribute("data-intent-source"),
      status: await card.getAttribute("data-intent-status"),
      question: await card.locator("[data-intent-question]").innerText(),
      questionId: await card.locator("[data-intent-question]").getAttribute("data-intent-question"),
      reasons: await card.locator("[data-intent-reason]").evaluateAll(els => els.map(e => e.getAttribute("data-intent-reason") ?? ""))
    } : null
  };
}

async function needLocal(role: LocalRole) {
  if (!hasRealEngine()) pending("real engine not wired into the extension");
  if (CASES_MISSING) pending(`localnet cases unavailable: ${CASES_MISSING}`);
  if (!hasReportUi()) pending("report UI not landed");
  return localCase(role);
}

/** Run one localnet case end to end and settle it: L4 rejects itself, L2/L3 are held until Block. */
async function runCase(ext: Ext, role: LocalRole, fixed?: LocalCase): Promise<Snapshot> {
  const c = fixed ?? await needLocal(role);
  const page = await openDapp(ext, "localnet");
  const path = role === "l2-trap" ? "ws-register" : "ws-app-ready";
  const p = startSign(page, { path, txs: [c.tx], chain: c.chain, account: c.signer });
  const m = await waitForModal(ext, 45_000);
  expect(m, `${role}: no report modal within 45 s`).not.toBeNull();
  if (role.startsWith("l4")) expectRejected(await within(p, 45_000), `${role} L4`);
  else {
    // A card may render a little after the modal; give it the same frame, then read.
    await m!.locator("[data-kelvara-intent]").first().waitFor({ timeout: 10_000 }).catch(() => {});
    expect(await within(p, 1_500), `${role}: settled without a user decision`).toBe("pending");
    expect((await calls(page)).count, `${role}: wallet called while held`).toBe(0);
  }
  await m!.locator("[data-kelvara-intent]").first().waitFor({ timeout: 10_000 }).catch(() => {});
  const snap = await snapshot(m!);
  if (!role.startsWith("l4")) {
    await m!.locator(SEL.block).first().click();
    expectRejected(await within(p, 10_000), `${role} Block`);
  }
  expect((await calls(page)).count, `${role}: wallet was called`).toBe(0);
  return snap;
}

const ROLES: LocalRole[] = ["l3-admin", "l2-trap", "l4-sweep"];

for (const role of ROLES) {
  test(`${role}: real-engine report shows the intent card as engine, not-configured when no provider is saved`, async ({ ext }) => {
    const s = await runCase(ext, role);
    expect(s.intent, "no intent card (data-kelvara-intent) in the report").not.toBeNull();
    expect(s.intent).toMatchObject({ source: "engine", status: "not-configured" });
  });
}

// l2-trap is the complex AI target: three engine candidates, two of them below the fallback priority (lower-priority mode applies).
// The same transaction bytes (one blockhash) are used with and without AI so message hashes are comparable.
async function complexRole(ext: Ext): Promise<{ role: LocalRole; c: LocalCase; plain: Snapshot }> {
  const role: LocalRole = "l2-trap";
  const c = await needLocal(role);
  const plain = await runCase(ext, role, c);
  expect(plain.intent, "complex case without a provider").toMatchObject({ source: "engine", status: "not-configured" });
  return { role, c, plain };
}

test("select-highest: complex case shows source=ai/selected with an engine question; level, buttons, hashes, claims unchanged", async ({ ext }) => {
  await needLocal("l3-admin");
  const mock = await startMock("select-highest");
  try {
    const { role, c, plain } = await complexRole(ext);
    await saveProvider(ext, `${mock.url}/v1/chat/completions`);
    const ai = await runCase(ext, role, c);
    expect(ai.intent, "AI card").toMatchObject({ source: "ai", status: "selected" });
    const req = mock.last();
    expect(req, "mock never called").not.toBeNull();
    const candidates = req!.input.candidates as { id: string; question: string; priority: number }[];
    const chosen = candidates.find(c => c.id === ai.intent!.questionId);
    expect(chosen, "selected question is not an engine candidate").toBeDefined();
    expect(ai.intent!.question).toBe(chosen!.question);
    const fallback = candidates.find(c => c.id === req!.input.fallbackId)!;
    expect(chosen!.priority).toBeGreaterThanOrEqual(fallback.priority);
    expect({ ...ai, intent: null }).toEqual({ ...plain, intent: null });
  } finally { await mock.close(); }
});

const INVALID: { mode: string; status: "invalid" | "unavailable" }[] = [
  { mode: "lower-priority", status: "invalid" }, { mode: "wrong-binding", status: "invalid" }, { mode: "invented-reason", status: "invalid" },
  { mode: "malformed", status: "invalid" }, { mode: "refusal", status: "invalid" }, { mode: "http-500", status: "unavailable" },
  { mode: "redirect", status: "unavailable" }, { mode: "slow", status: "unavailable" }, { mode: "oversize", status: "unavailable" }
];
for (const { mode, status } of INVALID) {
  test(`${mode}: falls back to the engine template (${status}); level and controls unchanged; wallet uncalled until the user decides`, async ({ ext }) => {
    await needLocal("l3-admin");
    const mock = await startMock(mode);
    try {
      const { role, c, plain } = await complexRole(ext);
      await saveProvider(ext, `${mock.url}/v1/chat/completions`);
      const ai = await runCase(ext, role, c);
      const asked = mock.last();
      expect(asked, `${mode}: the mock was never asked`).not.toBeNull();
      if (mode === "lower-priority") {
        const cs = asked!.input.candidates as { id: string; priority: number }[];
        expect(cs.some(c => c.priority < cs.find(f => f.id === asked!.input.fallbackId)!.priority), "no lower-priority candidate to select").toBe(true);
      }
      expect(ai.intent).toMatchObject({ source: "engine", status });
      expect(ai.intent!.questionId).toBe(plain.intent!.questionId);
      expect({ ...ai, intent: null }).toEqual({ ...plain, intent: null });
    } finally { await mock.close(); }
  });
}

test("request to the provider carries only public engine facts; Authorization only when a key is configured", async ({ ext }) => {
  await needLocal("l3-admin");
  const mock = await startMock("select-highest");
  try {
    const { role, c } = await complexRole(ext);
    await saveProvider(ext, `${mock.url}/v1/chat/completions`);
    await runCase(ext, role, c);
    const keyless = mock.last();
    expect(keyless, "mock never called").not.toBeNull();
    expect(keyless!.authorization, "Authorization sent without a configured key").toBeNull();
    await saveProvider(ext, `${mock.url}/v1/chat/completions`, SYNTHETIC_KEY);
    await runCase(ext, role, c);
    const keyed = mock.last()!;
    expect(keyed.authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
    for (const req of [keyless!, keyed]) {
      expect(Object.keys(req.input).sort()).toEqual(["binding", "candidates", "fallbackId"]);
      const body = req.bodyText;
      expect(body, "synthetic key in request body").not.toContain(SYNTHETIC_KEY);
      expect(body, "raw transaction bytes in request").not.toContain(c.tx);
      expect(body, "transaction base64 prefix in request").not.toContain(c.tx.slice(0, 40));
      expect(body, "page URL in request").not.toContain(new URL(DAPP_URL).host);
      expect(body, "page origin in request").not.toMatch(/https?:\/\//);
      expect(body).not.toContain(c.signer);
      expect(body).not.toMatch(/api-key|helius|signature/i);
      expect(body).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/); // base58 signature-length strings
      expect(body).not.toMatch(/[A-Za-z0-9+/]{120,}={0,2}/); // base64 transaction-length strings
    }
  } finally { await mock.close(); }
});

test("routine memo/transfer case sends no request to the provider", async ({ ext }) => {
  if (!hasRealEngine()) pending("real engine not wired into the extension");
  if (!hasReportUi()) pending("report UI not landed");
  // Real mainnet fixture with exactly one System transfer and no ComputeBudget instruction. A transfer with ComputeBudget
  // is NOT routine to the engine today (unknown-effects candidate at priority 2, complex=true): reported to the coordinator.
  const rel = "tx/mainnet/first-send/3jNbU4S8iZrerW8s3t7tF3DrMa1MDhGKT1FYRdsqgowdZxGiLLNYvHmYCsbbMSiyZaBrBL8VCtgKwwdA66ysDre7.json";
  const c = { tx: (JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as { transaction: string }).transaction, chain: "solana:mainnet", network: "mainnet" as const };
  if (!heliusKey()) pending("HELIUS_API_KEY missing");
  const mock = await startMock("select-highest");
  try {
    await saveProvider(ext, `${mock.url}/v1/chat/completions`, SYNTHETIC_KEY);
    const page = await openDapp(ext, c.network);
    const p = startSign(page, { path: "ws-app-ready", txs: [c.tx], chain: c.chain, account: feePayer(c.tx) });
    const m = await waitForModal(ext, 45_000);
    expect(m, "no report modal").not.toBeNull();
    expect(await within(p, 1_500)).toBe("pending");
    expect((await calls(page)).count).toBe(0);
    const s = await snapshot(m!);
    expect(s.intent, "routine transfer must still show the engine card").toMatchObject({ source: "engine", status: "template" });
    await m!.locator(SEL.block).first().click();
    expectRejected(await within(p, 10_000), "benign Block");
    expect(mock.last(), "provider was contacted for a routine transfer").toBeNull();
  } finally { await mock.close(); }
});
