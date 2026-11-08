import { afterEach, describe, expect, it, vi } from "vitest";
import { levelHeader } from "../src/report/page.js";
import { buttonsFor, reportMode } from "../src/report/model.js";
import { validateWorkerVerdict, type WorkerVerdict } from "../src/shared/protocol.js";
import { validateReportView, type ReportView } from "../src/shared/report-view.js";
import { IMPOSTOR_REASON, impostorFor, impostorVerdict } from "../src/sw/impostor.js";
import { messageVerdict, reviewMessage } from "../src/sw/message-review.js";
import { BRAND_TOKENS, TRUSTED_SITES, foldHost, impostorOf, trustedSiteFor } from "../src/sw/trusted-sites.js";
import { mountTrusted } from "../src/options/programs.js";

const IMPOSTORS: [string, string][] = [
  ["https://jupiter-swap.app", "Jupiter"], ["https://jup-ag.io", "Jupiter"], ["https://jup.ag.evil.com", "Jupiter"], ["https://jupag.com", "Jupiter"],
  ["https://kam1no.com", "Kamino"], ["https://kamlno.com", "Kamino"], ["https://xn--jup-9ma.ag", "Jupiter"], ["https://xn--jp-0ma.ag", "Jupiter"], ["https://јup.ag", "Jupiter"],
  ["http://jup.ag", "Jupiter"], ["http://kamino.com", "Kamino"], ["http://app.velocity.exchange", "Velocity"], ["https://velocity-exchange.app", "Velocity"],
  ["https://app-jup.ag-x.io", "Jupiter"], ["https://kamino-finance.xyz", "Kamino"], ["https://jup.agg", "Jupiter"]
];
const FINE = ["https://jup.ag", "https://jup.ag/swap/SOL-USDC", "https://kamino.com", "https://app.velocity.exchange", "https://orca.so", "https://raydium.io", "https://example.com", "https://evil.com/jup.ag", "http://localhost:3000", "http://127.0.0.1:5173", "https://station.jup.ag", "https://marinade.finance", "about:blank", "chrome-extension://x/report.html"];

describe("impostor detection (sender URLs only)", () => {
  it("flags look-alikes, homoglyphs, punycode, trusted host inside another domain, and the trusted host over http", () => {
    for (const [url, name] of IMPOSTORS) expect(impostorOf(url)?.name, url).toBe(name);
  });
  it("never flags exact trusted origins, other well-known sites, localhost or non-web pages", () => {
    for (const url of FINE) expect(impostorOf(url), url).toBeNull();
    for (const bad of [undefined, null, 5, "not a url"]) expect(impostorOf(bad)).toBeNull();
  });
  it("folds punycode, accents, look-alike letters and digit swaps", () => {
    expect(foldHost("xn--jup-9ma.ag")).toMatch(/^jup.\.ag$/);
    expect(foldHost("kam1no.com")).toBe("kam1no.com");
    expect(foldHost("јup.ag")).toBe("jup.ag");
    expect(foldHost(new URL("https://јup.ag").hostname)).toBe("jup.ag");
  });
  it("the brand token list sits next to the trusted sites and covers each of them", () => {
    expect([...BRAND_TOKENS]).toEqual(["jup", "jupiter", "kamino", "velocity"]);
    for (const s of TRUSTED_SITES) expect(BRAND_TOKENS.some((t) => new URL(s.origin).hostname.includes(t)), s.origin).toBe(true);
  });
  it("checks the frame and the top-level page; an impostor frame inside a trusted page is flagged", () => {
    expect(impostorFor("https://jup.ag/", "https://jup.ag/")).toBeNull();
    expect(impostorFor("https://jupiter-swap.app/", "https://example.com/")?.name).toBe("Jupiter");
    expect(impostorFor("https://example.com/", "https://jup-ag.io/")?.name).toBe("Jupiter");
    expect(impostorFor("https://jup.ag.evil.com/", "https://jup.ag/")?.name).toBe("Jupiter");
  });
});

describe("kamino.com is a trusted lending site", () => {
  it("green pill only: trusted, role lending, not an aggregator", () => {
    const s = trustedSiteFor("https://kamino.com/lend", "https://kamino.com/lend")!;
    expect(s).toMatchObject({ name: "Kamino", origin: "https://kamino.com", role: "lending" });
    expect(trustedSiteFor("http://kamino.com/", "http://kamino.com/")).toBeNull();
    expect(trustedSiteFor("https://www.kamino.com/", "https://www.kamino.com/")).toBeNull();
  });
  it("the Options list shows it", () => {
    const list = { children: [] as unknown[], replaceChildren(...n: unknown[]) { this.children = n; } };
    const mk = () => { const e: Record<string, unknown> = { children: [], dataset: {}, textContent: "" }; e.append = (...c: unknown[]) => (e.children as unknown[]).push(...c); e.setAttribute = () => {}; return e; };
    mountTrusted({ createElement: mk, querySelector: () => list } as unknown as Document);
    expect(list.children.map((c) => (c as { dataset: { trusted: string } }).dataset.trusted)).toContain("https://kamino.com");
  });
});

