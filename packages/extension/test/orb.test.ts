import { describe, expect, it, vi } from "vitest";
import { orbButton } from "../src/report/orb.js";
import { SW_OPEN_EXPLORER } from "../src/shared/protocol.js";
import { handleOpenExplorer, isProgramId, openExplorerRequest, orbUrl } from "../src/sw/explorer.js";
import { validateReportView } from "../src/shared/report-view.js";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const EXT = { id: "extid", reportUrl: "chrome-extension://extid/report.html", optionsUrl: "chrome-extension://extid/options.html" };

describe("program id and URL", () => {
  it("accepts base58 of 32 to 44 characters only", () => {
    for (const ok of [JUP, "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]) expect(isProgramId(ok), ok).toBe(true);
    for (const bad of ["", "short", "0".repeat(40), "O".repeat(40), "l".repeat(40), "I".repeat(40), JUP + "x".repeat(10), JUP.slice(0, 31), `https://orbmarkets.io/address/${JUP}`, `${JUP}/../x`, `${JUP}?a=1`, `${JUP}#x`, `${JUP} `, "javascript:alert(1)", null, undefined, 5, {}]) expect(isProgramId(bad), String(bad)).toBe(false);
  });
  it("builds exactly https://orbmarkets.io/address/<id>", () => {
    expect(orbUrl(JUP)).toBe(`https://orbmarkets.io/address/${JUP}`);
    expect(orbUrl("https://evil.example")).toBeNull();
  });
  it("request shape is {type, programId} and nothing else", () => {
    expect(openExplorerRequest({ type: SW_OPEN_EXPLORER, programId: JUP })).toBe(JUP);
    expect(openExplorerRequest({ type: SW_OPEN_EXPLORER, programId: JUP, url: "https://evil.example" })).toBeNull();
    expect(openExplorerRequest({ type: "other", programId: JUP })).toBeNull();
    expect(openExplorerRequest({ type: SW_OPEN_EXPLORER, programId: "x" })).toBeNull();
    expect(openExplorerRequest([SW_OPEN_EXPLORER, JUP])).toBeNull();
  });
});

describe("sender validation and tab", () => {
  const msg = { type: SW_OPEN_EXPLORER, programId: JUP };
  const run = async (sender: object, m: unknown = msg) => {
    const create = vi.fn(async () => ({}));
    const opened = await handleOpenExplorer(m, sender, EXT, { create });
    return { opened, calls: create.mock.calls as unknown[][] };
  };
  it("opens the exact Orb URL for the extension's report frame (with its #secret) and options page", async () => {
    for (const url of [`${EXT.reportUrl}#abc`, EXT.reportUrl, EXT.optionsUrl]) {
      const r = await run({ id: "extid", url });
      expect(r.opened, url).toBe(true);
      expect(r.calls).toEqual([[{ url: `https://orbmarkets.io/address/${JUP}` }]]);
    }
  });
  it("refuses other extensions, pages, content scripts, sub-frames of options and bad ids", async () => {
    for (const sender of [{ id: "other", url: EXT.reportUrl }, { id: "extid", url: "https://jup.ag/" }, { id: "extid", url: "chrome-extension://extid/popup.html" }, { id: "extid", url: `${EXT.reportUrl}x` }, { id: "extid" }, { id: "extid", url: EXT.optionsUrl, frameId: 3 }, {}]) {
      const r = await run(sender);
      expect(r, JSON.stringify(sender)).toEqual({ opened: false, calls: [] });
    }
    expect((await run({ id: "extid", url: EXT.reportUrl }, { type: SW_OPEN_EXPLORER, programId: "not-an-id" })).opened).toBe(false);
  });
  it("a failing tabs.create is not a crash", async () => {
    expect(await handleOpenExplorer(msg, { id: "extid", url: EXT.reportUrl }, EXT, { create: async () => { throw new Error("x"); } })).toBe(false);
  });
});

class N {
  tag = "";
  className = "";
  children: (N | string)[] = [];
  attrs: Record<string, string> = {};
  textContent = "";
  listeners: Record<string, (() => void)[]> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...k: (N | string)[]) { this.children.push(...k); }
  addEventListener(t: string, f: () => void) { (this.listeners[t] ??= []).push(f); }
}
const doc = { createElement: (tag: string) => Object.assign(new N(), { tag }) } as unknown as Document;

describe("the button", () => {
  it("is a button with the label and accessible name, only for a valid id, and sends {type, programId} on click", async () => {
    const sent: object[] = [];
    const b = orbButton(JUP, "Jupiter v6", doc, (m) => { sent.push(m); }) as unknown as N;
    expect(b.tag).toBe("button");
    expect(b.attrs.type).toBe("button");
    expect(b.attrs["aria-label"]).toBe("View Jupiter v6 on Orb");
    expect((b.children[1] as N).textContent).toBe("View on Orb");
    expect(b.attrs["data-kelvara-action"]).toBeUndefined();
    expect(b.attrs.href).toBeUndefined();
    expect(sent).toEqual([]);
    b.listeners.click![0]!();
    expect(sent).toEqual([{ type: SW_OPEN_EXPLORER, programId: JUP }]);
    expect(orbButton("https://orbmarkets.io", "x", doc)).toBeNull();
  });
  it("the report view accepts programId on an instruction line only when it is base58", () => {
    const line = { tx: 0, path: "0", program: "Jupiter v6", name: null, args: [], accounts: [], programId: JUP };
    const view = (l: object) => validateReportView({ title: "t", summary: "s", simulation: null, authorizes: null, capabilities: [], preview: [], claims: [], evidence: [], messageHashes: ["1".repeat(44).replace(/1/g, "2")], limited: false, details: { instructions: [l], changes: [] } });
    expect(view(line)).not.toBeNull();
    expect(view({ ...line, programId: "https://orbmarkets.io/address/x" })).toBeNull();
    expect(view({ ...line, programId: 5 })).toBeNull();
  });
});
