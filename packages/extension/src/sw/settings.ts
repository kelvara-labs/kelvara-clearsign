import type { Network } from "./endpoint.js";
import type { Settings } from "./policy.js";

export const SETTINGS_KEYS = ["heliusApiKey", "network", "passThrough"] as const;
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
  return { heliusApiKey: normalizeKey(raw.heliusApiKey), network, passThrough: raw.passThrough === true };
}
