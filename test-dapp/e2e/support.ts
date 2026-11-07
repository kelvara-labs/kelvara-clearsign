// G7 support: launches headless Chromium (Playwright's bundled "chromium" channel) with the
// built extension, opens the test dApp, finds the report UI frame, and reports PENDING for
// cases whose feature has not landed. Contract for the extension: test-dapp/e2e/README.md.
//
// PENDING vs FAIL: a case calls pending(reason) when a feature it needs is absent (report UI,
// real engine, a scenario fixture, the Helius key). It still runs and asserts everything it
// can before that point, so a regression in what exists FAILs. The runner
// (tools/selfcheck/src/e2e.mjs) maps any failure to FAIL, else any pending to PENDING (78).
import { test as base, expect, chromium, type BrowserContext, type Frame, type Page, type Worker } from "../../tools/selfcheck/src/playwright.mjs";
import { hasRealEngine as detectRealEngine } from "../../tools/selfcheck/src/engine-readiness.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CallLog, SignArgs, SignResult, TestDappApi, WalletPath } from "../src/index.js";

export { expect };
export type { CallLog, SignArgs, SignResult, WalletPath };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const EXT_DIR = process.env.KELVARA_EXT_DIR ?? path.join(ROOT, "packages/extension/dist");
export const DAPP_URL = process.env.TEST_DAPP_URL ?? "http://127.0.0.1:5174/";
export const WALLET_NAMES: Record<WalletPath, string> = {
  "ws-register": "Kelvara Fixture (register)",
  "ws-app-ready": "Kelvara Fixture (app-ready)",
  legacy: "Kelvara Fixture (legacy)"
};
export const PATHS: WalletPath[] = ["ws-register", "ws-app-ready", "legacy"];
/** PLAN M5: nobody answers within 90 s means blocked. */
export const HOLD_TIMEOUT_MS = 90_000;

// ---------- features (static, from the tree under test) ----------

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Report UI landed: the manifest exposes an extension page to embed (web_accessible_resources with an .html). */
export function hasReportUi(): boolean {
  const m = readJson(path.join(EXT_DIR, "manifest.json"));
  const war = Array.isArray(m?.web_accessible_resources) ? (m!.web_accessible_resources as { resources?: unknown }[]) : [];
  return war.some((w) => Array.isArray(w.resources) && w.resources.some((r) => typeof r === "string" && r.endsWith(".html")));
}

/** Only proven L2 stub wiring defers the engine cases; dependencies are not integration. */
export function hasRealEngine(): boolean {
  return detectRealEngine(ROOT);
}

