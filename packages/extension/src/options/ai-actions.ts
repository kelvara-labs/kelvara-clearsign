import { AI_STORAGE_KEY, DEFAULT_AI_MODEL, DEFAULT_AI_URL, providerOrigin, readProvider, type Permissions } from "../intent/provider.js";
import { SW_TEST_PROVIDER, providerTestStatus } from "../shared/provider-test.js";
import type { Store, Outcome } from "./actions.js";
export interface ProviderForm { url: string; model: string; key: string; enabled: boolean }
const error = (text: string): Outcome => ({ text, kind: "err", clearField: false });
export async function loadProviderView(store: Store): Promise<{ loaded: boolean; url: string; model: string; enabled: boolean; hasKey: boolean }> {
  try {
    const p = readProvider((await store.get([AI_STORAGE_KEY]))[AI_STORAGE_KEY]);
    return { loaded: true, url: p?.url ?? DEFAULT_AI_URL, model: p?.model ?? DEFAULT_AI_MODEL, enabled: p?.enabled ?? false, hasKey: !!p?.key };
  } catch { return { loaded: false, url: DEFAULT_AI_URL, model: DEFAULT_AI_MODEL, enabled: false, hasKey: false }; }
}
/** Called synchronously from Save's click handler: request() precedes every await. */
export async function saveProvider(store: Store, permissions: Permissions, form: ProviderForm): Promise<Outcome> {
  const next = readProvider(form);
  if (!next) return error("Check the API URL, model and key. Use HTTPS, or HTTP on loopback only; no URL credentials, query or fragment.");
  try {
    const granted = await permissions.request({ origins: [providerOrigin(next.url)] });
    if (!granted) return error("Provider permission was refused. Engine templates remain available; settings were not saved.");
    const old = readProvider((await store.get([AI_STORAGE_KEY]))[AI_STORAGE_KEY]);
    // Re-enter the key for every endpoint change; never forward saved auth to a different endpoint.
    if (!next.key && old?.url === next.url) next.key = old.key;
    await store.set({ [AI_STORAGE_KEY]: next });
    return { text: "Provider saved. Engine rules and transaction bytes remain authoritative.", kind: "ok", clearField: true };
  } catch { return error("Provider settings could not be saved. Engine templates remain available. Reload to check saved settings."); }
}
export async function deleteProvider(store: Store): Promise<Outcome> {
  try {
    await store.remove(AI_STORAGE_KEY);
    return { text: "Provider and saved API key removed. Engine templates remain available.", kind: "ok", clearField: true };
  } catch { return error("Provider could not be removed; the key may still be saved. Reload and try again."); }
}
// The UI never reads the saved provider key for Test or performs provider network requests.
export async function requestProviderTest(send: (message: { type: string }) => Promise<unknown>): Promise<Outcome> {
  try {
    const status = providerTestStatus(await send({ type: SW_TEST_PROVIDER }));
    if (status === "ok") return { text: "Provider returned a valid structured selection. This test used no transaction data.", kind: "ok", clearField: false };
    if (status === "not-configured") return error("Save a provider before testing it.");
    return error("Provider test did not return a valid selection. Check permission, endpoint, model and authentication; engine templates remain available.");
  } catch { return error("Provider test unavailable. Engine templates remain available."); }
}
