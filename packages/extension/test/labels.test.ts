import { describe, expect, it } from "vitest";
import { mountLabels } from "../src/options/labels.js";
import { LABEL_LIST, LABELS_SOURCE, PROGRAM_LABELS } from "../src/shared/program-labels.js";

class El {
  className = ""; title = ""; hidden = false; value = "";
  dataset: Record<string, string> = {}; children: El[] = []; attrs: Record<string, string> = {}; own = "";
  listeners: Record<string, (() => void)[]> = {};
  constructor(readonly tag: string, public id = "") {}
  get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(""); }
  set textContent(t: string) { this.own = t; this.children = []; }
  append(...n: (El | string)[]) { for (const c of n) { if (typeof c === "string") this.own += c; else this.children.push(c); } }
  replaceChildren(...n: El[]) { this.children = n; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(t: string, f: () => void) { (this.listeners[t] ??= []).push(f); }
  fire(t: string) { for (const f of this.listeners[t] ?? []) f(); }
}
const fakeDoc = () => {
  const byId = new Map(["labels-list", "labels-filter", "labels-empty", "labels-source"].map((id) => [id, new El("div", id)]));
  return { doc: { createElement: (t: string) => new El(t), querySelector: (q: string) => byId.get(q.slice(1)) ?? null } as unknown as Document, byId };
};

describe("program labels (E25)", () => {
  it("bundles names and ids only, base58 ids, no duplicates, source says catalog", () => {
    expect(LABEL_LIST.length).toBeGreaterThan(0);
    expect(LABELS_SOURCE).toMatch(/^Helius program catalog/);
    for (const l of LABEL_LIST) {
      expect(Object.keys(l).sort()).toEqual(["name", "programId"]);
      expect(l.programId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(l.name.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(LABEL_LIST.map((l) => l.programId)).size).toBe(LABEL_LIST.length);
    expect(Object.keys(PROGRAM_LABELS.names)).toHaveLength(LABEL_LIST.length);
  });

  it("renders one row per label with the not-verified wording and filters by name or id", () => {
    const { doc, byId } = fakeDoc();
    const labels = [{ programId: "1".repeat(32), name: "Alpha Swap" }, { programId: "2".repeat(32), name: "Beta Lend" }];
    mountLabels(doc, labels);
    const rows = byId.get("labels-list")!.children;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Name from Helius catalog, not verified decoding");
    expect(byId.get("labels-source")!.textContent).toContain("does not mean");
    const f = byId.get("labels-filter")!;
    f.value = "beta"; f.fire("input");
    expect(rows.map((r) => r.hidden)).toEqual([true, false]);
    f.value = "2222"; f.fire("input");
    expect(rows.map((r) => r.hidden)).toEqual([true, false]);
    f.value = "zzz"; f.fire("input");
    expect(byId.get("labels-empty")!.hidden).toBe(false);
  });
});
