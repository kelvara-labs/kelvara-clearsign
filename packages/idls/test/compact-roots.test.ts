// E17: roots/<name>.json are compact (src/compact.ts: no docs, errors or events) so the extension bundles
// less. This test proves the compact roots behave exactly like the full conversion of the pinned IDLs:
//  - the files on disk are compactRoot(full conversion), and only docs/errors/events are gone;
//  - every real fixture instruction (fixtures/tx and packages/idls/fixtures, top-level and inner)
//    decodes identically through core's decoder (status, decoder, name, args, account names, reason);
//  - 1000 random instruction inputs (real discriminators + random tails, plus pure noise) decode identically;
//  - capability maps (the source of capability previews) come out identical;
//  - analyzeSession on every recorded analyze scenario gives the same report digest.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import type { RootNode } from "@codama/nodes";
import { dropUnresolvablePdas } from "../src/anchor.js";
import { rootNodeFromAnchor, type IdlV00, type IdlV01 } from "@codama/nodes-from-anchor";
import type { Address } from "@solana/kit";
import { analyzeSession, createDecoder, parseTransaction, type AnchorIdlJson, type Decoder, type ResolvedInstruction } from "@kelvara/core";
import { replay, sessionOf, squadsAccounts } from "../../core/test/rules-helpers.js";
import { compactRoot } from "../src/compact.js";
import { buildCapabilityMap, rootInstructions } from "../src/maps.js";
import { PROGRAMS } from "../src/programs.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(repo, p), "utf8")) as T;
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v);

interface ManifestIdl { name: string; programId: string; format: string }
const manifest = json<{ idls: ManifestIdl[] }>("packages/idls/manifest.json");
const anchor = (m: ManifestIdl) => m.format.startsWith("anchor");

/** The full conversion idls:build made before E17 (same steps, no compaction). */
function fullRoot(m: ManifestIdl): RootNode {
  const raw = json<unknown>(`packages/idls/raw/${m.name}.json`);
  let root = (anchor(m) ? rootNodeFromAnchor(dropUnresolvablePdas(raw) as IdlV00 | IdlV01) : raw) as RootNode;
  if (root.program.publicKey !== m.programId) root = { ...root, program: { ...root.program, publicKey: m.programId } } as RootNode;
  return root;
}
const full = Object.fromEntries(manifest.idls.map((m) => [m.name, fullRoot(m)]));
const compact = Object.fromEntries(manifest.idls.map((m) => [m.name, json<RootNode>(`packages/idls/roots/${m.name}.json`)]));
const decoderOf = (roots: Record<string, RootNode>): Decoder =>
  createDecoder(manifest.idls.map((m) => ({ name: m.name, programId: m.programId, root: roots[m.name]!, ...(anchor(m) ? { idl: json<AnchorIdlJson>(`packages/idls/raw/${m.name}.json`) } : {}) })));
const fullDecoder = decoderOf(full);
const compactDecoder = decoderOf(compact);
const shape = (d: ReturnType<Decoder["decodeInstruction"]>) => JSON.stringify(d, big);

/** Every real fixture instruction, resolved like the G2 gate does. */
function fixtureInstructions(): { file: string; ix: ResolvedInstruction }[] {
  const files = json<{ fixtures: { path: string }[] }>("fixtures/tx/manifest.json").fixtures.map((f) => path.join("fixtures", f.path));
  for (const d of readdirSync(path.join(repo, "packages/idls/fixtures"))) for (const f of readdirSync(path.join(repo, "packages/idls/fixtures", d))) files.push(path.join("packages/idls/fixtures", d, f));
  const out: { file: string; ix: ResolvedInstruction }[] = [];
  for (const file of files) {
    const fx = json<{ transaction: string; meta: { loadedAddresses?: { writable: Address[]; readonly: Address[] }; innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] } }>(file);
    const tx = parseTransaction({ base64: fx.transaction, kind: "wire" });
    const keys = [...tx.staticAccounts, ...(fx.meta.loadedAddresses?.writable ?? []), ...(fx.meta.loadedAddresses?.readonly ?? [])];
    const resolve = (programIdIndex: number, indices: number[], data: Uint8Array, index: number): ResolvedInstruction => ({
      index, programIdIndex, programAddress: keys[programIdIndex]!, data,
      accounts: indices.map((i) => ({ index: i, address: keys[i]!, signer: i < tx.header.numSignerAccounts, writable: false, source: { kind: "static" } as const }))
    });
    tx.instructions.forEach((ix, i) => out.push({ file, ix: resolve(ix.programIdIndex, ix.accountIndices, ix.data, i) }));
    for (const g of fx.meta.innerInstructions ?? []) for (const ix of g.instructions) out.push({ file, ix: resolve(ix.programIdIndex, ix.accounts, base58(ix.data), g.index) });
  }
  return out;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

