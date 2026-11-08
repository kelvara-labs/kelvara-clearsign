// E25: labels.json shape. Every id was verified executable over Helius when it was built (labels:build drops the rest).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { humanizeSlug } from "../src/labels.js";

const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as T;
const file = read<{ schema: string; source: string; fetchedAt: string; verifiedExecutable: number; labels: { programId: string; name: string }[] }>("../labels.json");
const registry = read<{ programs: { programId: string }[] }>("../registry.json");

describe("program labels", () => {
  it("is names and ids only, deduplicated, base58, not already a decoded program, with a recorded source", () => {
    expect(file.schema).toBe("kelvara.program-labels/v1");
    expect(file.source).toMatch(/^Helius program catalog \(describeProgram, \d{4}-\d{2}-\d{2}\)$/);
    expect(Number.isNaN(Date.parse(file.fetchedAt))).toBe(false);
    expect(file.labels.length).toBeGreaterThan(0);
    expect(file.verifiedExecutable).toBeGreaterThanOrEqual(file.labels.length);
    const registered = new Set(registry.programs.map((p) => p.programId));
    for (const l of file.labels) {
      expect(Object.keys(l).sort()).toEqual(["name", "programId"]);
      expect(l.programId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(l.name.trim()).toBe(l.name);
      expect(l.name.length).toBeGreaterThan(0);
      expect(registered.has(l.programId), l.programId).toBe(false);
    }
    expect(new Set(file.labels.map((l) => l.programId)).size).toBe(file.labels.length);
  });

  it("humanizes catalog slugs", () => {
    expect(humanizeSlug("raydium_clmm")).toBe("Raydium CLMM");
    expect(humanizeSlug("meteora-dlmm-v2")).toBe("Meteora DLMM v2");
    expect(humanizeSlug("Pump AMM")).toBe("Pump AMM");
  });
});
