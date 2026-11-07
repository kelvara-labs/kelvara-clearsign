// Options page actions, kept free of the DOM so they can be unit tested.
// Every chrome.storage call can reject (quota, extension context gone, corrupt
// profile). Each action catches that and reports it fail-closed: it never says
// "Saved" or "removed" unless storage confirmed it, and it never echoes the key.
import { pickEndpoint, type Network } from "../sw/endpoint.js";
import { probeEndpoint, type FetchLike } from "../sw/probe.js";
import { readSettings } from "../sw/settings.js";
import { keyForTest, keyStatus, planSave } from "./form.js";

export interface Store {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export type Kind = "ok" | "err" | "info";
export interface Outcome {
  text: string;
  kind: Kind;
  /** True when the key field should be emptied (the typed key was stored). */
  clearField: boolean;
}

export interface View {
  network: Network;
  status: string;
  /** False when settings could not be read: the page must not offer to save over them. */
  loaded: boolean;
}

export const BAD_KEY = "that does not look like a Helius API key (letters, digits and dashes only)";
export const READ_FAILED =
  "Could not read saved settings. Until this is fixed, signing requests on mainnet and devnet are held and blocked. Reload this page to try again.";

export async function loadView(store: Store): Promise<View> {
  try {
    const raw = await store.get(["heliusApiKey", "network"]);
    return { network: readSettings(raw).network, status: keyStatus(raw.heliusApiKey), loaded: true };
  } catch {
    return { network: "mainnet", status: READ_FAILED, loaded: false };
  }
}

export async function saveSettings(store: Store, keyField: string, network: string): Promise<Outcome> {
  const plan = planSave({ keyField, network });
  if (!plan.ok) return { text: plan.error, kind: "err", clearField: false };
  try {
    await store.set(plan.patch);
  } catch {
    return {
      text: "Could not save settings: nothing was changed. Try again; until a key is saved, signing requests on mainnet and devnet are held and blocked.",
      kind: "err",
      clearField: false
    };
  }
  return { text: "Saved.", kind: "ok", clearField: true };
}

export async function removeKey(store: Store): Promise<Outcome> {
  try {
    await store.remove("heliusApiKey");
  } catch {
    return {
      text: "Could not remove the key: it may still be saved. Try again, or remove the extension to delete it.",
      kind: "err",
      clearField: false
    };
  }
  return {
    text: "Key removed. Signing requests on mainnet and devnet are now held and blocked.",
    kind: "info",
    clearField: true
  };
}

function chainFor(network: string): "solana:mainnet" | "solana:devnet" | "solana:localnet" {
  if (network === "devnet") return "solana:devnet";
  if (network === "localnet") return "solana:localnet";
  return "solana:mainnet";
}

export async function testConnection(store: Store, keyField: string, network: string, fetchFn: FetchLike): Promise<Outcome> {
  const typed = keyField.trim();
  if (typed && !keyForTest(typed, undefined)) return { text: BAD_KEY, kind: "err", clearField: false };
  let saved: unknown;
  if (!typed) {
    try {
      saved = (await store.get(["heliusApiKey"])).heliusApiKey;
    } catch {
      return { text: "Could not read the saved key, so the connection was not tested.", kind: "err", clearField: false };
    }
  }
  const net = network === "devnet" || network === "localnet" ? network : "mainnet";
  const endpoint = pickEndpoint(chainFor(net), net, keyForTest(typed, saved));
  const r = await probeEndpoint(endpoint, fetchFn);
  return { text: r.ms === null ? r.message : `${r.message} (${r.ms} ms)`, kind: r.ok ? "ok" : "err", clearField: false };
}
