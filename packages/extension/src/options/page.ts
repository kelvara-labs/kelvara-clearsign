// Options page: Helius API key, default network, Test button.
// The key lives only in chrome.storage.local; this page never logs or displays it.
// All logic is in actions.ts; this file only wires the DOM.
import type { FetchLike } from "../sw/probe.js";
import { loadView, removeKey, saveSettings, testConnection, type Outcome, type Store } from "./actions.js";

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
  const store: Store = chrome.storage.local;
  const fetchFn = fetch.bind(globalThis) as unknown as FetchLike;
  const buttons = [save, clear, test];

  const show = (o: Pick<Outcome, "text" | "kind">) => {
    out.textContent = o.text;
    out.dataset.kind = o.kind;
  };
  const refresh = async () => {
    const view = await loadView(store);
    // Settings unreadable: do not let Save overwrite the stored network with a default.
    if (view.loaded) network.value = view.network;
    status.textContent = view.status;
    save.disabled = !view.loaded;
  };
  // One action at a time; any unexpected throw is shown, never swallowed.
  const run = (action: () => Promise<Outcome>) => async () => {
    for (const b of buttons) b.disabled = true;
    let o: Outcome;
    try {
      o = await action();
    } catch {
      o = { text: "Something went wrong; nothing was confirmed. Reload this page and try again.", kind: "err", clearField: false };
    }
    if (o.clearField) keyInput.value = "";
    for (const b of buttons) b.disabled = false;
    await refresh();
    show(o);
  };

  for (const b of buttons) b.disabled = true;
  await refresh();
  clear.disabled = false;
  test.disabled = false;

  save.addEventListener("click", run(() => saveSettings(store, keyInput.value, network.value)));
  clear.addEventListener("click", run(() => removeKey(store)));
  test.addEventListener(
    "click",
    run(async () => {
      show({ text: "Testing…", kind: "info" });
      return testConnection(store, keyInput.value, network.value, fetchFn);
    })
  );
}
