// The discriminator prefilter hands Codama a pruned root (candidate instructions, the defined types they
// reach, no accounts/PDAs/errors). On every real fixture instruction of every registry Codama program,
// the pruned parse must equal the full-root parse: same instruction, same arguments, same account names.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { RootNode } from "@codama/nodes";
import { parseInstruction } from "@codama/dynamic-parsers";
import type { Address } from "@solana/kit";
import { parseTransaction } from "../src/index.js";
import { createPrefilter } from "../src/decode/prefilter.js";
import { fromBase58 } from "../src/util/encoding.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(repo, p), "utf8")) as T;
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v);

it("pruned roots parse every fixture instruction exactly like the full root", () => {
  const manifest = json<{ idls: { name: string; programId: string }[] }>("packages/idls/manifest.json");
  const programs = new Map(
    manifest.idls.map((m) => {
      const root = json<RootNode>(`packages/idls/roots/${m.name}.json`);
      return [m.programId, { name: m.name, root, prefilter: createPrefilter(root, root.program) }];
    })
  );
  const files = json<{ fixtures: { path: string }[] }>("fixtures/tx/manifest.json").fixtures.map((f) => path.join("fixtures", f.path));
  const extra = path.join(repo, "packages/idls/fixtures");
  if (existsSync(extra)) for (const d of readdirSync(extra)) for (const f of readdirSync(path.join(extra, d))) files.push(path.join("packages/idls/fixtures", d, f));
  let compared = 0;
  const perProgram = new Map<string, number>();
  for (const file of files) {
    const fx = json<{ transaction: string; meta: { loadedAddresses?: { writable: Address[]; readonly: Address[] }; innerInstructions?: { instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] } }>(file);
    const tx = parseTransaction({ base64: fx.transaction, kind: "wire" });
    const keys = [...tx.staticAccounts, ...(fx.meta.loadedAddresses?.writable ?? []), ...(fx.meta.loadedAddresses?.readonly ?? [])];
    const ixs = tx.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountIndices, data: ix.data }));
    for (const g of fx.meta.innerInstructions ?? []) for (const ix of g.instructions) ixs.push({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: fromBase58(ix.data) });
    for (const ix of ixs) {
      const programAddress = keys[ix.programIdIndex]!;
      const p = programs.get(programAddress);
      if (!p) continue;
      const input = { programAddress, accounts: ix.accounts.map((i) => ({ address: keys[i]!, role: 0 as const })), data: ix.data };
      let full: ReturnType<typeof parseInstruction> | "error";
      try {
        full = parseInstruction(p.root, input);
      } catch {
        full = "error";
      }
      const pruned = p.prefilter.rootFor(ix.data);
      let fast: ReturnType<typeof parseInstruction> | "error" | null;
      try {
        fast = pruned ? parseInstruction(pruned, input) : null;
      } catch {
        fast = "error";
      }
      const shape = (r: typeof full | typeof fast) =>
        r === "error" || !r ? (r ?? null) : JSON.stringify({ name: (r.path[r.path.length - 1] as { name: string }).name, data: r.data, accounts: r.accounts.map((a) => a.name) }, big);
      // A miss is null on the fast path (no candidate) and null or an error on the full path.
      expect(shape(fast) ?? "miss", `${file} ${p.name}`).toBe(shape(full) === "error" && fast === null ? "miss" : (shape(full) ?? "miss"));
      compared++;
      perProgram.set(p.name, (perProgram.get(p.name) ?? 0) + 1);
    }
  }
  console.log(`prefilter equivalence: ${compared} instructions (${[...perProgram].map(([k, v]) => `${k} ${v}`).join(", ")})`);
  expect(perProgram.get("marginfi-v2") ?? 0).toBeGreaterThan(0);
}, 60_000);
