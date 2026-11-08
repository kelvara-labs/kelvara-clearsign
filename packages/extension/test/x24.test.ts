// X24: token names with the mint on hover, net balances for the user, one Assessment heading, Copy raw, no overflow.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReportBuilder, buildIntentContext, ingestSession, readTokenMeta, reportDigest, type Report, type Session } from "@kelvara/core";
import { copyRawButton, detailsStep } from "../src/report/page.js";
import { assessmentCard } from "../src/report/intent.js";
import { withTokens } from "../src/report/tokens.js";
import { validateAiSentences } from "../src/shared/explanation.js";
import { validateReportView, type ReportView } from "../src/shared/report-view.js";
import { fromReport } from "../src/sw/from-report.js";
import { messageHashes, type Sha256 } from "../src/sw/policy.js";
import { rawInstructions } from "../src/sw/raw-instruction.js";
import { relabelIntent } from "../src/sw/tokens.js";
import { analyze, decoder, json, manifestFixtures, replay, sessionFromRuntime, sessionOf, type Recording } from "../../core/test/rules-helpers.js";
import { relabel, tokenAmountText, tokenLabels, tokenMetas, reportMints } from "../src/sw/tokens.js";

const sha: Sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/tx/drift-replay");
const ATTACK = "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const WALLET = "B73ttuVCWzLmTHr5D2MGxMGYVzL4zj8MmSPLvqE8d9qV";
const POOL = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const TOKEN_ACCT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let session: Session;
let hashes: string[];
beforeAll(async () => {
  const tx = (JSON.parse(readFileSync(path.join(dir, `${ATTACK}.json`), "utf8")) as { transaction: string }).transaction;
  session = await ingestSession([{ base64: tx, kind: "wire" as const, label: "swap" }]);
  hashes = await messageHashes([tx], sha);
});

/** Hand-built report shaped like E26's: token evidence {mint, symbol, name, decimals, source} plus the simulation. USDC -> SOL. */
function swapReport(opts: { tokenMeta?: boolean } = { tokenMeta: true }): Report {
  const b = new ReportBuilder(session);
  const meta = opts.tokenMeta !== false;
  const ev = (type: "derivation" | "simulation" | "instruction", data: unknown, summary: string, extra: object = {}) => b.addEvidence({ type, source: "message", summary, transactionIndex: 0, data, ...extra } as never);
  const payer = ev("derivation", { feePayer: WALLET }, "fee payer");
  const toks = meta ? [ev("derivation", { kind: "token", mint: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, source: "helius-das" }, "token USDC"), ev("derivation", { kind: "token", mint: WSOL, symbol: "SOL", name: "Wrapped SOL", decimals: 9, source: "helius-das" }, "token wSOL")] : [];
  const sim = ev("simulation", {
    solChanges: [{ address: WALLET, delta: "258554337" }, { address: POOL, delta: "-258554337" }],
    tokenChanges: [
      { owner: WALLET, mint: USDC, delta: "-23180052", decimals: 6 },
      { owner: POOL, mint: USDC, delta: "23180052", decimals: 6 },
      { owner: WALLET, mint: WSOL, delta: "2039280", decimals: 9 },
      { owner: WALLET, mint: WSOL, delta: "-2039280", decimals: 9 }
    ],
    stateChanges: []
  }, "simulation");
  const ix = ev("instruction", { programId: TOKEN_ACCT, name: "transferChecked", args: { amount: "23180052", decimals: 6 }, accounts: [{ name: "mint", address: USDC }, { name: "destination", address: POOL }] }, "transferChecked", { instructionPath: [0], address: TOKEN_ACCT });
  const net = ev("derivation", { baseFeeLamports: "5000" }, "network fee");
  const prio = ev("derivation", { maxPriorityFeeLamports: "4251" }, "priority fee");
  b.addClaim({ kind: "Fact", statement: `Transaction 0 sends 23180052 of token mint ${USDC} from token account ${WALLET} to ${POOL} (owner of token account ${TOKEN_ACCT}).`, evidenceIds: [ix, ...toks], level: "L0", ruleId: "fact.token_transfer" });
  b.addClaim({ kind: "Fact", statement: "Transaction 0 pays a network fee.", evidenceIds: [net], level: "L0", ruleId: "fact.network_fee" });
  b.addClaim({ kind: "Fact", statement: "Transaction 0 sets a priority fee.", evidenceIds: [prio], level: "L0", ruleId: "fact.priority_fee" });
  b.addClaim({ kind: "Fact", statement: "No permission changes.", evidenceIds: [payer, sim], level: "L0", ruleId: "fact.no_permission_change" });
  return b.build();
}
const ok = (r: Report) => {
  const m = fromReport(r, hashes);
  if (!m.ok) throw new Error(m.reason);
  return m;
};

