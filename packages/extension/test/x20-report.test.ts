// X20: report semantics. Calm L0, readable unknowns, two-step flow, explanation (SignGuard and validated AI), Ledger hash line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportBuilder, ingestSession } from "@kelvara/core";
import { AI_STORAGE_KEY, DEFAULT_AI_URL } from "../src/intent/provider.js";
import { IntentFlow } from "../src/report/model.js";
import { hashLine, levelHeader } from "../src/report/page.js";
import { fallbackExplanation, readExplanation, validateAiSentences } from "../src/shared/explanation.js";
import { SW_BIND, SW_EXPLAIN, type WorkerVerdict } from "../src/shared/protocol.js";
import { validateReportView, type ReportView } from "../src/shared/report-view.js";
import { ExplainStore, explainReport, type ExplainDeps } from "../src/sw/explain.js";
import { fromReport } from "../src/sw/from-report.js";
import { analyze, manifestFixtures, sessionOf } from "../../core/test/rules-helpers.js";

class Node_ {
  tag = "";
  children: (Node_ | string)[] = [];
  attrs: Record<string, string> = {};
  textContent = "";
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...kids: (Node_ | string)[]) { this.children.push(...kids); }
  get text(): string { return this.children.map((c) => (typeof c === "string" ? c : c.text)).join("") || this.textContent; }
  all(): Node_[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
}
const fakeDom = () => vi.stubGlobal("document", { createElement: (tag: string) => Object.assign(new Node_(), { tag }) });
const tree = (els: unknown[]): Node_[] => (els as Node_[]).flatMap((e) => [e, ...e.all()]);
const hashesOf = (r: { session: { transactions: { messageHash: string }[] } }) => r.session.transactions.map((t) => t.messageHash);

async function mapped(dir: string, pick: (n: string[]) => boolean) {
  for (const f of manifestFixtures().filter((x) => x.path.includes(dir))) {
    const r = analyze(await sessionOf([f.base64]));
    if (pick(r.claims.map((c) => c.ruleId ?? ""))) {
      const m = fromReport(r, hashesOf(r as never));
      if (!m.ok) throw new Error(m.reason);
      return m;
    }
  }
  throw new Error(`no fixture in ${dir}`);
}
const verdictOf = (level: 0 | 1 | 2 | 3 | 4 | null, report: ReportView | null, over: Partial<WorkerVerdict> = {}): WorkerVerdict => ({ allow: false, hold: level !== null && level < 4, level, reason: report?.title ?? "r", report, ...over });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("level presentation", () => {
  it("L0 has no risk banner: a calm line with the strongest fact and a quiet L0 chip", async () => {
    fakeDom();
    const m = await mapped("/memo/", (n) => n.includes("fact.memo"));
    const nodes = tree(levelHeader(verdictOf(0, m.report), m.report));
    expect(nodes.some((n) => (n.attrs.class ?? "").includes("risk-banner"))).toBe(false);
    expect(nodes.find((n) => n.attrs.class === "calm-head")).toBeTruthy();
    const h1 = nodes.find((n) => n.tag === "h1")!;
    expect(h1.text).toMatch(/^No risks found /);
    expect(h1.attrs.id).toBe("title");
    const chip = nodes.find((n) => "data-kelvara-level" in n.attrs)!;
    expect(chip.attrs["data-kelvara-level"]).toBe("L0");
    expect(chip.text).toBe("L0");
    expect(nodes.filter((n) => "data-kelvara-level" in n.attrs)).toHaveLength(1);
  });
  it("L1 is a small notice line, L2 to L4 and blocked keep the coloured banner", async () => {
    fakeDom();
    const m = await mapped("/memo/", (n) => n.includes("fact.memo"));
    const l1 = tree(levelHeader(verdictOf(1, m.report), m.report));
    expect(l1.some((n) => n.attrs.class === "notice-line")).toBe(true);
    expect(l1.some((n) => (n.attrs.class ?? "").includes("risk-banner"))).toBe(false);
    expect(l1.find((n) => "data-kelvara-level" in n.attrs)!.text).toBe("L1 · Notice");
    for (const [level, text] of [[2, "L2 · Warning"], [3, "L3 · Critical"], [4, "L4 · Blocked"]] as const) {
      const n = tree(levelHeader(verdictOf(level, m.report), m.report));
      expect(n.some((x) => x.attrs.class === "risk-banner")).toBe(true);
      expect(n.find((x) => "data-kelvara-level" in x.attrs)!.text).toBe(text);
    }
    const blocked = tree(levelHeader(verdictOf(null, null, { hold: false }), null));
    expect(blocked.some((x) => x.attrs.class === "risk-banner")).toBe(true);
    expect(blocked.some((x) => x.text === "Blocked · analysis unavailable")).toBe(true);
  });
});

