// Options page: Helius API key, default network, Test button.
// The key lives only in chrome.storage.local; this page never logs or displays it.
import { pickEndpoint } from "../sw/endpoint.js";
import { probeEndpoint, type FetchLike } from "../sw/probe.js";
import { readSettings } from "../sw/settings.js";
import { keyForTest, keyStatus, planSave } from "./form.js";

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`options page is missing #${id}`);
  return e as T;
}

export async function mountOptions(): Promise<void> {
  const keyInput = el<HTMLInputElement>("helius-key");
  const network = el<HTMLSelectElement>("network");
  const status = el<HTMLElement>("key-status");
  const out = el<HTMLElement>("result");
  const save = el<HTMLButtonElement>("save");
  const clear = el<HTMLButtonElement>("clear-key");
  const test = el<HTMLButtonElement>("test");

  const show = (text: string, kind: "ok" | "err" | "info") => {
    out.textContent = text;
    out.dataset.kind = kind;
  };
  const refresh = async () => {
    const raw = await chrome.storage.local.get(["heliusApiKey", "network"]);
    network.value = readSettings(raw).network;
    status.textContent = keyStatus(raw.heliusApiKey);
    return raw;
  };
  await refresh();

  save.addEventListener("click", async () => {
    const plan = planSave({ keyField: keyInput.value, network: network.value });
    if (!plan.ok) return show(plan.error, "err");
    await chrome.storage.local.set(plan.patch);
    keyInput.value = "";
    await refresh();
    show("Saved.", "ok");
  });

  clear.addEventListener("click", async () => {
    await chrome.storage.local.remove("heliusApiKey");
    keyInput.value = "";
    await refresh();
    show("Key removed. Signing requests on mainnet and devnet are now held and blocked.", "info");
  });

  test.addEventListener("click", async () => {
    test.disabled = true;
    show("Testing…", "info");
    try {
      const raw = await chrome.storage.local.get(["heliusApiKey"]);
      if (keyInput.value.trim() && !keyForTest(keyInput.value, undefined)) {
        return show("that does not look like a Helius API key (letters, digits and dashes only)", "err");
      }
      const net = network.value === "devnet" || network.value === "localnet" ? network.value : "mainnet";
      const chain = net === "mainnet" ? "solana:mainnet" : net === "devnet" ? "solana:devnet" : "solana:localnet";
      const endpoint = pickEndpoint(chain, net, keyForTest(keyInput.value, raw.heliusApiKey));
      const r = await probeEndpoint(endpoint, fetch.bind(globalThis) as unknown as FetchLike);
      show(r.ms === null ? r.message : `${r.message} (${r.ms} ms)`, r.ok ? "ok" : "err");
    } finally {
      test.disabled = false;
    }
  });
}
