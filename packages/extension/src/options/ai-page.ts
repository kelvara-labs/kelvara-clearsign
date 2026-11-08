import { deleteProvider, loadProviderView, saveProvider, requestProviderTest } from "./ai-actions.js";
import type { Outcome } from "./actions.js";
export async function mountAIOptions(): Promise<void> {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const details = get<HTMLDetailsElement>("ai-provider");
  details.open = false;
  const url = get<HTMLInputElement>("ai-url");
  const key = get<HTMLInputElement>("ai-key");
  const model = get<HTMLInputElement>("ai-model");
  const enabled = get<HTMLInputElement>("ai-enabled");
  const out = get<HTMLElement>("ai-result");
  const save = get<HTMLButtonElement>("ai-save");
  const remove = get<HTMLButtonElement>("ai-delete");
  const test = get<HTMLButtonElement>("ai-test");
  const buttons = [save, remove, test];
  save.disabled = true;
  const store = chrome.storage.local;
  const permissions = {
    request: (p: { origins: string[] }) => chrome.permissions.request(p),
    contains: (p: { origins: string[] }) => chrome.permissions.contains(p)
  };
  const refresh = async () => {
    const view = await loadProviderView(store);
    url.value = view.url;
    model.value = view.model;
    enabled.checked = view.enabled;
    key.value = "";
    key.placeholder = view.hasKey ? "Saved key · blank keeps it for the same endpoint" : "Optional for local inference";
    save.disabled = !view.loaded;
    if (!view.loaded) out.textContent = "Provider settings unavailable. Engine templates remain available.";
  };
  const run = (action: () => Promise<Outcome>) => () => {
    buttons.forEach(b => { b.disabled = true; });
    // Invoke immediately while this click still carries user activation for permission request.
    void action().then(async result => {
      buttons.forEach(b => { b.disabled = false; });
      if (result.clearField) await refresh();
      out.textContent = result.text;
      out.dataset.kind = result.kind;
    }).catch(() => {
      buttons.forEach(b => { b.disabled = false; });
      out.textContent = "Provider action unavailable. Engine templates remain available.";
    });
  };
  save.addEventListener("click", run(() => saveProvider(store, permissions, { url: url.value, key: key.value.trim(), model: model.value, enabled: enabled.checked })));
  remove.addEventListener("click", run(() => deleteProvider(store)));
  test.addEventListener("click", run(() => requestProviderTest(message => chrome.runtime.sendMessage(message))));
  await refresh();
}