describe("what you actually authorize", () => {
  const base = async () => {
    const session = await ingestSession([{ base64: manifestFixtures().find((f) => f.path.includes("/memo/"))!.base64, kind: "wire" }]);
    return session;
  };
  it("names the program and says the effects are unknown; never a bare Unknown", async () => {
    const session = await base();
    const b = new ReportBuilder(session);
    const ix = session.transactions[0]!.instructions[0]!;
    const ev = b.addEvidence({ type: "instruction", source: "message", summary: "unknown instruction", transactionIndex: 0, instructionPath: [0], address: ix.programAddress, data: { programId: ix.programAddress, program: null, name: null, decoder: "none", args: null, accounts: [] } });
    b.addClaim({ kind: "Unknown", statement: "One instruction could not be named.", evidenceIds: [ev], level: "L1" });
    const built = b.build();
    const m = fromReport(built, hashesOf(built));
    if (!m.ok) throw new Error(m.reason);
    expect(m.report.authorizes).toMatch(/^Could not decode 1 instruction on [A-Za-z0-9 .…-]+; its effects are unknown\.$/);
    expect(m.report.authorizes).not.toMatch(/^Unknown/);
    expect(m.report.details!.instructions[0]).toMatchObject({ name: null, tx: 0, path: "0" });
  });
  it("hides the section when there is nothing to say", async () => {
    const session = await base();
    const built = new ReportBuilder(session).build();
    const m = fromReport(built, hashesOf(built));
    if (!m.ok) throw new Error(m.reason);
    expect(m.report.authorizes).toBeNull();
  });
  it("decoded facts keep the X19 text; instructions carry IDL names for step 2", async () => {
    const m = await mapped("/first-send/", (n) => n.includes("fact.sol_transfer"));
    expect(m.report.authorizes).toMatch(/^Sends [\d.]+ SOL to \w+\./);
    expect(m.report.authorizes).not.toContain("Could not decode");
    const names = m.report.details!.instructions.map((i) => `${i.program} · ${i.name}`);
    expect(names).toContain("System Program · transferSol");
    expect(m.report.details!.changes.join(" ")).toMatch(/Sends [\d.]+ SOL/);
    expect(validateReportView(m.report)).not.toBeNull();
    expect(validateReportView({ ...m.report, details: { instructions: [], changes: [], extra: 1 } })).toBeNull();
  });
});

describe("two-step flow", () => {
  it("Continue and Sign anyway are unreachable without a trusted Yes after the assessment is shown", () => {
    const f = new IntentFlow();
    expect(f.decisionControls).toBe(false);
    expect(f.confirm(true)).toBe(false); // frame not ready
    f.setWarmed();
    expect(f.confirm(true)).toBe(false); // assessment not shown yet
    f.setExplained();
    expect(f.confirm(false)).toBe(false); // scripted click
    expect(f.decisionControls).toBe(false);
    expect(f.confirm(true)).toBe(true);
    expect(f.step).toBe("details");
    expect(f.decisionControls).toBe(true);
  });
  it("Reject is available as soon as the frame is ready, before any explanation, and Yes never after the answer", () => {
    const f = new IntentFlow();
    expect(f.canReject).toBe(false);
    f.setWarmed();
    expect(f.canReject).toBe(true);
    expect(f.canConfirm).toBe(false);
    f.setExplained();
    f.close();
    expect(f.canConfirm).toBe(false);
    expect(f.confirm(true)).toBe(false);
    expect(f.decisionControls).toBe(false);
  });
});

describe("Ledger hash line", () => {
  it("quiet line with the full value in the text, title and accessible name, and data-kelvara-hash", () => {
    fakeDom();
    const hash = "7vdeAbCdEfGhJkLmNpQrStUvWxYz123456789ABCx8T";
    const nodes = tree([hashLine([hash])]);
    const code = nodes.find((n) => "data-kelvara-hash" in n.attrs)!;
    expect(code.text).toBe(hash);
    expect(code.attrs.title).toBe(hash);
    expect(code.attrs["aria-label"]).toBe(`Ledger hash ${hash}`);
    expect(nodes.find((n) => n.attrs.class === "ledger-label")!.text).toBe("Ledger hash");
    expect(nodes.some((n) => n.tag === "details" || n.tag === "summary")).toBe(false);
    expect(tree([hashLine([hash, hash])]).find((n) => n.attrs.class === "ledger-label")!.text).toBe("Ledger hashes");
  });
});

// ---------- explanation ----------