/** HELIUS_API_KEY from the environment or the main checkout's .env. Never printed. */
export function heliusKey(): string | null {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const text = readFileSync(path.resolve(common, "..", ".env"), "utf8");
    const m = text.match(/^\s*(?:export\s+)?HELIUS_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

// ---------- fixtures (real bytes only: fixtures/tx/manifest.json) ----------

export type E2eRole = "benign" | "l4-sweep" | "l3-batch" | "l2-trap";
export interface TxCase {
  role: E2eRole;
  file: string;
  tx: string; // base64 wire bytes
  chain: string; // Wallet Standard chain
  network: "mainnet" | "devnet" | "localnet";
}

/** Default benign case until scenarios tags one: a real mainnet SOL transfer (System, legacy). */
const DEFAULT_BENIGN = "tx/mainnet/system/51AfDTHpz6Z3PoZAxLeLNXn52qghSTByFXcHbXFypAwZt7oxQ4JL6itzLP3ZypqWTkZrZgFCkR9oxPpMidYvncT7.json";

function loadCaseFile(role: E2eRole, rel: string): TxCase | null {
  const file = path.join(ROOT, "fixtures", rel);
  const d = readJson(file);
  if (!d || typeof d.transaction !== "string" || d.encoding !== "base64") return null;
  const network = d.network === "devnet" || d.network === "localnet" ? d.network : "mainnet";
  return { role, file: rel, tx: d.transaction, chain: `solana:${network}`, network };
}

/** A fixture tagged `"e2e": "<role>"` in fixtures/tx/manifest.json (scenarios owns the tags). */
export function txCase(role: E2eRole): TxCase | null {
  const manifest = readJson(path.join(ROOT, "fixtures/tx/manifest.json")) as unknown;
  const entries = Array.isArray(manifest) ? (manifest as Record<string, unknown>[]) : [];
  const tagged = entries.find((e) => e.e2e === role && typeof e.path === "string");
  if (tagged) return loadCaseFile(role, tagged.path as string);
  if (role === "benign") {
    const rel = existsSync(path.join(ROOT, "fixtures", DEFAULT_BENIGN))
      ? DEFAULT_BENIGN
      : (entries.find((e) => e.slug === "system" && typeof e.path === "string")?.path as string | undefined);
    return rel ? loadCaseFile(role, rel) : null;
  }
  return null;
}

// ---------- pending ----------

/** Mark the running case PENDING: what ran so far passed; the rest needs `reason`. */
export function pending(reason: string): never {
  base.info().annotations.push({ type: "pending", description: reason });
  base.skip(true, `PENDING: ${reason}`);
  throw new Error("unreachable");
}

// ---------- extension + page ----------

export interface Ext {
  context: BrowserContext;
  sw: Worker;
  extId: string;
  page: Page;
  /** Put settings in the extension's options storage (chrome.storage.local). */
  configure(s: { heliusApiKey?: string; network?: "mainnet" | "devnet" | "localnet" }): Promise<void>;
  /** Entries the service worker logged (captureLog, newest first). */
  captureLog(): Promise<CaptureEntry[]>;
}

export interface CaptureEntry {
  url: string;
  method: string;
  wallet: string;
  chain: string | null;
  txCount: number;
  level: number | null;
  allow: boolean;
}

export const test = base.extend<{ ext: Ext }>({
  // eslint-disable-next-line no-empty-pattern
  ext: async ({}, use) => {
    if (!existsSync(path.join(EXT_DIR, "manifest.json"))) throw new Error(`extension not built: ${EXT_DIR}`);
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`]
    });
    try {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
      const extId = new URL(sw.url()).host;
      const page = await context.newPage();
      const ext: Ext = {
        context,
        sw,
        extId,
        page,
        configure: (s) =>
          sw.evaluate(async (v) => {
            await (globalThis as unknown as { chrome: { storage: { local: { set(o: object): Promise<void> } } } }).chrome.storage.local.set(v);
          }, s),
        captureLog: () =>
          sw.evaluate(async () => {
            const c = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome;
            const got = await c.storage.local.get("captureLog");
            return (Array.isArray(got.captureLog) ? got.captureLog : []) as CaptureEntry[];
          })
      };
      await use(ext);
    } finally {
      await context.close();
    }
  }
});

/** Configure the extension for a case's network, open the dApp and wait until the wallets are registered. */
export async function openDapp(ext: Ext, network: "mainnet" | "devnet" | "localnet" = "mainnet", key = heliusKey()): Promise<Page> {
  await ext.configure({ network, ...(key ? { heliusApiKey: key } : {}) });
  const { page } = ext;
  await page.goto(DAPP_URL);
  await page.evaluate(() => window.kelvaraTestDapp.ready);
  return page;
}

/** Start a sign call in the page; resolves with the dApp's SignResult (it never throws). */
export function startSign(page: Page, args: SignArgs): Promise<SignResult> {
  return page.evaluate((a) => window.kelvaraTestDapp.sign(a), args);
}

export const calls = (page: Page): Promise<CallLog> => page.evaluate(() => window.kelvaraTestDapp.calls());
export const forgeReport = (page: Page) => page.evaluate(() => window.kelvaraTestDapp.lastForge);
export const discovered = (page: Page): Promise<TestDappApi["discovered"]> => page.evaluate(() => window.kelvaraTestDapp.discovered);

/** Settle within ms, or "pending". */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"pending">((r) => (t = setTimeout(() => r("pending"), ms)));
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(t);
  }
}

// ---------- report UI (contract: README.md) ----------

export const SEL = {
  modal: "[data-kelvara-modal]",
  level: "[data-kelvara-level]",
  block: '[data-kelvara-action="block"]',
  signAnyway: '[data-kelvara-action="sign-anyway"]'
};

/** Extension frames in the page (the report UI lives in one, inside a closed shadow root). */
export function extensionFrames(ext: Ext): Frame[] {
  return ext.page.frames().filter((f) => f.url().startsWith(`chrome-extension://${ext.extId}/`));
}

/** The frame showing a modal report, or null if none appears within ms. */
export async function waitForModal(ext: Ext, ms: number): Promise<Frame | null> {
  const end = Date.now() + ms;
  do {
    for (const f of extensionFrames(ext)) {
      try {
        if (await f.locator(SEL.modal).first().isVisible()) return f;
      } catch {
        /* frame navigating or detached */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  return null;
}

/** Wait for whichever comes first: the sign call settles or a modal appears. */
export async function settleOrModal(ext: Ext, p: Promise<SignResult>, ms: number): Promise<{ result: SignResult } | { modal: Frame } | "timeout"> {
  const end = Date.now() + ms;
  let settled: SignResult | undefined;
  void p.then((r) => (settled = r));
  while (Date.now() < end) {
    if (settled) return { result: settled };
    const m = await waitForModal(ext, 0);
    if (m) return { modal: m };
    await new Promise((r) => setTimeout(r, 100));
  }
  return settled ? { result: settled } : "timeout";
}

export async function reportLevel(frame: Frame): Promise<string | null> {
  return frame.locator(SEL.level).first().getAttribute("data-kelvara-level");
}

/** Hold-to-confirm: press Sign anyway for its data-hold-ms (+ margin), then release. */
export async function holdSignAnyway(ext: Ext, frame: Frame): Promise<void> {
  const btn = frame.locator(SEL.signAnyway).first();
  const holdMs = Number((await btn.getAttribute("data-hold-ms")) ?? "0");
  expect(holdMs, "L3 Sign anyway must declare data-hold-ms (hold to confirm)").toBeGreaterThan(0);
  const box = await btn.boundingBox();
  expect(box, "Sign anyway button has no box").not.toBeNull();
  await ext.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await ext.page.mouse.down();
  await new Promise((r) => setTimeout(r, holdMs + 400));
  await ext.page.mouse.up();
}

/** Expect a hook rejection with code 4001. */
export function expectRejected(r: SignResult | "pending", what: string): void {
  expect(r, `${what}: still pending`).not.toBe("pending");
  expect(r as SignResult, `${what}: expected rejection 4001`).toMatchObject({ ok: false, error: { code: 4001 } });
}
