// G5 (PLAN.md M3): IDLs and program ids are real and pinned.
//  - every registry program id is an executable account (chain/programs.json, recorded over Helius;
//    KELVARA_LIVE=1 re-reads them live, plus every Anchor IDL account, and must still match the pins);
//  - every IDL hash matches the manifest, roots match the registry, roots are what idls:build makes (compacted: no docs, errors, events);
//  - every curated capability names an instruction (and signer, and authority type) that exists;
//  - each P0 IDL decodes at least 3 real fixtures (fixtures/tx and packages/idls/fixtures, top-level and inner);
//  - every authority-map entry names a real instruction and a real account constraint.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, it } from "vitest";
import type { RootNode } from "@codama/nodes";
import { rootNodeFromAnchor, type IdlV00, type IdlV01 } from "@codama/nodes-from-anchor";
import { getBase58Encoder, type Address } from "@solana/kit";
import {
  buildAuthorityMap,
  createDecoder,
  parseTransaction,
  type AnchorIdlJson,
  type AuthorityMap,
  type ResolvedInstruction
} from "@kelvara/core";
import { anchorIdlAddress, heliusCall, heliusMainnetUrl, programChain, type AccountResult, type Recorded } from "../src/chain.js";
import { buildCapabilityMap, checkCurated, enumVariants, loaderInstructions, resolveCurated, rootInstructions, type CapabilityMap, type CuratedFile } from "../src/maps.js";
import { PROGRAMS } from "../src/programs.js";
import { compactRoot } from "../src/compact.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(pkgDir, "../..");
const read = (p: string): string => readFileSync(path.join(pkgDir, p), "utf8");
const json = <T>(p: string): T => JSON.parse(read(p)) as T;
const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const LIVE = process.env.KELVARA_LIVE === "1";
type AnchorIdlAccountItem = AnchorIdlJson["instructions"][number]["accounts"][number];

interface ManifestEntry { name: string; programId: string; priority: string; format: string; sha256: string; inflatedSha256?: string; idlAddress?: string; idlAuthority?: string; upgradeAuthority: string | null; programData: string | null; verified: boolean }
interface RegistryEntry { name: string; programId: string; priority: string; decoder: "codama" | "builtin"; root: string | null; rootSha256: string | null; idl: string | null; sha256: string | null; verified: boolean; executable: boolean | null; upgradeAuthority: string | null; capabilities: string | null; capabilityMap: string | null; authorityMap: string | null }

const manifest = json<{ idls: ManifestEntry[] }>("manifest.json");
const registry = json<{ programs: RegistryEntry[] }>("registry.json");
const chain = json<{ responses: Record<string, Recorded> }>("chain/programs.json");
const roots: Record<string, RootNode> = Object.fromEntries(manifest.idls.map((m) => [m.name, json<RootNode>(`roots/${m.name}.json`)]));
const P0_IDLS = PROGRAMS.filter((p) => p.priority.startsWith("P0"));

