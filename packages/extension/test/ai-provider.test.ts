import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_URL, providerOrigin, providerUrl, readProvider, type Permissions } from "../src/intent/provider.js";
import { deleteProvider, loadProviderView, saveProvider, testProvider } from "../src/options/ai-actions.js";
import type { Store } from "../src/options/actions.js";
const KEY = "unit-test-only-secret";
const provider = { url: DEFAULT_AI_URL, model: "gpt-4.1-mini", key: KEY, enabled: true };
function memory(raw: Record<string, unknown> = {}) {
  const data = structuredClone(raw);
  return { data, get: vi.fn(async () => data), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }), remove: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === "string" ? [keys] : keys) delete data[key]; }) };
}
const permissions = (): Permissions => ({ request: vi.fn(async () => true), contains: vi.fn(async () => true) });
describe("provider configuration", () => {
  it.each([
    ["https://api.openai.com", DEFAULT_AI_URL], ["https://provider.example/v1/", "https://provider.example/v1/chat/completions"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"], ["http://127.0.0.1:8080", "http://127.0.0.1:8080/v1/chat/completions"],
    ["http://[::1]:8080/v1/responses", "http://[::1]:8080/v1/responses"], ["https://custom.example/proxy/responses", "https://custom.example/proxy/responses"]
  ])("normalizes %s", (url, expected) => expect(providerUrl(url)).toBe(expected));
  it.each(["http://remote.example/v1", "ftp://localhost/v1", "data:text/plain,key", "https://user:secret@remote.example", "https://remote.example?key=x", "https://remote.example#x", "https://remote.example?", "https://remote.example#", "https://*.example/v1", "javascript:alert(1)"])("rejects unsafe URL %s", url => expect(providerUrl(url)).toBeNull());
  it("accepts user-entered models and optional local keys; bounds key/model", () => {
    expect(readProvider({ ...provider, model: "local/my-model:latest", key: "" })?.model).toBe("local/my-model:latest");
    for (const invalid of [{ model: "" }, { model: "x".repeat(161) }, { key: "bad\r\nheader" }, { key: "x".repeat(4097) }, { enabled: "yes" }, { extra: true }]) expect(readProvider({ ...provider, ...invalid })).toBeNull();
  });
  it("asks only the configured host synchronously from Save, preserves Helius and never echoes key", async () => {
    const store = memory({ heliusApiKey: "helius-kept", network: "devnet" });
    const perms = permissions();
    const promise = saveProvider(store, perms, { ...provider, url: "https://inference.example:8443/v1" });
    expect(perms.request).toHaveBeenCalledExactlyOnceWith({ origins: ["https://inference.example:8443/*"] });
    const result = await promise;
    expect(result.kind).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(store.data).toMatchObject({ heliusApiKey: "helius-kept", network: "devnet", aiProvider: { url: "https://inference.example:8443/v1/chat/completions", key: KEY } });
    expect(providerOrigin("http://127.0.0.1:11434/v1/chat/completions")).toBe("http://127.0.0.1:11434/*");
  });
  it("keeps auth only for identical endpoint; changed host/path requires key re-entry", async () => {
    const store = memory({ aiProvider: provider });
    await saveProvider(store, permissions(), { ...provider, key: "" });
    expect(store.data.aiProvider).toMatchObject({ key: KEY });
    await saveProvider(store, permissions(), { ...provider, url: "https://other.example/v1", key: "" });
    expect(store.data.aiProvider).toMatchObject({ key: "" });
    await saveProvider(store, permissions(), { ...provider, key: KEY });
    await saveProvider(store, permissions(), { ...provider, url: "https://api.openai.com/v1/responses", key: "" });
    expect(store.data.aiProvider).toMatchObject({ key: "" });
  });
  it("permission refusal/unavailable cannot save; invalid input never asks", async () => {
    const store = memory();
    const p = permissions();
    p.request = vi.fn(async () => false);
    expect((await saveProvider(store, p, provider)).kind).toBe("err");
    expect(store.set).not.toHaveBeenCalled();
    p.request = vi.fn(async () => { throw new Error(KEY); });
    expect(JSON.stringify(await saveProvider(store, p, provider))).not.toContain(KEY);
    expect(store.set).not.toHaveBeenCalled();
    await saveProvider(store, p, { ...provider, url: "http://unsafe.example" });
    expect(p.request).toHaveBeenCalledOnce();
  });
  it("load exposes status but never key, storage failure never defaults over saved settings", async () => {
    const view = await loadProviderView(memory({ aiProvider: provider }));
    expect(view).toMatchObject({ loaded: true, hasKey: true, url: DEFAULT_AI_URL });
    expect(JSON.stringify(view)).not.toContain(KEY);
    const store: Store = { get: async () => { throw new Error(KEY); }, set: vi.fn(), remove: vi.fn() };
    expect((await loadProviderView(store)).loaded).toBe(false);
    expect((await saveProvider(store, permissions(), provider)).kind).toBe("err");
    expect(store.set).not.toHaveBeenCalled();
  });
  it("save/delete failures never claim success or leak errors; delete removes provider only", async () => {
    const store = memory({ aiProvider: provider, heliusApiKey: "kept" });
    store.set.mockRejectedValueOnce(new Error(KEY));
    expect((await saveProvider(store, permissions(), provider)).kind).toBe("err");
    store.remove.mockRejectedValueOnce(new Error(KEY));
    const failed = await deleteProvider(store);
    expect(failed.kind).toBe("err");
    expect(JSON.stringify(failed)).not.toContain(KEY);
    expect((await deleteProvider(store)).kind).toBe("ok");
    expect(store.data).toEqual({ heliusApiKey: "kept" });
  });
  it("provider test uses a labeled connection test and validates structured selection", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const input = JSON.parse(body.messages[1].content);
      expect(input.candidates[0].question).toContain("connection test");
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ binding: "", candidateId: "provider-test", reasonIds: ["provider-test-reason"] }) } }] }));
    });
    expect((await testProvider(memory({ aiProvider: provider }), permissions(), fetchFn)).kind).toBe("ok");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("all three provider fields initially live inside collapsed details, including reload logic", () => {
    const html = readFileSync(new URL("../static/options.html", import.meta.url), "utf8");
    const details = html.match(/<details id="ai-provider"[^>]*>([\s\S]*?)<\/details>/)!;
    expect(details[0]).not.toMatch(/<details[^>]*\bopen\b/);
    for (const id of ["ai-url", "ai-key", "ai-model"]) expect(details[1]).toContain(`id="${id}"`);
    expect(details[1]).toMatch(/id="ai-key" type="password"/);
    const source = readFileSync(new URL("../src/options/ai-page.ts", import.meta.url), "utf8");
    expect(source).toContain('details.open = false');
    expect(source).toContain('key.value = ""');
  });
});