const view = (over: Partial<ReportView> = {}): ReportView => ({ title: "Swaps tokens", summary: "s", simulation: null, authorizes: "a", capabilities: [], preview: [], claims: [], evidence: [], messageHashes: ["2".repeat(44)], limited: false, ...over });
const base = (level: 0 | 1 | 2 | 3 | 4 | null, hold = true): WorkerVerdict => ({ allow: false, hold, level, reason: "r", report: view({ title: "Engine title", authorizes: "engine facts" }) });
const jup = TRUSTED_SITES[0]!;

describe("impostor effect", () => {
  it("every engine level becomes L4, blocked: no allow, no hold, no Sign anyway; levels are never lowered", () => {
    for (const level of [0, 1, 2, 3, 4, null] as const) {
      const v = impostorVerdict(base(level, level !== null && level < 4), jup);
      expect(v).toMatchObject({ allow: false, hold: false, level: 4, reason: IMPOSTOR_REASON });
      expect(v.report!.title).toBe("Impostor site · this is not https://jup.ag");
      expect(v.report!.summary).toBe("This page imitates Jupiter (https://jup.ag). ClearSign blocks it.");
      expect(v.report!.impostor).toEqual({ name: "Jupiter", origin: "https://jup.ag" });
      expect(v.report!.authorizes).toBe("engine facts");
      expect(validateReportView(v.report)).not.toBeNull();
      expect(validateWorkerVerdict(v)).not.toBeNull();
      expect(buttonsFor(v).signAnyway).toBeFalsy();
      expect(reportMode(v)).not.toBe("hold");
    }
  });
  it("applies to message signatures too, keeping the message review attached", () => {
    const msg = { v: 1, kind: "message", id: "0123456789abcdef0123456789abcdef", method: "solana:signMessage", wallet: "W", account: "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez", chain: null, message: Buffer.from("Please confirm you own this account.").toString("base64"), signIn: null } as never;
    const ctx = messageVerdict(reviewMessage(msg, "https://jup-ag.io/"));
    const v = impostorVerdict(ctx, jup);
    expect(v).toMatchObject({ allow: false, hold: false, level: 4 });
    expect(v.report!.message).toBeDefined();
  });
  it("a blocked engine failure (no report) still gets the impostor banner", () => {
    const v = impostorVerdict({ allow: false, hold: false, level: null, reason: "engine error", report: null }, jup);
    expect(v.level).toBe(4);
    expect(validateReportView(v.report)).not.toBeNull();
  });
});

class N {
  tag = "";
  children: (N | string)[] = [];
  attrs: Record<string, string> = {};
  textContent = "";
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...k: (N | string)[]) { this.children.push(...k); }
  all(): N[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
}
afterEach(() => vi.unstubAllGlobals());

describe("impostor header", () => {
  it("red banner with the real origin in the site pill: data-kelvara-trusted=false, data-kelvara-impostor=true", () => {
    vi.stubGlobal("document", { createElement: (tag: string) => Object.assign(new N(), { tag }) });
    const v = impostorVerdict(base(0), jup);
    const r = { ...v.report!, origin: "https://jupiter-swap.app", network: "mainnet" as const };
    const els = (levelHeader({ ...v, report: r }, r) as unknown as N[]).flatMap((e) => [e, ...e.all()]);
    expect(els.some((n) => (n.attrs.class ?? "").startsWith("risk-banner"))).toBe(true);
    expect(els.find((n) => n.tag === "h1")!.children.join("")).toContain("Impostor site · this is not https://jup.ag");
    const pill = els.find((n) => "data-kelvara-origin" in n.attrs)!;
    expect(pill.children).toEqual(["https://jupiter-swap.app"]);
    expect(pill.attrs["data-kelvara-trusted"]).toBe("false");
    expect(pill.attrs["data-kelvara-impostor"]).toBe("true");
    expect(els.find((n) => "data-kelvara-level" in n.attrs)!.attrs["data-kelvara-level"]).toBe("L4");
  });
});
