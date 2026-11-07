import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { Address } from "@solana/kit";
import type { RootNode } from "@codama/nodes";
import { createDecoder, IngestError, parseTransaction, type AnchorIdlJson, type ResolvedInstruction } from "../src/index.js";
import { fromBase58 } from "../src/util/encoding.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(root, p), "utf8")) as T;
interface Fixture {
  transaction: string;
  meta: {
    loadedAddresses?: { writable: Address[]; readonly: Address[] };
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[];
  };
}

it("G2: all fixtures parse, >=95% eligible instructions named, 1000 malformed inputs rejected", () => {
  const manifest = json<{ idls: { name: string; programId: string; format: string }[] }>("packages/idls/manifest.json");
  const decoder = createDecoder(manifest.idls.map((e) => ({
    name: e.name, programId: e.programId,
    root: json<RootNode>(`packages/idls/roots/${e.name}.json`),
    ...(e.format.startsWith("anchor") ? { idl: json<AnchorIdlJson>(`packages/idls/raw/${e.name}.json`) } : {})
  })));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json") && e.name !== "manifest.json") files.push(p);
    }
  };
  walk("fixtures");
  const expected = json<{ count: number; fixtures: { path: string }[] }>("fixtures/tx/manifest.json");
  assert.equal(expected.count, expected.fixtures.length, "fixture manifest count");
  for (const f of expected.fixtures) assert(files.includes(path.join("fixtures", f.path)), `missing fixture ${f.path}`);
  assert.deepEqual([...files].sort(), expected.fixtures.map((f) => path.join("fixtures", f.path)).sort(), "every JSON fixture must be inventoried");
  assert(files.length > 0, "no fixtures found");
  let named = 0, eligible = 0, total = 0;
  const excluded = new Map<string, number>();
  const misses: string[] = [];
  for (const file of files.sort()) {
    const fx = json<Fixture>(file);
    assert.equal(typeof fx.transaction, "string", `unsupported fixture shape: ${file}`);
    const tx = parseTransaction({ base64: fx.transaction, kind: "wire" });
    const keys = [...tx.staticAccounts, ...(fx.meta.loadedAddresses?.writable ?? []), ...(fx.meta.loadedAddresses?.readonly ?? [])];
    const resolve = (programIdIndex: number, indices: number[], data: Uint8Array, index: number): ResolvedInstruction => {
      assert(keys[programIdIndex], `${file}: unresolved program index ${programIdIndex}`);
      return {
        index, programIdIndex, programAddress: keys[programIdIndex]!, data,
        accounts: indices.map((i) => {
          assert(keys[i], `${file}: unresolved account index ${i}`);
          return { index: i, address: keys[i]!, signer: i < tx.header.numSignerAccounts, writable: false, source: { kind: "static" } as const };
        })
      };
    };
    const instructions = tx.instructions.map((ix, i) => resolve(ix.programIdIndex, ix.accountIndices, ix.data, i));
    for (const group of fx.meta.innerInstructions ?? []) {
      for (const ix of group.instructions) instructions.push(resolve(ix.programIdIndex, ix.accounts, fromBase58(ix.data), group.index));
    }
    for (const ix of instructions) {
      const d = decoder.decodeInstruction(ix);
      total++;
      if (d.reason === "program_not_in_registry") {
        excluded.set(d.programAddress, (excluded.get(d.programAddress) ?? 0) + 1);
        continue;
      }
      eligible++;
      if (d.status === "named") named++;
      else misses.push(`${file}: ix ${ix.index} ${d.programName} ${d.reason}`);
    }
  }
  assert(eligible > 0, "no eligible instructions");
  console.log(`Fixtures: ${files.length}; instructions: ${total}; eligible: ${eligible}; named: ${named}`);
  for (const [id, count] of [...excluded].sort()) console.log(`Excluded (no registered IDL or builtin): ${id} (${count})`);
  for (const miss of misses) console.log(`Unnamed: ${miss}`);
  const percent = named / eligible * 100;
  assert(percent >= 95, `named rate ${percent.toFixed(2)}% is below 95%`);
  let seed = 0x12345678;
  const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  let fuzz = 0;
  for (let i = 0; i < 1000; i++) {
    const bytes = Uint8Array.from({ length: random() % 1024 }, () => random() & 255);
    assert.throws(() => parseTransaction({ bytes, kind: "wire" }), IngestError);
    fuzz++;
  }
  console.log(`SELFCHECK-SUMMARY: ${percent.toFixed(2)}%, ${fuzz}/1000`);
}, 120000);
