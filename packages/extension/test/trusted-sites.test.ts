import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReportBuilder, ingestSession, type Report, type Session } from "@kelvara/core";
import type { IntentContext } from "@kelvara/core/intent-schema";
import { mountTrusted } from "../src/options/programs.js";
import { levelHeader } from "../src/report/page.js";
import { withContext } from "../src/sw/report-context.js";
import { validateReportView } from "../src/shared/report-view.js";
import type { EngineLike } from "../src/sw/engine-stub.js";
import { fromReport, type FromReport } from "../src/sw/from-report.js";
import { decide, messageHashes, type Sha256 } from "../src/sw/policy.js";
import { routedIntent } from "../src/sw/route-intent.js";
import { TRUSTED_SITES, trustedSiteFor } from "../src/sw/trusted-sites.js";
import type { SignRequest } from "../src/shared/protocol.js";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/tx/drift-replay");
const ATTACK_1 = "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H";
const sha: Sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());
const fixture = JSON.parse(readFileSync(path.join(fixturesDir, `${ATTACK_1}.json`), "utf8")) as { transaction: string };

let session: Session;
let txs: string[];
let hashes: string[];
beforeAll(async () => {
  txs = [fixture.transaction];
  session = await ingestSession([{ base64: fixture.transaction, kind: "wire" as const, label: "a" }]);
  hashes = await messageHashes(txs, sha);
});

/** Unreadable instructions (no decoded name) and, optionally, one claim. */
function routeReport(claim?: { kind: "Fact" | "Unknown"; level: "L0" | "L1" | "L2" | "L3" }): Report {
  const b = new ReportBuilder(session);
  const ev = session.transactions.flatMap((tx) =>
    tx.instructions.map((i) => b.addEvidence({ type: "instruction", source: "message", summary: `instruction ${i.index} calls ${i.programAddress}`, transactionIndex: tx.index, instructionPath: [i.index], address: i.programAddress }))
  );
  b.addClaim({ kind: "Fact", statement: "The request calls these programs.", evidenceIds: ev, level: "L0" });
  if (claim) b.addClaim({ kind: claim.kind, statement: "A claim.", evidenceIds: ev.slice(0, 1), level: claim.level, ...(claim.kind === "Fact" ? { ruleId: "lifetime.durable_nonce" } : {}) });
  return b.build();
}
const ok = (m: FromReport) => {
  if (!m.ok) throw new Error(m.reason);
  return m;
};
const n = () => session.transactions.reduce((a, t) => a + t.instructions.length, 0);

describe("trusted site matching", () => {
  it("lists exactly the three reviewed origins with their roles, frozen", () => {
    expect(TRUSTED_SITES.map((s) => [s.origin, s.role])).toEqual([["https://jup.ag", "aggregator"], ["https://kamino.com", "lending"], ["https://app.velocity.exchange", "perp-dex"]]);
    expect(Object.isFrozen(TRUSTED_SITES)).toBe(true);
    for (const s of TRUSTED_SITES) expect(s.reason.length).toBeGreaterThan(10);
  });
  it("exact HTTPS origin (path, query, default port ok)", () => {
    for (const u of ["https://jup.ag", "https://jup.ag/", "https://jup.ag/swap/SOL-USDC?x=1", "https://JUP.AG/", "https://jup.ag:443/"]) expect(trustedSiteFor(u, u)?.name, u).toBe("Jupiter");
    expect(trustedSiteFor("https://app.velocity.exchange/trade", "https://app.velocity.exchange/")?.name).toBe("Velocity");
  });
  it("http, subdomains, look-alikes, other ports, path tricks are not trusted", () => {
    for (const u of [
      "http://jup.ag/", "https://jup.ag.evil.com/", "https://evil.com/jup.ag", "https://evil.com/?https://jup.ag", "https://www.jup.ag/", "https://xn--jup-9ma.ag/", "https://jüp.ag/", "https://jup.ag:8443/",
      "https://jup.ag@evil.com/", "https://velocity.exchange/", "https://app.velocity.exchange.evil.com/", "javascript:https://jup.ag", "not a url", "", "https://jup.ag.", "ftp://jup.ag/"
    ]) expect(trustedSiteFor(u, u), u).toBeNull();
    for (const bad of [undefined, null, 5, {}]) expect(trustedSiteFor(bad, "https://jup.ag/")).toBeNull();
  });
  it("an iframe whose top-level origin differs is not trusted, in either direction", () => {
    expect(trustedSiteFor("https://jup.ag/embed", "https://evil.com/")).toBeNull();
    expect(trustedSiteFor("https://evil.com/", "https://jup.ag/")).toBeNull();
    expect(trustedSiteFor("https://jup.ag/", "https://app.velocity.exchange/")).toBeNull();
    expect(trustedSiteFor("https://jup.ag/", undefined)).toBeNull();
  });
});

