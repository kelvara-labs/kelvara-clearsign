// Shared helpers for AI/provider browser specs: temp dist copy with http://127.0.0.1/* host permission (so the real
// Options UI Save resolves headlessly), loopback mock provider, Options-UI provider save, fee payer of a wire tx.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXT_DIR, ROOT, expect, type Ext } from "./support.js";

export const AI_DIR = mkdtempSync(path.join(os.tmpdir(), "kelvara-ai-ext-"));
cpSync(EXT_DIR, AI_DIR, { recursive: true });
{
  const mp = path.join(AI_DIR, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8")) as { host_permissions?: string[] };
  m.host_permissions = [...(m.host_permissions ?? []), "http://127.0.0.1/*"];
  writeFileSync(mp, JSON.stringify(m));
}
process.on("exit", () => rmSync(AI_DIR, { recursive: true, force: true }));

export interface Mock { url: string; last(): MockRequest | null; close(): Promise<void> }
export interface MockRequest { path: string; mode: string; authorization: string | null; bodyText: string; input: Record<string, unknown> }
export async function startMock(mode: string): Promise<Mock> {
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
export function feePayer(txB64: string): string {
  const raw = Buffer.from(txB64, "base64");
  let o = 0, sigs = 0, shift = 0;
  for (;;) { const b = raw[o++]!; sigs |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  o += sigs * 64;
  if (raw[o]! & 0x80) o += 1;
  o += 3;
  while (raw[o++]! & 0x80) { /* skip account count */ }
  return base58(raw.subarray(o, o + 32));
}

export const SYNTHETIC_KEY = "VERIFIER_SYNTHETIC_PROVIDER_KEY_NEVER_REAL";

export async function saveProvider(ext: Ext, url: string, key?: string) {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extId}/options.html`);
  await options.locator("#ai-provider summary").click();
  await options.locator("#ai-url").fill(url);
  await options.locator("#ai-model").fill("mock-model");
  if (key) await options.locator("#ai-key").fill(key);
  await options.locator("#ai-enabled").setChecked(true, { force: true });
  await options.locator("#ai-save").click();
  await expect(options.locator("#ai-result")).toHaveAttribute("data-kind", "ok");
  await options.close();
  await ext.approveConfiguredProvider();
}
