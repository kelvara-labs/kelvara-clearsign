import type { Network } from "./endpoint.js";
import type { Settings } from "./policy.js";

export const SETTINGS_KEYS = ["heliusApiKey", "network", "passThrough"] as const;

export function readSettings(raw: Record<string, unknown>): Settings {
  const n = raw.network;
  const network: Network = n === "devnet" || n === "localnet" ? n : "mainnet";
  const key = typeof raw.heliusApiKey === "string" ? raw.heliusApiKey : undefined;
  return { heliusApiKey: key, network, passThrough: raw.passThrough === true };
}
