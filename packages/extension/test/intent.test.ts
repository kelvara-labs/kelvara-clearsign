// Transaction facts come from the existing real Squads fixture through the core engine.
import { readFileSync } from "node:fs";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSession, buildIntentContext, ingestSession, type IntentContext, type RpcClient } from "@kelvara/core";
import { buildRegistry } from "../src/sw/registry.js";
import { AI_INPUT_MAX, AI_OUTPUT_MAX, selectIntent, selectionInput, type ClientDeps } from "../src/intent/client.js";
import { DEFAULT_AI_URL } from "../src/intent/provider.js";
import { templateIntent, validSelection, validateReportIntent } from "../src/intent/selection.js";
import { validateReportView } from "../src/shared/report-view.js";
import { fromReport } from "../src/sw/from-report.js";
import { buttonsFor } from "../src/report/model.js";
import { enhanceIntent } from "../src/intent/enhance.js";
import { poisonManifest, requestCase } from "../../core/test/address-helpers.js";
import { analyze, decoder } from "../../core/test/rules-helpers.js";
import { intentCard } from "../src/report/intent.js";
let context: IntentContext;
let routineContext: IntentContext;
let poisoningContext: IntentContext;
let reportView: NonNullable<ReturnType<typeof validateReportView>>;
const KEY = "test-only-auth-secret";
const provider = { url: DEFAULT_AI_URL, model: "gpt-4.1-mini", key: KEY, enabled: true };
const allowed = { contains: vi.fn(async () => true) };
const response = (value: unknown) => new Response(JSON.stringify(value));
const success = (selection: unknown) => response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(selection) } }] });
const selection = () => {
  const c = context.candidates.find(c => c.id === context.fallbackId)!;
  return { binding: context.messageHashes.join(":"), candidateId: c.id, reasonIds: c.reasons.map(r => r.id) };
};
const deps = (fn: typeof fetch): ClientDeps => ({ fetch: fn, permissions: allowed, timeoutMs: 1000 });
beforeAll(async () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/tx/manifest.json", import.meta.url), "utf8")) as { fixtures: { path: string; e2e?: string }[] };
  const entry = manifest.fixtures.find(x => x.e2e === "l3-batch")!;
  const tx = JSON.parse(readFileSync(new URL(`../../../fixtures/${entry.path}`, import.meta.url), "utf8")) as { transaction: string };
  const session = await ingestSession([{ base64: tx.transaction, kind: "wire" }]);
  const reg = buildRegistry();
  const rpc: RpcClient = { network: "localnet", endpoint: "http://localhost:8899", stats: { requests: 0, retries: 0, cacheHits: 0, rateLimited: 0 }, call: async () => { throw new Error("offline fixture test"); }, clearCache() {} };
  const result = await analyzeSession(session, { decoder: reg.decoder, squadsAccounts: reg.squadsAccounts, authorityMaps: reg.authorityMaps, rpc });
  context = result.intentContext;
  expect(context.complex).toBe(true);
  const mapped = fromReport(result.report, context.messageHashes);
  if (!mapped.ok) throw new Error(mapped.reason);
  reportView = mapped.report;
  const poisonCase = poisonManifest.cases.find(c => c.kind === "poisoning" && c.network === "devnet")!;
  const replayed = await requestCase(poisonCase);
  poisoningContext = buildIntentContext({ ...replayed, report: analyze(replayed.session, replayed.state), decoded: decoder.decodeSession(replayed.session) });
  // Find an actual routine transfer among the recorded first-send transactions: some also
  // contain unsupported instructions and correctly remain complex.
  for (const entry of manifest.fixtures.filter(f => f.path.includes("first-send/"))) {
    const tx = JSON.parse(readFileSync(new URL(`../../../fixtures/${entry.path}`, import.meta.url), "utf8")) as { transaction: string };
    const session = await ingestSession([{ base64: tx.transaction, kind: "wire" }]);
    const state = { wallet: session.transactions[0]!.signatures[0]!.signer };
    const result = await analyzeSession(session, { decoder, state });
    if (!result.intentContext.complex) { routineContext = result.intentContext; break; }
  }
  expect(routineContext.complex).toBe(false);
  expect(poisoningContext.candidates.find(c => c.id === poisoningContext.fallbackId)?.comparison).toBeTruthy();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("engine-bound selection", () => {
  it("accepts only IDs in the same binding, primary reason and priority at least fallback", () => {
    const good = selection();
    expect(validSelection(good, context)).toEqual(good);
    for (const bad of [{ ...good, binding: "different-hash" }, { ...good, candidateId: "invented" }, { ...good, reasonIds: [] }, { ...good, reasonIds: ["invented"] }, { ...good, reasonIds: [good.reasonIds[0], good.reasonIds[0]] }, { ...good, prose: "safe" }]) expect(validSelection(bad, context)).toBeNull();
    const lower = structuredClone(context);
    const c = lower.candidates.find(c => c.id === lower.fallbackId)!;
    c.priority = 4;
    lower.candidates.push({ ...structuredClone(c), id: "low-priority-test", priority: 0 });
    expect(validSelection({ ...good, candidateId: "low-priority-test" }, lower)).toBeNull();
    if (good.reasonIds.length > 1) expect(validSelection({ ...good, reasonIds: good.reasonIds.slice(1) }, context)).toBeNull();
  });
  it("validates optional report payload with exact keys, source/status and original hashes", () => {
    const intent = templateIntent(context);
    expect(validateReportIntent(intent, context.messageHashes)).toEqual(intent);
    expect(validateReportView({ ...reportView, intent })).toBeTruthy();
    expect(validateReportView({ ...reportView, intent: { ...intent, extra: true } })).toBeNull();
    expect(validateReportView({ ...reportView, messageHashes: [], intent })).toBeNull();
    expect(validateReportIntent({ ...intent, source: "ai" }, context.messageHashes)).toBeNull();
    expect(validateReportIntent({ ...intent, source: "engine", status: "selected" }, context.messageHashes)).toBeNull();
    expect(validateReportView(reportView)).toBeTruthy(); // old reports still valid
  });
  it("Chat structured output whitelists public candidate facts; keys remain only in auth", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(DEFAULT_AI_URL);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      expect(init!.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({ store: false, model: provider.model, max_completion_tokens: 512, response_format: { type: "json_schema", json_schema: { name: "intent_selection", strict: true, schema: { additionalProperties: false } } } });
      const input = JSON.parse(body.messages[1].content);
      expect(Object.keys(input)).toEqual(["binding", "fallbackId", "candidates"]);
      expect(Object.keys(input.candidates[0])).toEqual(["id", "priority", "question", "reasons"]);
      expect(Object.keys(input.candidates[0].reasons[0])).toEqual(["id", "text"]);
      expect(init!.body).not.toContain(KEY);
      return success(selection());
    });
    const result = await selectIntent(context, provider, deps(fetchFn));
    expect(result).toMatchObject({ source: "ai", status: "selected", selectedId: context.fallbackId });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("supports explicit Responses endpoint text.format and local unauthenticated inference", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.text.format).toMatchObject({ type: "json_schema", name: "intent_selection", strict: true });
      expect(body.max_output_tokens).toBe(512);
      expect(init!.headers).not.toHaveProperty("Authorization");
      return response({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(selection()) }] }] });
    });
    expect((await selectIntent(context, { ...provider, url: "http://localhost:11434/v1/responses", key: "" }, deps(fetchFn))).source).toBe("ai");
  });
  it("routine and disabled/missing provider make no network or permission calls", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect((await selectIntent(routineContext, provider, deps(fetchFn))).status).toBe("template");
    expect((await selectIntent(context, null, deps(fetchFn))).status).toBe("not-configured");
    expect((await selectIntent(context, { ...provider, enabled: false }, deps(fetchFn))).status).toBe("not-configured");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(allowed.contains).not.toHaveBeenCalled();
  });
  it.each(["refusal", "unsupported", "malformed", "cross-hash", "wrong-id", "redirect", "output-limit", "truncated", "thrown"])("%s uses template, never logs or includes raw provider body", async mode => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const fetchFn = vi.fn<typeof fetch>(async () => {
      if (mode === "refusal") return response({ choices: [{ finish_reason: "stop", message: { refusal: KEY, content: null } }] });
      if (mode === "unsupported") return new Response(JSON.stringify({ error: { message: `response_format unsupported ${KEY}` } }), { status: 400 });
      if (mode === "malformed") return response({ choices: [{ finish_reason: "stop", message: { content: KEY } }] });
      if (mode === "cross-hash") return success({ ...selection(), binding: "changed" });
      if (mode === "wrong-id") return success({ ...selection(), reasonIds: [KEY] });
      if (mode === "redirect") { const res = success(selection()); Object.defineProperty(res, "redirected", { value: true }); return res; }
      if (mode === "output-limit") return new Response("x".repeat(AI_OUTPUT_MAX + 1));
      if (mode === "truncated") return response({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(selection()) } }] });
      throw new Error(KEY);
    });
    const result = await selectIntent(context, provider, deps(fetchFn));
    expect(result.source).toBe("engine");
    expect(result.selectedId).toBe(context.fallbackId);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fetchFn).toHaveBeenCalledOnce(); // unsupported schemas never retried without validation
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore(); error.mockRestore();
  });
  it("provider selection of lower-priority metadata falls back to the engine primary question", async () => {
    // Explicit adversarial metadata mutation of a real context; no invented chain fact.
    const changed = structuredClone(context);
    const primary = changed.candidates.find(c => c.id === changed.fallbackId)!;
    primary.priority = 4;
    const lower = { ...structuredClone(primary), id: "adversarial-low-priority", priority: 0 as const, reasons: primary.reasons.map(r => ({ ...r, id: `${r.id}-lower` })) };
    changed.candidates.push(lower);
    const fetchFn = vi.fn<typeof fetch>(async () => success({ binding: changed.messageHashes.join(":"), candidateId: lower.id, reasonIds: lower.reasons.map(r => r.id) }));
    const result = await selectIntent(changed, provider, deps(fetchFn));
    expect(result).toMatchObject({ source: "engine", status: "invalid", selectedId: changed.fallbackId });
  });
  it("permission denial, unavailable API and oversized input fall back before fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const contains of [async () => false, async () => { throw new Error(KEY); }]) {
      expect((await selectIntent(context, provider, { ...deps(fetchFn), permissions: { contains } })).status).toBe("unavailable");
    }
    const large = structuredClone(context);
    large.candidates = Array.from({ length: 8 }, () => { const c = structuredClone(context.candidates[0]!); c.question = "x".repeat(300); c.reasons = Array.from({ length: 6 }, () => ({ ...c.reasons[0]!, text: "x".repeat(600) })); return c; });
    expect(new TextEncoder().encode(selectionInput(large)).length).toBeGreaterThan(AI_INPUT_MAX);
    expect((await selectIntent(large, provider, deps(fetchFn))).status).toBe("unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("timeout bounds a provider which ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const result = selectIntent(context, provider, { ...deps(fetchFn), timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).status).toBe("unavailable");
    expect((fetchFn.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
  });
  it("AI selection leaves every decision field and L4 controls unchanged", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => success(selection()));
    for (const level of [0, 1, 2, 3, 4] as const) {
      const before = { allow: false, hold: level !== 4, level, reason: reportView.title, report: { ...reportView, intent: templateIntent(context) } };
      const after = await enhanceIntent(before, { get: async () => ({ aiProvider: provider }), fetch: fetchFn, permissions: allowed, timeoutMs: 1000 });
      expect(buttonsFor(after)).toEqual(buttonsFor(before));
      expect(after.report!.messageHashes).toEqual(context.messageHashes);
      expect(after.level).toBe(before.level);
      expect(after.allow).toBe(false);
      if (level === 4) expect(buttonsFor(after).signAnyway).toBeNull();
    }
  });
  it("enhancement storage failure retains deterministic report and never calls the provider", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const before = { allow: false, hold: true, level: 3 as const, reason: reportView.title, report: { ...reportView, intent: templateIntent(context) } };
    const after = await enhanceIntent(before, { get: async () => { throw new Error(KEY); }, fetch: fetchFn, permissions: allowed });
    expect(after.report?.intent?.status).toBe("unavailable");
    expect(after).toEqual({ ...before, report: { ...before.report, intent: templateIntent(context, "unavailable") } });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify(after)).not.toContain(KEY);
  });
});
class Element extends EventTarget {
  tag = "";
  children: Element[] = [];
  textContent = "";
  attrs: Record<string, string> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...kids: Element[]) { this.children.push(...kids); }
}
it("correction choices are bounded with no text input and cannot change selection or hashes", () => {
  const elements: Element[] = [];
  vi.stubGlobal("document", { createElement: (tag: string) => { const e = new Element(); e.tag = tag; elements.push(e); return e; } });
  const intent = templateIntent(context);
  const before = structuredClone(intent);
  intentCard(intent);
  const choices = elements.filter(e => Object.hasOwn(e.attrs, "data-intent-choice"));
  expect(choices).toHaveLength(4);
  expect(elements.some(e => ["input", "textarea"].includes(e.tag))).toBe(false);
  choices[0]!.dispatchEvent(new Event("click"));
  expect(intent).toEqual(before);
  expect(elements.find(e => Object.hasOwn(e.attrs, "data-intent-feedback"))?.textContent).toContain("fresh report");
});

it("real recorded poisoning comparison displays full addresses and matched positions; correction only blocks", () => {
  const elements: Element[] = [];
  vi.stubGlobal("document", { createElement: (tag: string) => { const e = new Element(); e.tag = tag; elements.push(e); return e; } });
  const intent = templateIntent(poisoningContext);
  const before = structuredClone(intent);
  const block = vi.fn();
  intentCard(intent, block);
  const c = poisoningContext.candidates.find(c => c.id === poisoningContext.fallbackId)!.comparison!;
  const codes = elements.filter(e => e.tag === "code");
  expect(codes.map(code => code.children.map(e => e.textContent).join(""))).toEqual([c.proposed, c.previous]);
  expect(elements.filter(e => e.tag === "mark")).toHaveLength(2 * (c.prefix + c.suffix));
  expect(elements.find(e => Object.hasOwn(e.attrs, "data-intent-compare"))).toBeTruthy();
  elements.find(e => Object.hasOwn(e.attrs, "data-intent-cancel"))!.dispatchEvent(new Event("click"));
  expect(block).toHaveBeenCalledOnce();
  expect(intent).toEqual(before);
});
