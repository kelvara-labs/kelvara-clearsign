import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountPrograms, PROGRAMS, shortId } from "../src/options/programs.js";
// @ts-expect-error plain ESM script shared with the build step
import { buildProgramList } from "../scripts/programs-list.mjs";

const registry = JSON.parse(readFileSync(new URL("../../idls/registry.json", import.meta.url), "utf8")) as { programs: { name: string; programId: string }[] };


class El {
  className = "";
  title = "";
  hidden = false;
  value = "";
  dataset: Record<string, string> = {};
  children: El[] = [];
  attrs: Record<string, string> = {};
  own = "";
  listeners: Record<string, (() => void)[]> = {};
  constructor(readonly tag: string, public id = "") {}
  get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(""); }
  set textContent(t: string) { this.own = t; this.children = []; }
  append(...n: (El | string)[]) { for (const c of n) { if (typeof c === "string") this.own += c; else this.children.push(c); } }
  replaceChildren(...n: El[]) { this.children = n; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(t: string, f: () => void) { (this.listeners[t] ??= []).push(f); }
  fire(t: string) { for (const f of this.listeners[t] ?? []) f(); }
}
function fakeDoc() {
  const byId = new Map(["programs-search", "programs-filter", "programs-list", "programs-empty"].map((id) => [id, new El("div", id)]));
  const doc = { createElement: (t: string) => new El(t), querySelector: (q: string) => byId.get(q.slice(1)) ?? null } as unknown as Document;
  return { doc, byId };
}

describe("options Programs section", () => {
  it("lists exactly the registry programs (ids, names) and the committed data is current", () => {
    expect(PROGRAMS.map((p) => [p.name, p.programId])).toEqual(registry.programs.map((p) => [p.name, p.programId]));
    expect(PROGRAMS).toEqual(buildProgramList());
    for (const p of PROGRAMS) expect(p.title.length).toBeGreaterThan(0);
    expect(PROGRAMS.find((p) => p.name === "squads-v4")).toMatchObject({ title: "Squads v4", kind: "Anchor IDL" });
    expect(PROGRAMS.find((p) => p.name === "memo")?.understands).toEqual([]);
  });
  it("renders one row per program with the full id in title and accessible text", () => {
    const { doc, byId } = fakeDoc();
    mountPrograms(doc);
    const rows = byId.get("programs-list")!.children;
    expect(rows).toHaveLength(registry.programs.length);
    const first = rows[0]!.children[0]!.children[0]!.children[0]!;
    expect(first.title).toBe(PROGRAMS[0]!.programId);
    expect(first.getAttribute("aria-label")).toContain(PROGRAMS[0]!.programId);
    expect(first.textContent).toBe(shortId(PROGRAMS[0]!.programId));
    expect(rows.find((r) => r.dataset.program === "memo")?.textContent).toContain("Instruction names only");
    expect(byId.get("programs-search")!.hidden).toBe(registry.programs.length <= 10);
  });
  it("filter shows the search box above 10 programs and hides non-matches", () => {
    const { doc, byId } = fakeDoc();
    const many = Array.from({ length: 11 }, (_, i) => ({ ...PROGRAMS[0]!, name: `p${i}`, title: `Prog ${i}`, programId: `${i}`.repeat(32) }));
    mountPrograms(doc, many);
    expect(byId.get("programs-search")!.hidden).toBe(false);
    const f = byId.get("programs-filter")!;
    const rows = byId.get("programs-list")!.children;
    f.value = "prog 3";
    f.fire("input");
    expect(rows.filter((r) => !r.hidden)).toHaveLength(1);
    f.value = "zzz";
    f.fire("input");
    expect(byId.get("programs-empty")!.hidden).toBe(false);
  });
});
