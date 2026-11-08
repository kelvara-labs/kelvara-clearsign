import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestProviderTest } from "../src/options/ai-actions.js";
import { handleProviderTest, type ProviderTestDeps } from "../src/sw/provider-test.js";
import { SW_TEST_PROVIDER, isProviderTestRequest, providerTestStatus } from "../src/shared/provider-test.js";
const runtime = { id: "unit-extension", optionsUrl: "chrome-extension://unit-extension/options.html" };
const sender = { id: runtime.id, url: runtime.optionsUrl };
const message = { type: SW_TEST_PROVIDER };
const KEY = "UNIT_PROVIDER_SECRET_NEVER_RETURNED";
const URL = "https://provider.example/v1/chat/completions";
const selection = { binding: "", candidateId: "provider-test", reasonIds: ["provider-test-reason"] };
function dependencies(): ProviderTestDeps {
  return {
    get: vi.fn(async () => ({ aiProvider: { url: URL, key: KEY, model: "unit-model", enabled: false } })),
    permissions: { contains: vi.fn(async () => true) },
    fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(selection) } }] })))
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("worker-only saved provider test", () => {
  it("Options sends only the internal command, never typed/saved configuration or key", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const send = vi.fn<(message: { type: string }) => Promise<unknown>>(async () => ({ status: "ok" }));
    expect((await requestProviderTest(send)).kind).toBe("ok");
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
    expect(Object.keys(send.mock.calls[0]![0] ?? {})).toEqual(["type"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("authenticated Options test loads configuration in worker and returns only a bounded status", async () => {
    const deps = dependencies();
    expect(await handleProviderTest(message, sender, runtime, deps)).toEqual({ status: "ok" });
    expect(deps.get).toHaveBeenCalledExactlyOnceWith(["aiProvider"]);
    expect(deps.fetch).toHaveBeenCalledOnce();
    const init = vi.mocked(deps.fetch).mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(init.body).not.toContain(KEY);
  });
  it("accepts the Options page when opened as a tab (open_in_tab), as in production", async () => {
    const deps = dependencies();
    expect(await handleProviderTest(message, { ...sender, tab: { id: 1 }, frameId: 0 } as chrome.runtime.MessageSender, runtime, deps)).toEqual({ status: "ok" });
  });
  it.each([
    { id: "foreign-extension", url: runtime.optionsUrl },
    { url: runtime.optionsUrl },
    { id: runtime.id },
    { id: runtime.id, url: "https://site.example/options.html", tab: { id: 1 } },
    { id: runtime.id, url: runtime.optionsUrl, frameId: 3 },
    { id: runtime.id, url: "chrome-extension://unit-extension/report.html" },
    { id: runtime.id, url: "chrome-extension://unit-extension/popup.html" },
    { id: runtime.id, url: `${runtime.optionsUrl}?from=page` },
    { id: runtime.id, url: `${runtime.optionsUrl}#fragment` }
  ])("rejects foreign/page/tab sender before storage or network: %j", badSender => {
    const deps = dependencies();
    expect(handleProviderTest(message, badSender, runtime, deps)).toBeNull();
    expect(deps.get).not.toHaveBeenCalled();
    expect(deps.permissions.contains).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each([
    null, [], "test-provider", {}, { type: "other" },
    { ...message, key: KEY }, { ...message, provider: { url: URL, key: KEY } },
    { ...message, context: selection }, { ...message, sender }, { ...message, url: URL },
    Object.assign(Object.create({ type: SW_TEST_PROVIDER }), { payload: true })
  ])("rejects extra config/keys/context and malformed commands: %j", badMessage => {
    const deps = dependencies();
    expect(isProviderTestRequest(badMessage)).toBe(false);
    expect(handleProviderTest(badMessage, sender, runtime, deps)).toBeNull();
    expect(deps.get).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each(["storage", "provider-error", "bad-selection", "permission"])("%s cannot leak key, URL or raw provider body through worker response", async mode => {
    const deps = dependencies();
    if (mode === "storage") deps.get = vi.fn(async () => { throw new Error(`${KEY} ${URL}`); });
    if (mode === "provider-error") deps.fetch = vi.fn(async () => new Response(`${KEY} ${URL}`, { status: 400 }));
    if (mode === "bad-selection") deps.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ...selection, reasonIds: [KEY] }) } }] })));
    if (mode === "permission") deps.permissions.contains = vi.fn(async () => { throw new Error(`${KEY} ${URL}`); });
    const result = await handleProviderTest(message, sender, runtime, deps);
    expect(["unavailable", "invalid"]).toContain(result?.status);
    expect(Object.keys(result!)).toEqual(["status"]);
    const ui = await requestProviderTest(async () => result);
    expect(ui.kind).toBe("err");
    expect(JSON.stringify([result, ui])).not.toContain(KEY);
    expect(JSON.stringify([result, ui])).not.toContain(URL);
  });
  it.each([null, { status: KEY }, { status: "ok", text: KEY }, { status: "unavailable", providerBody: KEY }])("UI rejects arbitrary worker response fields/text: %j", async raw => {
    expect(providerTestStatus(raw)).toBeNull();
    const result = await requestProviderTest(async () => raw);
    expect(result.kind).toBe("err");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("UI catches runtime transport errors without exposing their text", async () => {
    const result = await requestProviderTest(async () => { throw new Error(`${KEY} ${URL}`); });
    expect(result.kind).toBe("err");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(URL);
  });
  it("production UI bundle excludes provider transport and worker-only test code; Helius probe remains", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new globalThis.URL("../src/ui.ts", import.meta.url))],
      bundle: true, write: false, platform: "browser", target: "chrome120", metafile: true,
      define: { "process.env.NODE_ENV": '"production"' }
    });
    const inputs = Object.keys(result.metafile!.inputs).join("\n");
    expect(inputs).not.toContain("src/intent/client.ts");
    expect(inputs).not.toContain("src/sw/provider-test.ts");
    expect(inputs).toContain("src/sw/probe.ts");
    const output = result.outputFiles[0]!.text;
    for (const providerTransport of ["response_format", "max_completion_tokens", "intent_selection", "Provider connection test only."]) expect(output).not.toContain(providerTransport);
  });
});
