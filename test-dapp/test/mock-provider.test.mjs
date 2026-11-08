/* global fetch */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMock, MODES } from "../scripts/mock-provider.mjs";
import { selectIntent } from "../../packages/extension/src/intent/client.ts";

const reason = (id) => ({ id, text: `text ${id}`, claimIds: [], evidenceIds: [] });
const cand = (id, priority) => ({ id, kind: "unknown", priority, question: `Q ${id}?`, comparison: null, reasons: [reason(`${id}-r1`), reason(`${id}-r2`)] });
const context = { version: "kelvara-intent-v1", messageHashes: ["h1", "h2"], complex: true, fallbackId: "mid", historyNote: "n", candidates: [cand("low", 1), cand("mid", 3), cand("high", 5)] };
const KEY = "mock-test-key-not-real";
const perms = { contains: async () => true };
let mock;
beforeAll(async () => { mock = await startMock({ slowMs: 400 }); });
afterAll(() => mock.close());

const run = (mode, { path = "/v1/chat/completions", key = "", timeoutMs = 2000 } = {}) =>
  selectIntent(context, { url: `${mock.url}/mode/${mode}${path}`, model: "m", key, enabled: true }, { fetch, permissions: perms, timeoutMs });

describe("mock provider", () => {
  it.each(["/v1/chat/completions", "/v1/responses"])("select-highest yields an AI selection via %s", async (path) => {
    const r = await run("select-highest", { path });
    expect(r).toMatchObject({ source: "ai", status: "selected", selectedId: "high", reasonIds: ["high-r1", "high-r2"] });
  });
  it("fallback selection is accepted as ai/selected with the fallback candidate", async () => {
    expect(await run("fallback")).toMatchObject({ source: "ai", selectedId: "mid" });
  });
  it.each(["lower-priority", "wrong-binding", "invented-reason", "refusal", "malformed"])("%s falls back as invalid", async (mode) => {
    expect(await run(mode)).toMatchObject({ source: "engine", status: "invalid", selectedId: "mid" });
  });
  it.each(["http-500", "redirect", "oversize"])("%s falls back as unavailable", async (mode) => {
    expect(await run(mode)).toMatchObject({ source: "engine", status: "unavailable", selectedId: "mid" });
  });
  it("slow exceeds the client timeout", async () => {
    expect(await run("slow", { timeoutMs: 100 })).toMatchObject({ source: "engine", status: "unavailable" });
  });
  it("records the last request; Authorization only with a key; no extras sent", async () => {
    await run("select-highest");
    expect(mock.last().authorization).toBeNull();
    await run("select-highest", { key: KEY });
    const last = mock.last();
    expect(last.authorization).toBe(`Bearer ${KEY}`);
    expect(last.bodyText).not.toContain(KEY);
    expect(Object.keys(last.input).sort()).toEqual(["binding", "candidates", "fallbackId"]);
    expect(last.input.binding).toBe("h1:h2");
  });
  it("control endpoint sets the default mode; GET /last works; unknown mode rejected", async () => {
    expect((await fetch(`${mock.url}/mode/refusal`, { method: "POST" })).status).toBe(200);
    const r = await selectIntent(context, { url: `${mock.url}/v1/chat/completions`, model: "m", key: "", enabled: true }, { fetch, permissions: perms, timeoutMs: 2000 });
    expect(r.status).toBe("invalid");
    expect((await fetch(`${mock.url}/mode/nope`, { method: "POST" })).status).toBe(400);
    expect((await (await fetch(`${mock.url}/last`)).json()).mode).toBe("refusal");
    mock.setMode("select-highest");
  });
  it("exports every documented mode and binds loopback only", () => {
    expect(MODES).toHaveLength(11);
    expect(mock.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});