const recording = json<Recording>("packages/core/test/fixtures/tokens/jupiter.json");
const jupiter = manifestFixtures().filter((f) => f.path.includes("/jupiter-v6/"));
/** The recorded real Jupiter swaps analyzed with E26's token metadata replayed from real Helius responses. */
async function realSwap(i: number) {
  const f = jupiter[i]!;
  const sess = f.loaded ? await sessionFromRuntime(f.base64, f.loaded) : await sessionOf([f.base64]);
  const { rpc, reader } = replay(recording);
  const m = await readTokenMeta(rpc, reader, sess, decoder.decodeSession(sess));
  const state = { tokens: m.tokens, tokenAccountMints: m.tokenAccountMints };
  const report = analyze(sess, state);
  const hs = report.session.transactions.map((t) => t.messageHash);
  const mapped = fromReport(report, hs);
  if (!mapped.ok) throw new Error(mapped.reason);
  const context = relabelIntent(buildIntentContext({ session: sess, state, report, decoded: decoder.decodeSession(sess), decoder }), report);
  return { report, view: mapped.report, context };
}
const JUPUSD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";

describe("real E26 output on the recorded Jupiter swaps", () => {
  it("JupUSD -> USDC: symbols only, the mint on hover, no short tags or developer words", async () => {
    const { view, context } = await realSwap(0);
    for (const text of [view.summary, view.authorizes!, ...view.claims.map((c) => c.text), ...context.candidates.flatMap((c) => [c.question, ...c.reasons.map((r) => r.text)])]) {
      expect(text).not.toMatch(/\(Jupr…5USD\)|\(EPjF…Dt1v\)|base units of token mint|token mint/);
    }
    expect(view.summary).toBe("This transaction swaps 5.77101 JupUSD for 5.762509 USDC.");
    expect(view.authorizes).toContain("Swap on Jupiter: you give up to 5.77101 JupUSD and get at least 5.762509 USDC");
    expect(context.candidates.find((c) => c.kind === "swap")!.question).toBe("Did you intend to swap up to 5.77101 JupUSD for at least 5.762509 USDC?");
    expect(view.tokens).toEqual([{ mint: JUPUSD, label: "JupUSD" }, { mint: USDC, label: "USDC" }]);
    expect(validateReportView(view)).not.toBeNull();
  });
  it("two different tokens that share a symbol keep their short mint tags", async () => {
    const { report } = await realSwap(1);
    const bent = structuredClone(report) as Report;
    for (const e of bent.evidence) if ((e.data as { symbol?: string } | null)?.symbol === "ETH") (e.data as { symbol: string }).symbol = "BTC";
    for (const c of bent.claims) c.statement = c.statement.split("ETH (CXWN…pump)").join("BTC (CXWN…pump)");
    const fixed = { ...bent, digest: reportDigest(bent) } as Report;
    const m = fromReport(fixed, fixed.session.transactions.map((t) => t.messageHash));
    if (!m.ok) throw new Error(m.reason);
    expect(m.report.summary).toContain("BTC (C5xp…pump)");
    expect(m.report.summary).toContain("BTC (CXWN…pump)");
    expect(m.report.tokens!.map((t) => t.label).sort()).toEqual(["BTC (C5xp…pump)", "BTC (CXWN…pump)"]);
  });
  it("wrapped SOL stays 'SOL (wrapped)' and links its mint", async () => {
    const { view } = await realSwap(2);
    expect(view.authorizes).toContain("SOL (wrapped)");
    expect(view.tokens).toEqual([{ mint: WSOL, label: "SOL (wrapped)" }]);
  });
  it("a Velocity program call reads in plain words", async () => {
    const dirV = new URL("../../core/test/fixtures/velocity/", import.meta.url);
    const name = (await import("node:fs")).readdirSync(dirV).sort()[0]!;
    const fx = JSON.parse(readFileSync(new URL(name, dirV), "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
    const sess = await sessionFromRuntime(fx.transaction, fx.meta.loadedAddresses ?? { writable: [], readonly: [] });
    const r = analyze(sess);
    const m = fromReport(r, r.session.transactions.map((t) => t.messageHash));
    if (!m.ok) throw new Error(m.reason);
    expect(m.report.authorizes).toMatch(/Velocity · [A-Z]/);
    expect(m.report.authorizes).toContain("Verifies a signature (no funds moved)");
    expect(m.report.authorizes).not.toMatch(/\d+-byte|Ed25519/);
    expect(m.report.summary).not.toMatch(/Verifies/);
    expect(m.report.authorizes).not.toMatch(/token mint|intent template|decoded instruction|program id/i);
  });
});

describe("token names from evidence", () => {
  it("labels come from the evidence, with no hard-coded map", () => {
    const r = swapReport();
    const metas = tokenMetas(r);
    expect([...metas.values()].map((m) => m.symbol)).toEqual(["USDC", "SOL"]);
    const labels = tokenLabels(reportMints(r, metas), metas);
    expect(labels.get(USDC)).toBe("USDC");
    expect(labels.get(WSOL)).toBe("SOL (wrapped)");
    expect(relabel(`send ${USDC}`, labels)).toBe("send USDC");
    expect(readFileSync(new URL("../src/sw/from-report.ts", import.meta.url), "utf8")).not.toContain("KNOWN_MINTS");
  });
  it("without metadata: short mint label and raw units named base units", () => {
    const r = swapReport({ tokenMeta: false });
    const metas = tokenMetas(r);
    const labels = tokenLabels(reportMints(r, metas), metas);
    expect(labels.get(USDC)).toBe("token EPjF…Dt1v");
    expect(tokenAmountText("23180052", USDC, metas, labels)).toBe("23180052 base units of token EPjF…Dt1v");
    const m = ok(r);
    expect(m.report.authorizes).toContain("Sends 23.180052 token EPjF…Dt1v to ");
    expect(m.report.tokens).toEqual(expect.arrayContaining([{ mint: USDC, label: "token EPjF…Dt1v" }]));
  });
});

describe("Jupiter-style USDC -> SOL report", () => {
  it("authorize text names the token, amounts are human, no raw mint", () => {
    const m = ok(swapReport());
    expect(m.report.authorizes).toContain(`Sends 23.180052 USDC to ${POOL}`);
    expect(m.report.authorizes).not.toContain(USDC);
    expect(m.report.tokens).toEqual(expect.arrayContaining([{ mint: USDC, label: "USDC" }]));
    expect(validateReportView(m.report)).not.toBeNull();
    const claim = m.report.claims.find((c) => c.rule === "fact.token_transfer")!;
    expect(claim.text).toContain("23.180052 USDC");
    expect(claim.text).not.toContain(USDC);
  });
  it("simulation: net totals for the user, hops dropped, fees quiet, other owners collapsed", () => {
    const d = ok(swapReport()).report.details!;
    expect(d.balances).toEqual([
      "You send · −23.180052 USDC",
      "You receive · +0.258554337 SOL (after fees)",
      "Fees · 0.000005 SOL network + up to 0.000004251 SOL priority"
    ]);
    expect([...d.other!].sort()).toEqual(["SQDS…2pCf · +23.180052 USDC", "SQDS…2pCf · −0.258554337 SOL"]);
  });
  it("instruction args: the amount reads as tokens, the mint as its symbol", () => {
    const i = ok(swapReport()).report.details!.instructions[0]!;
    expect(i.args.find((a) => a.key === "amount")!.value).toBe("23.180052 USDC");
    expect(i.accounts.find((a) => a.key === "mint")!.value).toBe("USDC");
  });
  it("the AI explanation validator accepts symbols and amounts that appear in the cited claim", () => {
    const v = ok(swapReport()).report as ReportView;
    const id = v.claims.find((c) => c.rule === "fact.token_transfer")!.id;
    expect(validateAiSentences({ sentences: [{ text: "You send 23.180052 USDC.", claimIds: [id] }] }, v)).not.toBeNull();
    expect(validateAiSentences({ sentences: [{ text: "You send 99 USDC.", claimIds: [id] }] }, v)).toBeNull();
  });
});

class N {
  tag = "";
  children: (N | string)[] = [];
  attrs: Record<string, string> = {};
  textContent = "";
  listeners: Record<string, (() => void)[]> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  replaceChildren(...k: (N | string)[]) { this.children = k; }
  append(...k: (N | string)[]) { this.children.push(...k); }
  addEventListener(t: string, f: () => void) { (this.listeners[t] ??= []).push(f); }
  get text(): string { return this.children.map((c) => (typeof c === "string" ? c : c.text)).join("") || this.textContent; }
  all(): N[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
}
const fakeDoc = () => { const d = { createElement: (tag: string) => Object.assign(new N(), { tag }) }; vi.stubGlobal("document", d); return d as unknown as Document; };
afterEach(() => vi.unstubAllGlobals());

describe("mint on hover", () => {
  it("each label is a span with the full mint in title and accessible text", () => {
    const doc = fakeDoc();
    const out = withTokens("You send −23.18 USDC today", [{ mint: USDC, label: "USDC" }], doc) as (N | string)[];
    expect(out[0]).toBe("You send ");
    const span = out[3] as N;
    expect(span.text).toBe("USDC");
    expect(span.attrs.title).toBe(USDC);
    expect(span.attrs["aria-label"]).toBe(`USDC, mint ${USDC}`);
    expect(out[4]).toBe(" today");
    expect(withTokens("USDCX and xUSDC", [{ mint: USDC, label: "USDC" }], doc)).toEqual(["USDCX and xUSDC"]);
  });
  it("the details step renders balances and the authorize text with hover spans", () => {
    fakeDoc();
    const m = ok(swapReport());
    const nodes = (detailsStep({ allow: false, hold: true, level: 0, reason: "r", report: m.report }, m.report) as unknown as N[]).flatMap((e) => [e, ...e.all()]);
    const spans = nodes.filter((n) => n.attrs["data-kelvara-token"] === USDC);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(nodes.some((n) => n.attrs["data-other-accounts"] !== undefined)).toBe(true);
    expect(nodes.filter((n) => "data-balance" in n.attrs).map((n) => n.text)).toContain("You send≈−23.18 USDC");
  });
});

describe("Assessment card", () => {
  it("one Assessment heading with the source tag on the same line, no 'Assessment by' line", () => {
    fakeDoc();
    const a = assessmentCard(undefined, 0) as unknown as { node: N; show(e: unknown): void };
    a.show({ source: "ai", sentences: [{ text: "Hello.", claimIds: [] }] });
    const all = [a.node, ...a.node.all()];
    expect(all.filter((n) => n.tag === "h2")).toHaveLength(1);
    const h = all.find((n) => n.tag === "h2")!;
    expect(h.textContent).toBe("Intent Assessment");
    expect(h.attrs["data-explain-source"]).toBe("ai");
    expect(h.attrs.title).toBe("Written by your AI provider");
    expect(all.some((n) => /Assessment by/.test(n.text))).toBe(false);
  });
  it("renders the swap candidate: question and reasons as text", () => {
    fakeDoc();
    const context = {
      version: "kelvara-intent-v1", messageHashes: hashes, complex: true, fallbackId: "s1", historyNote: "h",
      candidates: [{ id: "s1", kind: "swap", priority: 1, question: "Did you intend to swap 23.180052 USDC for at least 0.25 SOL?", reasons: [{ id: "r1", text: "Swap on Jupiter with 0.5% slippage.", claimIds: [], evidenceIds: [] }], comparison: null }]
    };
    const a = assessmentCard({ context, selectedId: "s1", reasonIds: ["r1"], source: "engine", status: "template" } as never, 0) as unknown as { node: N };
    const all = a.node.all();
    expect(all.find((n) => "data-intent-question" in n.attrs)!.text).toMatch(/^Did you intend to swap 23\.180052 USDC/);
    expect(all.find((n) => "data-intent-reason" in n.attrs)!.text).toBe("Swap on Jupiter with 0.5% slippage.");
  });
});

describe("Copy raw", () => {
  it("built in the worker from the message bytes: exact keys, base64 and base58 data", () => {
    const raw = [...rawInstructions(session).values()];
    expect(raw.length).toBe(session.transactions[0]!.instructions.length);
    const r = raw[0]!;
    expect(Object.keys(r)).toEqual(["transaction", "index", "programId", "accounts", "data", "dataBase58"]);
    expect(Buffer.from(r.data, "base64").equals(Buffer.from(session.transactions[0]!.instructions[0]!.data))).toBe(true);
    for (const a of r.accounts) expect(Object.keys(a)).toEqual(["address", "signer", "writable"]);
  });
  it("validator: accepted when exact, rejected on extra keys, bad charset, wrong card or oversize", () => {
    const m = ok(swapReport());
    const raw = [...rawInstructions(session).values()][0]!;
    const line = { ...m.report.details!.instructions[0]!, tx: raw.transaction, path: String(raw.index) };
    const view = (l: object) => validateReportView({ ...m.report, details: { ...m.report.details!, instructions: [l] } });
    expect(view({ ...line, raw })).not.toBeNull();
    expect(view({ ...line, raw: { ...raw, extra: 1 } })).toBeNull();
    expect(view({ ...line, raw: { ...raw, data: "not base64!" } })).toBeNull();
    expect(view({ ...line, raw: { ...raw, dataBase58: "0OIl" } })).toBeNull();
    expect(view({ ...line, raw: { ...raw, programId: "x" } })).toBeNull();
    expect(view({ ...line, raw: { ...raw, index: raw.index + 1 } })).toBeNull();
    expect(view({ ...line, raw: { ...raw, data: "A".repeat(2049) } })).toBeNull();
    expect(view({ ...line, raw: { ...raw, accounts: [{ address: raw.programId, signer: 1, writable: false }] } })).toBeNull();
  });
  it("the button copies JSON on click only and shows Copied for 2 s; it is not a decision control", async () => {
    fakeDoc();
    vi.useFakeTimers();
    const raw = [...rawInstructions(session).values()][0]!;
    const written: string[] = [];
    const b = copyRawButton(raw, () => ({ writeText: async (t: string) => { written.push(t); } })) as unknown as N;
    expect(written).toEqual([]);
    expect(b.attrs["data-kelvara-action"]).toBeUndefined();
    b.listeners.click![0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(written[0]!)).toEqual(raw);
    expect(b.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.textContent).toBe("Copy raw");
    vi.useRealTimers();
  });
});

// Layout: renders the real report page (preview harness build) in headless Chromium at 360-1280 px, second screen.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("second screen layout", () => {
  it("no account, address or hash is wider than the frame at 360, 375 and 1280 px", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const site = mkdtempSync(path.join(tmpdir(), "x24-site-"));
    execFileSync("node", [path.join(here, "../preview/build.mjs"), site], { stdio: "ignore" });
    const long = (c: string) => c.repeat(44);
    const base = ok(swapReport()).report;
    const raw = [...rawInstructions(session).values()][0]!;
    const report: ReportView = {
      ...base,
      origin: "https://app.example",
      details: {
        ...base.details!,
        balances: [...base.details!.balances!, `${long("A")} · +${"1".repeat(40)} ${"X".repeat(30)}`],
        other: [...(base.details!.other ?? []), `${long("B")} · −${"2".repeat(50)} SOL`],
        instructions: [{ tx: 0, path: String(raw.index), program: "Token Program", name: "transferChecked", raw, args: [{ key: "authority", value: long("C") }, { key: "amount", value: "9".repeat(60) }], accounts: [{ key: "source", value: long("D") }, { key: "destination", value: long("E") }] }]
      },
      capabilities: [{ rank: 1, change: "granted", authority: `token.authority of ${long("F")}`, holder: long("G"), risk: "high" } as never]
    };
    expect(validateReportView(report)).not.toBeNull();
    writeFileSync(path.join(site, "verdicts.json"), JSON.stringify({ x24: { allow: false, hold: true, level: 0, reason: "r", report }, none: null }));
    const port = 47790 + Math.floor(Math.random() * 100);
    const server = spawn("node", [path.join(here, "../preview/serve.mjs"), site, String(port)], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 700));
    const { chromium } = createRequire(path.resolve(here, "../../../tools/selfcheck/package.json"))("@playwright/test");
    const browser = await chromium.launch();
    try {
      for (const width of [360, 375, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.goto(`http://127.0.0.1:${port}/host.html?case=x24`);
        const frame = await (async () => { for (let i = 0; i < 50; i++) { const f = page.frames().find((x: { url(): string }) => x.url().includes("report.html")); if (f) return f; await page.waitForTimeout(100); } throw new Error("no frame"); })();
        await frame.waitForSelector("[data-intent-confirm]");
        await page.waitForFunction(() => true);
        for (let i = 0; i < 80; i++) { if (await frame.evaluate(() => !document.querySelector<HTMLButtonElement>("[data-intent-confirm]")?.disabled)) break; await page.waitForTimeout(100); }
        await frame.click("[data-intent-confirm]");
        await frame.waitForSelector(".review-details, .versus");
        expect(await frame.locator(".addr").count()).toBeGreaterThan(3);
        expect(await frame.locator("[data-copy-raw]").count()).toBe(1);
        const offenders = await frame.evaluate(() => {
          const limit = document.documentElement.clientWidth;
          const bad: string[] = [];
          for (const e of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
            if (e.closest("details:not([open]) > :not(summary)")) continue;
            const r = e.getBoundingClientRect();
            if (r.width > 0 && (r.right > limit + 1 || r.left < -1)) bad.push(`${e.tagName}.${e.className} ${Math.round(r.left)}..${Math.round(r.right)} > ${limit}`);
          }
          if (document.documentElement.scrollWidth > limit + 1) bad.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${limit}`);
          return bad;
        });
        expect(offenders, `${width}px`).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      server.kill();
    }
  }, 120000);
});

import { roundForReading } from "../src/report/tokens.js";
import { levelHeader as header, detailsStep as details } from "../src/report/page.js";

describe("rounding for reading", () => {
  it("rounds for the eye, keeps the exact value for hover, never to zero", () => {
    const cases: [string, string, boolean][] = [
      ["23.180052", "23.18", true], ["1250000.5", "1,250,000.5", false], ["0.25889912", "0.2589", true], ["0.000003864", "0.000003864", false],
      ["5.77101", "5.771", true], ["1000.123456", "1,000.12", true], ["7", "7", false], ["0.000005", "0.000005", false], ["0.00000000123456", "0.000000001235", true]
    ];
    for (const [exact, shown, changed] of cases) expect(roundForReading(exact), exact).toEqual({ text: shown, changed });
    expect(roundForReading("0").text).toBe("0");
  });
  it("text gets ≈ and the exact amount in the title only when rounding changed it; SOL too", () => {
    const doc = fakeDoc();
    const out = withTokens("You send −23.180052 USDC and pay 0.000005 SOL, receive 0.258554337 SOL", [{ mint: USDC, label: "USDC" }], doc) as (N | string)[];
    const amounts = out.filter((x): x is N => typeof x !== "string" && x.attrs.title !== undefined && x.attrs.title.includes(" ") && x.children.length > 0);
    expect(amounts.map((a) => [a.attrs.title, a.children[0]])).toEqual([["−23.180052 USDC", "≈−23.18 "], ["0.258554337 SOL", "≈0.2586 "]]);
    expect(out.some((x) => x === "0.000005")).toBe(true);
  });
});

describe("header pills and page split", () => {
  it("title, level, site and network are pills in one row, no separators; trusted stays green by attribute", () => {
    fakeDoc();
    const m = ok(swapReport());
    const report = { ...m.report, origin: "https://app.velocity.exchange", trustedSite: "Velocity", network: "mainnet" as const };
    const els = (header({ allow: false, hold: true, level: 0, reason: "r", report }, report) as unknown as N[]).flatMap((e) => [e, ...e.all()]);
    const row = els.find((n) => (n.attrs.class ?? "").includes("report-head"))!;
    const kids = row.children.filter((c): c is N => typeof c !== "string");
    expect(kids.some((c) => c.tag === "h1")).toBe(true);
    for (const attr of ["data-kelvara-level", "data-kelvara-origin", "data-kelvara-network"]) expect(kids.some((c) => attr in c.attrs), attr).toBe(true);
    expect(kids.find((c) => "data-kelvara-origin" in c.attrs)!.attrs["data-kelvara-trusted"]).toBe("true");
    expect(row.children.some((c) => c === " · ")).toBe(false);
  });
  it("page 2 shows no Ledger hash line", () => {
    fakeDoc();
    const m = ok(swapReport());
    const els = (details({ allow: false, hold: true, level: 0, reason: "r", report: m.report }, m.report) as unknown as N[]).flatMap((e) => [e, ...e.all()]);
    expect(els.some((n) => "data-kelvara-hash" in n.attrs || n.attrs.class === "ledger-hash")).toBe(false);
  });
});

describe("real Jupiter evidence labels simulation mints", () => {
  it("a USDC balance row says USDC, from E26's type=derivation kind=token evidence", async () => {
    const { report } = await realSwap(0);
    const withSim = structuredClone(report) as Report;
    const payer = withSim.evidence.find((e) => e.type === "derivation" && typeof (e.data as { feePayer?: string } | null)?.feePayer === "string");
    const wallet = (payer!.data as { feePayer: string }).feePayer;
    const id = `e${withSim.evidence.length + 1}`;
    (withSim.evidence as unknown[]).push({
      id, type: "simulation", source: "simulation", summary: "sim", transactionIndex: 0, instructionPath: null, address: null,
      data: { solChanges: [], tokenChanges: [{ owner: wallet, mint: USDC, delta: "5762509", decimals: 6 }, { owner: wallet, mint: JUPUSD, delta: "-5771010", decimals: 6 }], stateChanges: [] }
    });
    withSim.simulation = { status: "ok", summary: "Simulation shows: balances change.", evidenceIds: [id] };
    withSim.counts.evidence += 1;
    const fixed = { ...withSim, digest: reportDigest(withSim) } as Report;
    const m = fromReport(fixed, fixed.session.transactions.map((t) => t.messageHash));
    if (!m.ok) throw new Error(m.reason);
    expect(m.report.details!.balances).toEqual(expect.arrayContaining(["You receive · +5.762509 USDC", "You send · −5.77101 JupUSD"]));
    expect(JSON.stringify(m.report.details)).not.toContain("token EPjF");
  });
});

describe("View on Orb on instruction cards", () => {
  it("each instruction card with a program id carries the button; the worker puts the id on every top-level line", async () => {
    const { view } = await realSwap(0);
    const lines = view.details!.instructions;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => typeof l.programId === "string")).toBe(true);
    fakeDoc();
    const els = (detailsStep({ allow: false, hold: true, level: 0, reason: "r", report: view }, view) as unknown as N[]).flatMap((e) => [e, ...e.all()]);
    const buttons = els.filter((n) => "data-orb-program" in n.attrs);
    expect(buttons.map((b) => b.attrs["data-orb-program"])).toEqual(lines.map((l) => l.programId));
    expect(buttons[0]!.attrs["aria-label"]).toMatch(/^View .+ on Orb$/);
  });
});