const claim = (id: string, text: string, level: "L0" | "L2" | null = "L2", rule: string | null = "token2022.permanent_delegate") => ({ id, kind: "Fact" as const, level, rule, title: "T", text, advice: null, evidenceIds: [], moreEvidence: 0 });
const view = (claims = [claim("c1", "The mint gives 7vdeAbCdEfGhJkLmNpQrStUvWxYz123456789ABCx8T a permanent delegate over 5000 tokens."), claim("c2", "Fact: sends 1 SOL.", "L0", "fact.sol_transfer")]): ReportView => ({
  title: "Warning: permanent delegate", summary: "The seller can pull tokens back.", simulation: "Your SOL balance changes by −1 SOL", authorizes: null, capabilities: [], preview: [], claims, evidence: [],
  messageHashes: ["11111111111111111111111111111111"], limited: false
});
const KEY = "test-only-auth-secret";
const provider = { url: DEFAULT_AI_URL, model: "gpt-4.1-mini", key: KEY, enabled: true };
const deps = (fetchFn: typeof fetch, stored: unknown = provider): ExplainDeps => ({ get: async () => ({ [AI_STORAGE_KEY]: stored }), fetch: fetchFn, permissions: { contains: async () => true }, timeoutMs: 500 });
const completion = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] }));

describe("explanation", () => {
  it("SignGuard explanation is the report's own text for the risk claims; routine L0 uses the summary", () => {
    const e = fallbackExplanation(view());
    expect(e.source).toBe("signguard");
    expect(e.sentences).toEqual([{ text: expect.stringContaining("permanent delegate"), claimIds: ["c1"] }]);
    const l0 = fallbackExplanation({ ...view([claim("c2", "x", "L0", "fact.sol_transfer")]), summary: "This transaction sends 1 SOL." });
    expect(l0.sentences[0]).toEqual({ text: "This transaction sends 1 SOL.", claimIds: ["c2"] });
  });

  it("validates provider output: at most 5 sentences of 240 characters, existing claim ids, no invented numbers or addresses", () => {
    const r = view();
    const ok = (s: unknown) => validateAiSentences({ sentences: s }, r);
    expect(ok([{ text: "The token creator keeps a permanent delegate over 5000 tokens.", claimIds: ["c1"] }])).toHaveLength(1);
    expect(ok([{ text: "The delegate is 7vdeAbCdEfGhJkLmNpQrStUvWxYz123456789ABCx8T.", claimIds: ["c1"] }])).toHaveLength(1);
    const bad: unknown[] = [
      [],
      Array.from({ length: 6 }, () => ({ text: "Fine.", claimIds: ["c1"] })),
      [{ text: "x".repeat(241), claimIds: ["c1"] }],
      [{ text: "No citation.", claimIds: [] }],
      [{ text: "Unknown id.", claimIds: ["nope"] }],
      [{ text: "It moves 9000 tokens.", claimIds: ["c1"] }],
      [{ text: "Sends to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin.", claimIds: ["c1"] }],
      [{ text: "Cites c2 but claims 5000 tokens.", claimIds: ["c2"] }],
      [{ text: "Fine.", claimIds: ["c1"], extra: 1 }]
    ];
    for (const s of bad) expect(ok(s), JSON.stringify(s).slice(0, 60)).toBeNull();
    expect(validateAiSentences({ sentences: [{ text: "Fine.", claimIds: ["c1"] }], more: 1 }, r)).toBeNull();
    expect(readExplanation({ source: "ai", sentences: [{ text: "Fine.", claimIds: ["c1"] }] })).toBeTruthy();
    expect(readExplanation({ source: "other", sentences: [] })).toBeNull();
  });

  it("with an enabled provider (loopback mock) a valid answer is labelled AI; the request carries only public facts", async () => {
    const r = view();
    const fetchFn = vi.fn<typeof fetch>(async (_u, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({ store: false, response_format: { json_schema: { name: "report_explanation", strict: true } } });
      const input = JSON.parse(body.messages[1].content);
      expect(Object.keys(input)).toEqual(["claims", "capabilities", "simulation"]);
      expect(input.claims[0]).toEqual({ id: "c1", level: "L2", statement: r.claims[0]!.text });
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      expect(init!.body).not.toContain(KEY);
      expect(init!.body).not.toContain(r.messageHashes[0]);
      return completion({ sentences: [{ text: "The token creator keeps a permanent delegate over 5000 tokens.", claimIds: ["c1"] }] });
    });
    const v = verdictOf(2, r);
    const e = await explainReport(v, deps(fetchFn));
    expect(e).toEqual({ source: "ai", sentences: [{ text: "The token creator keeps a permanent delegate over 5000 tokens.", claimIds: ["c1"] }] });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(v).toEqual(verdictOf(2, r)); // level, hold and controls untouched
  });

  it.each(["invalid", "refusal", "http-error", "redirect", "thrown", "no-provider", "disabled", "no-permission", "routine"])("%s falls back to SignGuard's explanation", async (mode) => {
    const r = view();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      if (mode === "invalid") return completion({ sentences: [{ text: "Invented 123456.", claimIds: ["c1"] }] });
      if (mode === "refusal") return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { refusal: "no", content: null } }] }));
      if (mode === "http-error") return new Response("x", { status: 500 });
      if (mode === "redirect") { const res = completion({ sentences: [{ text: "Fine.", claimIds: ["c1"] }] }); Object.defineProperty(res, "redirected", { value: true }); return res; }
      throw new Error(KEY);
    });
    const d = deps(fetchFn, mode === "no-provider" ? null : mode === "disabled" ? { ...provider, enabled: false } : provider);
    if (mode === "no-permission") d.permissions = { contains: async () => false };
    const v = mode === "routine" ? verdictOf(0, { ...r, intent: undefined, claims: [claim("c2", "x", "L0", "fact.sol_transfer")] }) : verdictOf(2, r);
    const e = await explainReport(v, d);
    expect(e.source).toBe("signguard");
    expect(JSON.stringify(e)).not.toContain(KEY);
    if (["no-provider", "disabled", "no-permission", "routine"].includes(mode)) expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a provider that never answers is cut at the timeout", async () => {
    vi.useFakeTimers();
    const p = explainReport(verdictOf(2, view()), deps(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(600);
    expect((await p).source).toBe("signguard");
  });
});

