import type { IntentContext } from "@kelvara/core";
import { AI_STORAGE_KEY, readProvider, type Permissions } from "../intent/provider.js";
import { selectIntent, AI_TIMEOUT_MS } from "../intent/client.js";
import { isProviderTestRequest, type ProviderTestResponse } from "../shared/provider-test.js";

// Explicit connection test only: no transaction, page text or chain facts.
const testContext: IntentContext = {
  version: "kelvara-intent-v1", messageHashes: [], complex: true, fallbackId: "provider-test", historyNote: "Provider connection test only.",
  candidates: [{ id: "provider-test", kind: "unknown", priority: 4, question: "Is this provider connection test intentional?", comparison: null,
    reasons: [{ id: "provider-test-reason", text: "This is a connection test, not a transaction or chain fact.", claimIds: [], evidenceIds: [] }] }]
};
export interface ProviderTestDeps {
  get(keys: string[]): Promise<Record<string, unknown>>;
  permissions: Pick<Permissions, "contains">;
  fetch: typeof fetch;
}
export async function testSavedProvider(deps: ProviderTestDeps): Promise<ProviderTestResponse> {
  try {
    const provider = readProvider((await deps.get([AI_STORAGE_KEY]))[AI_STORAGE_KEY]);
    if (!provider) return { status: "not-configured" };
    const result = await selectIntent(testContext, { ...provider, enabled: true }, { fetch: deps.fetch, permissions: deps.permissions, timeoutMs: AI_TIMEOUT_MS });
    return { status: result.source === "ai" ? "ok" : result.status === "invalid" ? "invalid" : "unavailable" };
  } catch { return { status: "unavailable" }; }
}
/** Authenticate Chrome's sender metadata before accessing settings or invoking the provider. */
export function handleProviderTest(
  message: unknown, sender: chrome.runtime.MessageSender,
  runtime: { id: string; optionsUrl: string }, deps: ProviderTestDeps
): Promise<ProviderTestResponse> | null {
  if (sender.id !== runtime.id || sender.url !== runtime.optionsUrl || (sender.frameId ?? 0) !== 0 || !isProviderTestRequest(message)) return null;
  return testSavedProvider(deps);
}