describe("routed presentation (L0, unreadable programs only)", () => {
  it("untrusted: today's header", () => {
    const m = ok(fromReport(routeReport(), hashes));
    expect(m.report.title).toBe(`Can't fully verify · ${n()} unreadable instruction${n() === 1 ? "" : "s"}`);
    expect(m.report.routedBy).toBeUndefined();
  });
  it("trusted aggregator: calm routed header, programs still named, level unchanged", () => {
    const base = ok(fromReport(routeReport(), hashes));
    const m = ok(fromReport(routeReport(), hashes, "Jupiter"));
    expect(m.level).toBe(base.level);
    expect(m.report.title).toBe(`Routed by Jupiter · ${n()} third-party instruction${n() === 1 ? "" : "s"}`);
    expect(m.report.summary).toMatch(/^Jupiter routes this trade through programs ClearSign can't read \(.+\); that is normal for an aggregator\./);
    expect(m.report.routedBy).toBe("Jupiter");
    expect(m.report.details!.instructions.every((i) => i.name === null)).toBe(true);
    expect(m.report.details!.instructions).toHaveLength(base.report.details!.instructions.length);
    expect(m.report.authorizes).toBe(base.report.authorizes);
    expect(validateReportView(m.report)).not.toBeNull();
  });
  it("any risk claim keeps today's presentation", () => {
    const base = (r: Report) => ok(fromReport(r, hashes));
    for (const claim of [{ kind: "Unknown", level: "L1" }, { kind: "Fact", level: "L2" }, { kind: "Fact", level: "L3" }] as const) {
      const r = routeReport(claim);
      const trusted = ok(fromReport(r, hashes, "Jupiter"));
      expect(trusted.report.routedBy, JSON.stringify(claim)).toBeUndefined();
      expect(trusted.report.title).toBe(base(r).report.title);
      expect(trusted.report.summary).toBe(base(r).report.summary);
      expect(trusted.level).toBe(base(r).level);
    }
  });
  it("routedBy must be a short string in the view", () => {
    const v = ok(fromReport(routeReport(), hashes, "Jupiter")).report;
    expect(validateReportView({ ...v, routedBy: "x".repeat(65) })).toBeNull();
    expect(validateReportView({ ...v, routedBy: 5 })).toBeNull();
  });
});

describe("routed intent", () => {
  const reason = (id: string) => [{ id, text: "t", claimIds: [], evidenceIds: [] }];
  const cand = (id: string, kind: IntentContext["candidates"][number]["kind"], priority: 0 | 2) => ({ id, kind, priority, question: "q?", reasons: reason(`r-${id}`), comparison: null });
  const ctx = (candidates: IntentContext["candidates"]): IntentContext => ({ version: "kelvara-intent-v1", messageHashes: hashes, complex: true, fallbackId: candidates[0]!.id, historyNote: "h", candidates });
  it("only unknown-effects candidates: no question, so no AI call", () => {
    expect(routedIntent(ctx([cand("u1", "unknown", 2)]))).toBeUndefined();
  });
  it("transfer candidate stays, unknown dropped, no longer complex", () => {
    const i = routedIntent(ctx([cand("u1", "unknown", 2), cand("t1", "transfer", 0)]))!;
    expect(i.context.candidates.map((c) => c.id)).toEqual(["t1"]);
    expect(i).toMatchObject({ selectedId: "t1", source: "engine", status: "template" });
    expect(i.context.complex).toBe(false);
  });
  it("other kinds (fees) are kept and still complex", () => {
    const i = routedIntent(ctx([cand("u1", "unknown", 2), cand("f1", "fees", 2)]))!;
    expect(i.context.candidates.map((c) => c.id)).toEqual(["f1"]);
    expect(i.context.complex).toBe(true);
  });
});

describe("decide passes the trusted name to the engine", () => {
  const request = () => ({ txs, chain: "solana:mainnet", method: "x", wallet: "w", id: "i" }) as unknown as SignRequest;
  const settings = { network: "mainnet", passThrough: false, heliusApiKey: "a".repeat(36) } as const;
  it("forwards routedBy only when given", async () => {
    const seen: (string | undefined)[] = [];
    const engine: EngineLike = {
      async analyze(_r, _e, _h, routedBy) {
        seen.push(routedBy);
        return { level: 0, ...ok(fromReport(routeReport(), hashes, routedBy)).report } as never;
      }
    };
    const a = await decide(request(), settings, engine, sha, "Jupiter");
    const b = await decide(request(), settings, engine, sha);
    expect(seen).toEqual(["Jupiter", undefined]);
    expect(a.report!.title).toMatch(/^Routed by Jupiter/);
    expect(b.report!.title).toMatch(/^Can't fully verify/);
    expect([a.allow, a.hold, a.level]).toEqual([b.allow, b.hold, b.level]);
  });
});

describe("options trusted sites list", () => {
  it("renders one read-only row per site", () => {
    const list = { children: [] as unknown[], replaceChildren(...n: unknown[]) { this.children = n; } };
    const mk = () => {
      const e: Record<string, unknown> = { children: [] as unknown[], dataset: {}, textContent: "", attrs: {} };
      e.append = (...c: unknown[]) => (e.children as unknown[]).push(...c);
      e.setAttribute = () => {};
      return e;
    };
    const doc = { createElement: mk, querySelector: () => list } as unknown as Document;
    mountTrusted(doc);
    expect(list.children).toHaveLength(TRUSTED_SITES.length);
    expect((list.children[0] as { dataset: { trusted: string } }).dataset.trusted).toBe("https://jup.ag");
  });
});

describe("site pill in the report header", () => {
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
  const pill = (url: string, site: string | null) => {
    vi.stubGlobal("document", { createElement: (tag: string) => Object.assign(new N(), { tag }) });
    const base = ok(fromReport(routeReport(), hashes));
    const verdict = withContext({ allow: false, hold: true, level: 0, reason: "r", report: base.report }, url, "mainnet", site);
    expect(validateReportView(verdict.report)).not.toBeNull();
    const nodes = (levelHeader(verdict, verdict.report) as unknown as N[]).flatMap((e) => [e, ...e.all()]);
    return nodes.find((n) => "data-kelvara-origin" in n.attrs)!;
  };
  it("trusted origin: data-kelvara-trusted=true with the site name as accessible label", () => {
    const p = pill("https://jup.ag/swap", trustedSiteFor("https://jup.ag/swap", "https://jup.ag/swap")!.name);
    expect(p.attrs["data-kelvara-trusted"]).toBe("true");
    expect(p.attrs["aria-label"]).toBe("Trusted site: Jupiter");
    expect(p.children).toEqual(["https://jup.ag"]);
  });
  it("other origins: data-kelvara-trusted=false, 'Not on the trusted list'", () => {
    for (const url of ["https://jup.ag.evil.com/", "http://jup.ag/", "https://other.example/"]) {
      const p = pill(url, trustedSiteFor(url, url)?.name ?? null);
      expect(p.attrs["data-kelvara-trusted"], url).toBe("false");
      expect(p.attrs["aria-label"]).toBe("Not on the trusted list");
    }
  });
  it("the pill never changes level, allow or hold", () => {
    const base = ok(fromReport(routeReport(), hashes)).report;
    const v = { allow: false, hold: true, level: 0 as const, reason: "r", report: base };
    const t = withContext(v, "https://jup.ag/", null, "Jupiter");
    expect([t.allow, t.hold, t.level]).toEqual([v.allow, v.hold, v.level]);
    expect(withContext(v, "about:blank", null, "Jupiter").report).toEqual(base);
  });
});
