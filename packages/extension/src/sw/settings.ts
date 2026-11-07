import { LICENSE_MAX } from "../license/verify.js";
import type { Network } from "./endpoint.js";
import type { Settings } from "./policy.js";

export const SETTINGS_KEYS = ["heliusApiKey", "network", "licenseKey"] as const;
export const NETWORKS: readonly Network[] = ["mainnet", "devnet", "localnet"];

/**
 * Helius keys are UUIDs; accept any plain token of that alphabet. Anything else
 * (spaces, '&', '/', a pasted URL) is treated as no key, so it can never be spliced
 * into a request URL and the request is held instead.
 */
const KEY_RE = /^[A-Za-z0-9-]{16,128}$/;

export function normalizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const k = raw.trim();
  return KEY_RE.test(k) ? k : undefined;
}

export function isNetwork(x: unknown): x is Network {
  return typeof x === "string" && (NETWORKS as readonly string[]).includes(x);
}

export function readSettings(raw: Record<string, unknown>): Settings {
  const network: Network = isNetwork(raw.network) ? raw.network : "mainnet";
  const licenseKey = typeof raw.licenseKey === "string" && raw.licenseKey.length <= LICENSE_MAX ? raw.licenseKey : undefined;
  return { heliusApiKey: normalizeKey(raw.heliusApiKey), network, passThrough: false, licenseKey };
}

export type LoadedSettings = { ok: true; settings: Settings } | { ok: false; reason: string };

/**
 * Read settings for a signing decision. A storage failure is not "no settings":
 * it is reported so the caller blocks the request (fail closed), never defaults.
 */
export async function loadSettings(get: (keys: string[]) => Promise<Record<string, unknown>>): Promise<LoadedSettings> {
  try {
    return { ok: true, settings: readSettings(await get([...SETTINGS_KEYS])) };
  } catch {
    return { ok: false, reason: "could not read extension settings: request blocked" };
  }
}

/** Public setup status for extension pages; never returns a stored key. */
export function setupSummary(raw: Record<string, unknown>): { network: Network; ready: boolean; bypassed: boolean } {
  const settings = readSettings(raw);
  const bypassed = settings.passThrough;
  return { network: settings.network, ready: !bypassed && (!!settings.heliusApiKey || settings.network === "localnet"), bypassed };
}