describe("explanation request from the report frame", () => {
  const ext = { id: "extid", reportUrl: "chrome-extension://extid/report.html" };
  const frame = { id: "extid", url: "chrome-extension://extid/report.html#secret123456", tab: { id: 7 } };
  const ID = "0123456789abcdef0123456789abcdef";
  const SECRET = "fedcba9876543210fedcba9876543210";
  const msg = { type: SW_EXPLAIN, id: ID, secret: SECRET };
  const setup = () => {
    const fetchFn = vi.fn<typeof fetch>(async () => completion({ sentences: [{ text: "The token creator keeps a permanent delegate over 5000 tokens.", claimIds: ["c1"] }] }));
    const store = new ExplainStore();
    store.start(ID, verdictOf(2, view()), deps(fetchFn));
    return { store, fetchFn };
  };

  it("answers only the bound frame: exact report.html, same tab, request id and secret; one model call per report", async () => {
    const { store, fetchFn } = setup();
    expect(await store.answer(msg, frame, ext)).toBeNull(); // not bound yet
    expect(store.bind(ID, SECRET, 7)).toBe(true);
    expect(store.bind(ID, "other0000000000000000000000000000", 7)).toBe(false); // bound once
    const bad: [unknown, typeof frame][] = [
      [{ ...msg, secret: "0".repeat(32) }, frame],
      [{ ...msg, id: "1".repeat(32) }, frame],
      [{ ...msg, extra: 1 }, frame],
      [msg, { ...frame, tab: { id: 8 } }],
      [msg, { ...frame, id: "other" }],
      [msg, { ...frame, url: "chrome-extension://extid/options.html" }],
      [msg, { ...frame, url: "chrome-extension://extid/report.html?x=1#s" }],
      [msg, { ...frame, url: "https://evil.example/report.html" }]
    ];
    for (const [m, s] of bad) expect(await store.answer(m, s, ext)).toBeNull();
    const first = await store.answer(msg, frame, ext);
    const second = await store.answer(msg, frame, ext);
    expect(first).toMatchObject({ source: "ai" });
    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledOnce();
    store.release(ID);
    expect(await store.answer(msg, frame, ext)).toBeNull();
  });

  it("no provider: the frame still gets SignGuard's explanation without any model call", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const store = new ExplainStore();
    store.start(ID, verdictOf(2, view()), deps(fetchFn, null));
    store.bind(ID, SECRET, 7);
    expect(await store.answer(msg, frame, ext)).toMatchObject({ source: "signguard" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("entries expire, and verdicts that are not held never start an explanation", async () => {
    let now = 1000;
    const store = new ExplainStore(() => now);
    const d = deps(vi.fn<typeof fetch>(), null);
    store.start(ID, verdictOf(4, view(), { hold: false }), d);
    expect(store.bind(ID, SECRET, 7)).toBe(false);
    store.start(ID, verdictOf(2, view()), d);
    store.bind(ID, SECRET, 7);
    now += 4 * 60_000;
    expect(await store.answer(msg, frame, ext)).toBeNull();
    expect(SW_BIND).toBe("kelvara-signguard/bind");
  });
});
