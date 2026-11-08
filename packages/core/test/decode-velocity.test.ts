// E25: Velocity (vELoC1…DZ1P) real mainnet transactions decode to named instructions through the bundled IDL.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { sessionFromRuntime, decoder, here } from "./rules-helpers.js";

it("every Velocity instruction in the recorded real transactions is named, with named accounts", () => {
  const dir = path.join(here, "fixtures/velocity");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  // Not Anchor instructions: data starts with 0xffffffff (the oracle-update payload), which the IDL has no discriminator for.
  const NOT_IN_IDL = ["5ojLAhLu:2:ffffffff"];
  const unnamed: string[] = [];
  let seen = 0;
  for (const f of files) {
    const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
    const session = sessionFromRuntime(fx.transaction, fx.meta.loadedAddresses ?? { writable: [], readonly: [] });
    for (const ix of decoder.decodeSession(session).flat().filter((i) => i.programName === "velocity")) {
      if (ix.status !== "named") {
        expect(ix.reason).toBe("no_matching_instruction");
        unnamed.push(`${f.slice(0, 8)}:${ix.index}:${Buffer.from(ix.data).subarray(0, 4).toString("hex")}`);
        continue;
      }
      expect(ix.name).toBeTruthy();
      expect(ix.accounts.some((a) => a.name), f).toBe(true);
      seen++;
    }
  }
  expect(unnamed).toEqual(NOT_IN_IDL);
  expect(seen).toBeGreaterThan(0);
});
