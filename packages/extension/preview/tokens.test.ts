import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script shared with the CLI check
import { EXTENSION_CSS, PLAYGROUND_CSS, drift, tokenBlock } from "./check-tokens.mjs";

describe("design tokens", () => {
  it("playground token block is identical to the extension's", () => {
    expect(drift()).toBeNull();
  });
  it("styles contain no inline-style escape hatches or remote hosts, and no 9-10 px type", () => {
    for (const file of [EXTENSION_CSS, PLAYGROUND_CSS] as string[]) {
      const css = readFileSync(file, "utf8").replace(/url\("data:[^"]*"\)/g, "url()");
      expect(css).not.toMatch(/https?:\/\//);
      expect(css).not.toMatch(/font-size:\s*(9|10)px/);
      expect(css).not.toMatch(/@import/);
    }
    expect((tokenBlock(readFileSync(EXTENSION_CSS, "utf8")) as string).length).toBeGreaterThan(1000);
  });
});