const FIXTURE_IXS = fixtureInstructions();

describe("E17 compact roots", () => {
  it("roots on disk are the full conversion minus docs, errors and events only", () => {
    for (const m of manifest.idls) {
      assert.equal(JSON.stringify(compact[m.name]), JSON.stringify(compactRoot(full[m.name]!)), `${m.name}: root is not compactRoot(conversion)`);
      // Put the dropped fields back from the full root: the result is the full root again.
      const restore = (c: unknown, f: unknown): unknown => {
        if (Array.isArray(f)) return f.map((x, i) => restore((c as unknown[])[i], x));
        if (!f || typeof f !== "object") return c;
        const fo = f as Record<string, unknown>, co = c as Record<string, unknown>;
        return Object.fromEntries(Object.keys(fo).map((k) => [k, k in co ? restore(co[k], fo[k]) : fo[k]]));
      };
      assert.deepEqual(restore(compact[m.name], full[m.name]), full[m.name], `${m.name}: compacting changed a field it keeps`);
      const dropped = new Set<string>();
      const walk = (c: unknown, f: unknown): void => {
        if (!f || typeof f !== "object") return;
        for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
          if (!(k in (c as object))) dropped.add(k);
          else walk((c as Record<string, unknown>)[k], v);
        }
      };
      walk(compact[m.name], full[m.name]);
      assert([...dropped].every((k) => ["docs", "errors", "events"].includes(k)), `${m.name}: dropped ${[...dropped].join(", ")}`);
    }
  });

  it("every fixture instruction decodes identically", () => {
    let compared = 0, named = 0;
    for (const { file, ix } of FIXTURE_IXS) {
      const a = fullDecoder.decodeInstruction(ix), b = compactDecoder.decodeInstruction(ix);
      assert.equal(shape(b), shape(a), `${file} ix ${ix.index}`);
      compared++;
      if (b.status === "named") named++;
    }
    console.log(`compact roots: ${compared} fixture instructions identical (${named} named)`);
    assert(compared > 400);
  }, 60000);

  it("1000 random instructions decode identically", () => {
    const discs = manifest.idls.flatMap((m) => rootInstructions(full[m.name]!).map((i) => ({ programId: m.programId, disc: i.discriminator })));
    const ids = manifest.idls.map((m) => m.programId);
    let seed = 0x9e3779b9;
    const rnd = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const sample = FIXTURE_IXS.map((x) => x.ix);
    for (let i = 0; i < 1000; i++) {
      const base = sample[rnd() % sample.length]!;
      const d = rnd() % 4 ? discs[rnd() % discs.length]! : { programId: ids[rnd() % ids.length]!, disc: null };
      const head = d.disc ? Uint8Array.from(d.disc.match(/../g)!.map((h) => parseInt(h, 16))) : new Uint8Array();
      const data = Uint8Array.from([...head, ...Array.from({ length: rnd() % 200 }, () => rnd() & 255)]);
      const ix: ResolvedInstruction = { ...base, programAddress: d.programId as Address, data, accounts: base.accounts.slice(0, rnd() % (base.accounts.length + 1)) };
      assert.equal(shape(compactDecoder.decodeInstruction(ix)), shape(fullDecoder.decodeInstruction(ix)), `random ${i}`);
    }
  }, 60000);

  it("capability maps (capability previews) are identical", () => {
    for (const spec of PROGRAMS) {
      if (spec.decoder !== "idl" || !spec.capabilities) continue;
      const map = (r: RootNode) => buildCapabilityMap({ program: spec.name, programId: spec.programId, instructions: rootInstructions(r), checkedAgainst: "x" });
      assert.deepEqual(map(compact[spec.name]!), map(full[spec.name]!), spec.name);
    }
  });

  it("analyzeSession reports are identical on every recorded scenario", async () => {
    const dir = path.join(repo, "packages/core/test/fixtures/analyze");
    for (const f of readdirSync(dir)) {
      const r = json<{ inputs: { transactions: string[]; wallet?: string; inventory?: unknown; simulate?: boolean } }>(`packages/core/test/fixtures/analyze/${f}`);
      const run = async (decoder: Decoder) => {
        const { rpc } = replay(r as never);
        const opts = { decoder, squadsAccounts, rpc, ...(r.inputs.wallet ? { wallet: r.inputs.wallet } : {}), ...(r.inputs.inventory ? { inventory: true } : {}), ...(r.inputs.simulate === false ? { simulate: false } : {}) };
        return (await analyzeSession(await sessionOf(r.inputs.transactions), opts)).report;
      };
      const [a, b] = [await run(fullDecoder), await run(compactDecoder)];
      assert.equal(b.digest, a.digest, f);
      assert(a.claims.length > 0, f);
    }
  }, 60000);
});