describe("G5 registry", () => {
  it("registry, manifest and program list agree", () => {
    assert.deepEqual(registry.programs.map((r) => r.programId), PROGRAMS.map((p) => p.programId));
    for (const p of PROGRAMS) {
      const r = registry.programs.find((x) => x.name === p.name)!;
      const m = manifest.idls.find((x) => x.name === p.name);
      assert.equal(!!m, p.decoder === "idl", `${p.name}: manifest entry iff decoded from an IDL`);
      if (m) {
        assert.equal(m.programId, p.programId);
        assert.equal(r.sha256, m.sha256);
        assert.equal(r.verified, m.verified);
        assert.equal(roots[p.name]!.program.publicKey, p.programId, `${p.name}: root program id`);
      }
    }
  });

  it("program ids are executable accounts (recorded Helius mainnet reads)", () => {
    for (const p of PROGRAMS) {
      const ch = programChain(chain.responses, p.programId);
      assert(ch, `${p.name}: no recorded account for ${p.programId}`);
      assert.equal(ch.executable, true, `${p.name}: ${p.programId} is not executable`);
      const r = registry.programs.find((x) => x.name === p.name)!;
      assert.equal(r.executable, true);
      assert.equal(r.upgradeAuthority, ch.upgradeAuthority, `${p.name}: registry upgrade authority`);
      const m = manifest.idls.find((x) => x.name === p.name);
      if (m) {
        assert.equal(m.upgradeAuthority, ch.upgradeAuthority, `${p.name}: manifest upgrade authority`);
        assert.equal(m.programData, ch.programData, `${p.name}: manifest ProgramData`);
        // PLAN: verified only for the on-chain IDL account whose authority equals the upgrade authority.
        const expect = m.format.startsWith("anchor") && !!m.idlAuthority && m.idlAuthority === ch.upgradeAuthority;
        assert.equal(m.verified, expect, `${p.name}: verified flag`);
      }
    }
  });

  it("IDL and root hashes match the manifest and registry; roots are what idls:build makes", async () => {
    for (const m of manifest.idls) {
      assert.equal(sha256(read(`raw/${m.name}.json`)), m.sha256, `${m.name}: raw IDL hash`);
      const r = registry.programs.find((x) => x.name === m.name)!;
      assert.equal(sha256(readFileSync(path.join(pkgDir, r.root!))), r.rootSha256, `${m.name}: root hash`);
      if (m.format.startsWith("anchor")) {
        assert.equal(m.idlAddress, await anchorIdlAddress(m.programId), `${m.name}: anchor:idl address`);
        let root = rootNodeFromAnchor(json<IdlV00 | IdlV01>(`raw/${m.name}.json`)) as RootNode;
        if (root.program.publicKey !== m.programId) root = { ...root, program: { ...root.program, publicKey: m.programId } } as RootNode;
        assert.equal(JSON.stringify(compactRoot(root)), JSON.stringify(roots[m.name]), `${m.name}: root differs from the converted IDL`);
      } else {
        assert.deepEqual(roots[m.name], compactRoot(json(`raw/${m.name}.json`)), `${m.name}: root is the pinned Codama IDL, compacted`);
      }
    }
    // The demo program's IDL in scenarios is the same on-chain IDL account content.
    const demo = path.join(repo, "packages/scenarios/programs/marginfi_v2.idl.json");
    if (existsSync(demo)) assert.deepEqual(JSON.parse(readFileSync(demo, "utf8")), json("raw/marginfi-v2.json"), "scenarios demo IDL differs from the pinned marginfi IDL");
  });

  it("curated capabilities name real instructions, signers and authority types; maps are current", () => {
    const curated: Record<string, CuratedFile> = {};
    for (const p of PROGRAMS) if (existsSync(path.join(pkgDir, `curated/${p.name}.json`))) curated[p.name] = json<CuratedFile>(`curated/${p.name}.json`);
    for (const name of ["system", "token", "token-2022", "bpf-loader-upgradeable", "squads-v4", "drift-v2"]) assert(curated[name], `PLAN M3: ${name} needs a curated map`);
    for (const p of PROGRAMS) {
      const r = registry.programs.find((x) => x.name === p.name)!;
      if (!p.capabilities) {
        assert.equal(r.capabilities, null);
        continue;
      }
      const ixs = p.decoder === "loader" ? loaderInstructions() : rootInstructions(roots[p.name]!);
      const c = curated[p.name] ? resolveCurated(curated[p.name]!, curated) : undefined;
      if (c) {
        assert.equal(c.programId, p.programId, `${p.name}: curated program id`);
        const types = p.decoder === "idl" ? enumVariants(roots[p.name]!, "authorityType") : [];
        assert.deepEqual(checkCurated(c, ixs, types.length ? types : null), [], `${p.name}: curated map`);
      }
      const map = json<CapabilityMap>(r.capabilities!);
      const checkedAgainst = p.decoder === "loader" ? "packages/core/src/decode/builtin.ts (hand-written decoder)" : `packages/idls/roots/${p.name}.json`;
      assert.deepEqual(map, buildCapabilityMap({ program: p.name, programId: p.programId, instructions: ixs, checkedAgainst, ...(c ? { curated: c } : {}) }), `${p.name}: capabilities file is stale (run pnpm idls:build)`);
      assert.equal(map.kind, c ? "curated" : "keyword");
      for (const e of map.entries) {
        assert(ixs.some((i) => i.name === e.instruction), `${p.name}.${e.instruction}: not an instruction`);
        assert.equal(e.confidence, e.source === "curated" ? "curated" : "low", `${p.name}.${e.instruction}: keyword entries are low confidence`);
      }
      if (c) assert.equal(map.entries.filter((e) => e.source === "curated").length, c.instructions.length, `${p.name}: every curated entry is in the map`);
    }
    // The capabilities the engine's own rules and preview rely on are curated.
    const tok = json<CapabilityMap>("capabilities/token-2022.json");
    for (const v of ["permanentDelegate", "freezeAccount", "transferHookProgramId", "mintTokens", "accountOwner"]) assert(tok.authorityTypes.some((t) => t.variant === v), `token-2022 authority type ${v}`);
    const drift = json<CapabilityMap>("capabilities/drift-v2.json");
    assert.equal(drift.entries.find((e) => e.instruction === "updateAdmin")?.source, "curated");
  });

  it("each P0 IDL decodes at least 3 real fixtures", () => {
    const decoder = createDecoder(
      manifest.idls.map((e) => ({ name: e.name, programId: e.programId, root: roots[e.name]!, ...(e.format.startsWith("anchor") ? { idl: json<AnchorIdlJson>(`raw/${e.name}.json`) } : {}) }))
    );
    // fixtures/tx (scenarios, inventoried by its manifest) plus fixtures/<program> here (scripts/record-fixtures.ts),
    // which must be untouched getTransaction bytes: sha256 and first signature match the file.
    const fm = JSON.parse(readFileSync(path.join(repo, "fixtures/tx/manifest.json"), "utf8")) as { fixtures: { path: string }[] };
    const files = fm.fixtures.map((f) => path.join(repo, "fixtures", f.path));
    for (const dir of existsSync(path.join(pkgDir, "fixtures")) ? readdirSync(path.join(pkgDir, "fixtures")) : []) {
      for (const f of readdirSync(path.join(pkgDir, "fixtures", dir)).filter((x) => x.endsWith(".json"))) files.push(path.join(pkgDir, "fixtures", dir, f));
    }
    const hits = new Map<string, Set<string>>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const fx = JSON.parse(text) as { signature?: string; sha256?: string; transaction: string; meta: { loadedAddresses?: { writable: Address[]; readonly: Address[] }; innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] } };
      const f = { path: path.relative(repo, file) };
      const tx = parseTransaction({ base64: fx.transaction, kind: "wire" });
      if (file.startsWith(pkgDir)) {
        assert.equal(sha256(Buffer.from(fx.transaction, "base64")), fx.sha256, `${f.path}: transaction bytes changed`);
        assert.equal(tx.signatures[0]?.signature, fx.signature, `${f.path}: signature does not match the bytes`);
        assert.equal(path.basename(file, ".json"), fx.signature, `${f.path}: file name`);
      }
      const keys = [...tx.staticAccounts, ...(fx.meta.loadedAddresses?.writable ?? []), ...(fx.meta.loadedAddresses?.readonly ?? [])];
      const resolve = (programIdIndex: number, indices: number[], data: Uint8Array, index: number): ResolvedInstruction => ({
        index,
        programIdIndex,
        programAddress: keys[programIdIndex]!,
        data,
        accounts: indices.map((i) => ({ index: i, address: keys[i]!, signer: i < tx.header.numSignerAccounts, writable: false, source: { kind: "static" } as const }))
      });
      const ixs = tx.instructions.map((ix, i) => resolve(ix.programIdIndex, ix.accountIndices, ix.data, i));
      for (const g of fx.meta.innerInstructions ?? []) for (const ix of g.instructions) ixs.push(resolve(ix.programIdIndex, ix.accounts, Uint8Array.from(getBase58Encoder().encode(ix.data)), g.index));
      for (const ix of ixs) {
        const d = decoder.decodeInstruction(ix);
        if (d.status !== "named" || !d.programName) continue;
        const spec = PROGRAMS.find((p) => p.programId === d.programAddress);
        if (!spec) continue;
        // An IDL program counts only when its Codama root decoded it; the loader by its hand-written decoder.
        if ((spec.decoder === "idl" && d.decoder !== "codama") || (spec.decoder !== "idl" && d.decoder !== "builtin")) continue;
        const set = hits.get(spec.name) ?? new Set<string>();
        set.add(f.path);
        hits.set(spec.name, set);
      }
    }
    const lines = P0_IDLS.map((p) => `${p.name}: ${hits.get(p.name)?.size ?? 0}`);
    console.log(`P0 fixtures decoded: ${lines.join(", ")}`);
    for (const p of P0_IDLS) assert((hits.get(p.name)?.size ?? 0) >= 3, `${p.name} decodes only ${hits.get(p.name)?.size ?? 0} fixtures`);
  });

  it("authority-map entries name real instructions and real account constraints", () => {
    for (const p of PROGRAMS.filter((x) => x.authorityMap)) {
      const r = registry.programs.find((x) => x.name === p.name)!;
      const file = json<AuthorityMap & { schema: string; review: string }>(r.authorityMap!);
      const idl = json<AnchorIdlJson & { accounts?: { name: string; type?: { fields?: { name: string }[] } }[] }>(`raw/${p.name}.json`);
      const m = manifest.idls.find((x) => x.name === p.name)!;
      const { schema, review, ...map } = file;
      assert.equal(schema, "kelvara.authority-map/v1");
      assert(review.length > 40, `${p.name}: authority map needs its hand review note`);
      assert.deepEqual(map, buildAuthorityMap(idl, { programId: p.programId, name: p.name, source: `packages/idls/raw/${p.name}.json`, verified: p.authorityMap!.verifiedOverride ?? m.verified }), `${p.name}: authority map is stale (run pnpm idls:build)`);
      assert(map.entries.length > 0, `${p.name}: empty authority map`);
      const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const flat = (items: AnchorIdlAccountItem[]): AnchorIdlAccountItem[] => items.flatMap((a) => (Array.isArray(a.accounts) ? flat(a.accounts) : [a]));
      const typeFields = (name: string): string[] => {
        const t = [...(idl.accounts ?? []), ...((idl.types ?? []) as { name: string; type?: { fields?: { name: string }[] } }[])].filter((x) => x.name.toLowerCase() === name.toLowerCase());
        return t.flatMap((x) => (x.type?.fields ?? []).map((f) => snake(f.name)));
      };
      for (const e of map.entries) {
        const ix = idl.instructions.find((i) => i.name === e.instruction);
        assert(ix, `${p.name}: ${e.instruction} is not an instruction`);
        const accts = flat(ix.accounts);
        const signer = accts.find((a) => a.name === e.tie.signer);
        assert(signer && (signer.signer === true || signer.isSigner === true), `${p.name}.${e.instruction}: ${e.tie.signer} is not a signer account`);
        if (e.tie.kind === "relation") {
          assert(Array.isArray(signer.relations) && (signer.relations as string[]).includes(e.tie.account!), `${p.name}.${e.instruction}: no relation ${e.tie.signer} -> ${e.tie.account}`);
          assert(accts.some((a) => a.name === e.tie.account), `${p.name}.${e.instruction}: related account ${e.tie.account} missing`);
        } else if (e.tie.kind === "address") {
          assert.equal(signer.address, e.tie.field, `${p.name}.${e.instruction}: fixed address`);
        } else {
          assert(accts.some((a) => a.name === e.tie.account), `${p.name}.${e.instruction}: account ${e.tie.account} missing`);
          assert(typeFields(e.tie.accountType!).includes(e.tie.field), `${p.name}.${e.instruction}: stored type ${e.tie.accountType} has no field ${e.tie.field}`);
        }
        // The discriminator is the one Codama decodes with (8 bytes, from the IDL or sha256("global:<name>")).
        const rootIx = rootInstructions(roots[p.name]!).find((i) => snake(i.name) === snake(e.instruction));
        assert.equal(rootIx?.discriminator, e.discriminator, `${p.name}.${e.instruction}: discriminator differs from the root`);
      }
    }
  });

  it.runIf(LIVE)("live: program accounts, upgrade authorities and Anchor IDL accounts still match the pins (Helius mainnet)", async () => {
    const url = heliusMainnetUrl(pkgDir);
    for (const p of PROGRAMS) {
      const responses: Record<string, Recorded> = {};
      responses[`program:${p.programId}`] = await heliusCall(url, "getAccountInfo", [p.programId, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 36 } }]);
      const recorded = programChain(chain.responses, p.programId)!;
      if (recorded.programData) responses[`programData:${p.programId}`] = await heliusCall(url, "getAccountInfo", [recorded.programData, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 45 } }]);
      const live = programChain(responses, p.programId);
      assert(live?.executable, `${p.name}: ${p.programId} is not executable on mainnet`);
      assert.equal(live.programData, recorded.programData, `${p.name}: ProgramData moved`);
      assert.equal(live.upgradeAuthority, recorded.upgradeAuthority, `${p.name}: upgrade authority changed since the pin (re-run pnpm idls:build)`);
    }
    for (const m of manifest.idls.filter((x) => x.format.startsWith("anchor"))) {
      const r = await heliusCall(url, "getAccountInfo", [m.idlAddress, { encoding: "base64", commitment: "finalized" }]);
      const v = (r.result as AccountResult).value;
      assert(v, `${m.name}: anchor:idl account ${m.idlAddress} is gone`);
      const data = Buffer.from(v.data[0], "base64");
      const text = inflateSync(data.subarray(44, 44 + data.readUInt32LE(40))).toString("utf8");
      assert.equal(sha256(text), m.inflatedSha256, `${m.name}: on-chain IDL differs from the pin (re-run pnpm idls:build)`);
    }
  }, 120_000);
});
