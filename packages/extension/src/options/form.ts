// Options form logic, kept free of the DOM so it can be unit tested.
import type { Network } from "../sw/endpoint.js";
import { isNetwork, normalizeKey } from "../sw/settings.js";

export interface FormInput {
  /** What the user typed; empty means "keep the saved key". */
  keyField: string;
  network: string;
}

export type SavePlan =
  | { ok: true; patch: { heliusApiKey?: string; network: Network } }
  | { ok: false; error: string };

export function planSave(input: FormInput): SavePlan {
  if (!isNetwork(input.network)) return { ok: false, error: "pick a network" };
  const typed = input.keyField.trim();
  if (!typed) return { ok: true, patch: { network: input.network } };
  const key = normalizeKey(typed);
  if (!key) return { ok: false, error: "that does not look like a Helius API key (letters, digits and dashes only)" };
  return { ok: true, patch: { heliusApiKey: key, network: input.network } };
}

/** The key the Test button should use: the typed one if any, else the saved one. */
export function keyForTest(keyField: string, saved: unknown): string | undefined {
  return keyField.trim() ? normalizeKey(keyField) : normalizeKey(saved);
}

/** Never echo the key; say only whether one is saved. */
export function keyStatus(saved: unknown): string {
  return normalizeKey(saved) ? "A Helius API key is saved." : "No Helius API key saved: every signing request on mainnet or devnet is held and blocked.";
}
