// pnpm idls:build (PLAN.md M3): fetch, pin, convert, then write the registry.
//   1. fetch  Anchor IDL accounts (anchor:idl, zlib JSON) and every registry program's account and
//             ProgramData header over Helius mainnet. Native Codama IDLs are pinned repo files at the
//             commit that published our @solana-program client: they are re-downloaded from GitHub only
//             with --refetch-native, otherwise their pinned hash is checked.
//   2. pin    packages/idls/manifest.json: source, commit or slot, sha256, IDL authority, upgrade authority,
//             verified (on-chain IDL account whose authority equals the upgrade authority, hash pinned).
//             chain/programs.json keeps the raw RPC responses G5 checks offline.
//   3. convert raw/<name>.json -> roots/<name>.json (Codama root nodes; Anchor via rootNodeFromAnchor),
//             compacted: no docs, errors or events (src/compact.ts).
//   4. maps   capabilities/<name>.json (curated/<name>.json + keyword rules, low confidence) and
//             authority/<name>.json (core buildAuthorityMap) for Drift and the demo program.
//   5. write  registry.json: program id -> decoder, root, source, hashes, verified, map files.
// Flags: --offline (no network: re-derive 3-5 from the pinned files), --refetch-native.
// Reads HELIUS_API_KEY from the main checkout's .env; never prints it; redacts api-key= from errors.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { RootNode } from "@codama/nodes";
import { rootNodeFromAnchor, type IdlV00, type IdlV01 } from "@codama/nodes-from-anchor";
import { getBase58Decoder } from "@solana/kit";
import { buildAuthorityMap, UPGRADEABLE_LOADER_PROGRAM, type AnchorIdlJson } from "@kelvara/core";
import { buildCapabilityMap, checkCurated, enumVariants, loaderInstructions, resolveCurated, rootInstructions, type CuratedFile } from "../src/maps.js";
import { PROGRAMS, type ProgramSpec } from "../src/programs.js";
import { compactRoot } from "../src/compact.js";
import { anchorIdlAddress, heliusCall, heliusMainnetUrl, programChain, type AccountResult, type Recorded } from "../src/chain.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const offline = args.has("--offline");
const refetchNative = args.has("--refetch-native");
for (const a of args) if (!["--offline", "--refetch-native"].includes(a)) throw new Error(`unknown flag ${a}`);

const p = (...xs: string[]) => path.join(pkgDir, ...xs);
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown, pretty = true) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + "\n");
};
const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const b58 = getBase58Decoder();

// ---------------------------------------------------------------- RPC (Helius mainnet only)

const rpcUrl = offline ? "" : heliusMainnetUrl(pkgDir);
const rpc = (method: string, params: unknown[]) => heliusCall(rpcUrl, method, params);

// ---------------------------------------------------------------- 1-2. fetch and pin

interface ManifestEntry {
  name: string;
  programId: string;
  priority: string;
  format: string;
  source: string;
  client?: string;
  commit?: string;
  slot?: number;
  idlAddress?: string;
  idlAuthority?: string;
  sha256: string;
  inflatedSha256?: string;
  upgradeAuthority: string | null;
  programData: string | null;
  verified: boolean;
  verification: string;
  note?: string;
}
interface Manifest { schema: string; generatedAt: string; idls: ManifestEntry[] }

const oldManifest: Partial<Manifest> = existsSync(p("manifest.json")) ? readJson<Manifest>(p("manifest.json")) : {};
const oldPin = (name: string) => oldManifest.idls?.find((e) => e.name === name);

interface ChainRecord { schema: string; network: string; fetchedAt: string; responses: Record<string, Recorded> }
const chainFile = p("chain", "programs.json");
let chain: ChainRecord = existsSync(chainFile) ? readJson<ChainRecord>(chainFile) : { schema: "kelvara.idl-chain/v1", network: "mainnet", fetchedAt: "", responses: {} };

async function fetchChain(): Promise<void> {
  const responses: Record<string, Recorded> = {};
  for (const spec of PROGRAMS) {
    const r = await rpc("getAccountInfo", [spec.programId, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 36 } }]);
    responses[`program:${spec.programId}`] = r;
    const v = (r.result as AccountResult).value;
    if (v?.owner === UPGRADEABLE_LOADER_PROGRAM) {
      const data = Buffer.from(v.data[0], "base64");
      if (data.readUInt32LE(0) === 2) {
        const pd = b58.decode(data.subarray(4, 36));
        responses[`programData:${spec.programId}`] = await rpc("getAccountInfo", [pd, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 45 } }]);
      }
    }
  }
  chain = { schema: "kelvara.idl-chain/v1", network: "mainnet", fetchedAt: new Date().toISOString(), responses };
  const text = JSON.stringify(chain, null, 2) + "\n";
  if (/api-key/i.test(text)) throw new Error("refusing to write chain record: contains api-key");
  writeJson(chainFile, chain);
}

async function fetchAnchor(spec: ProgramSpec): Promise<Pick<ManifestEntry, "format" | "source" | "slot" | "idlAddress" | "idlAuthority" | "sha256" | "inflatedSha256">> {
  const idlAddress = await anchorIdlAddress(spec.programId);
  const r = await rpc("getAccountInfo", [idlAddress, { encoding: "base64", commitment: "finalized" }]);
  const acct = r.result as AccountResult;
  if (!acct.value) throw new Error(`${spec.name}: no anchor:idl account at ${idlAddress}`);
  const data = Buffer.from(acct.value.data[0], "base64");
  const idlAuthority = b58.decode(data.subarray(8, 40));
  const len = data.readUInt32LE(40);
  const text = inflateSync(data.subarray(44, 44 + len)).toString("utf8");
  const json = JSON.parse(text) as { metadata?: { spec?: string } };
  const pretty = JSON.stringify(json, null, 2) + "\n";
  const old = oldPin(spec.name);
  if (old && old.inflatedSha256 && old.inflatedSha256 !== sha256(text)) console.log(`${spec.name}: on-chain IDL changed since the last pin (${old.inflatedSha256.slice(0, 12)} -> ${sha256(text).slice(0, 12)}); re-pinning`);
  writeFileSync(p("raw", `${spec.name}.json`), pretty);
  return {
    format: json.metadata?.spec ? `anchor-${json.metadata.spec}` : "anchor-legacy",
    source: `anchor:idl account ${idlAddress} (Helius mainnet)`,
    slot: acct.context.slot,
    idlAddress,
    idlAuthority,
    sha256: sha256(pretty),
    inflatedSha256: sha256(text)
  };
}

async function fetchNative(spec: ProgramSpec): Promise<string> {
  const url = `https://raw.githubusercontent.com/${spec.repo}/${spec.commit}/idl.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  if ((JSON.parse(text) as { kind?: string }).kind !== "rootNode") throw new Error(`${spec.name}: not a Codama root`);
  writeFileSync(p("raw", `${spec.name}.json`), text);
  return text;
}

mkdirSync(p("raw"), { recursive: true });
if (!offline) await fetchChain();

const entries: ManifestEntry[] = [];
for (const spec of PROGRAMS) {
  if (spec.decoder !== "idl") continue;
  const ch = programChain(chain.responses, spec.programId);
  const base = { name: spec.name, programId: spec.programId, priority: spec.priority, upgradeAuthority: ch?.upgradeAuthority ?? null, programData: ch?.programData ?? null };
  if (spec.kind === "codama") {
    const text = refetchNative || !existsSync(p("raw", `${spec.name}.json`)) ? (offline ? (() => { throw new Error(`${spec.name}: raw file missing and --offline`); })() : await fetchNative(spec)) : readFileSync(p("raw", `${spec.name}.json`), "utf8");
    const hash = sha256(text);
    const old = oldPin(spec.name);
    if (old && old.sha256 !== hash && !refetchNative) throw new Error(`${spec.name}: raw/${spec.name}.json does not match its pinned sha256 ${old.sha256}`);
    entries.push({
      ...base,
      format: "codama",
      source: `github.com/${spec.repo}/blob/${spec.commit}/idl.json`,
      client: spec.client!,
      commit: spec.commit!,
      sha256: hash,
      verified: false,
      verification: "official Codama IDL from the program's repo at the commit that published the pinned client; native program, no on-chain IDL account"
    });
    continue;
  }
  // Anchor: on-chain IDL account (fetched now, or the pinned file when offline).
  let pin: Pick<ManifestEntry, "format" | "source" | "slot" | "idlAddress" | "idlAuthority" | "sha256" | "inflatedSha256">;
  if (offline) {
    const old = oldPin(spec.name);
    if (!old) throw new Error(`${spec.name}: no pin and --offline`);
    const hash = sha256(readFileSync(p("raw", `${spec.name}.json`), "utf8"));
    if (hash !== old.sha256) throw new Error(`${spec.name}: raw/${spec.name}.json does not match its pinned sha256 ${old.sha256}`);
    pin = { format: old.format, source: old.source, slot: old.slot!, idlAddress: old.idlAddress ?? (await anchorIdlAddress(spec.programId)), idlAuthority: old.idlAuthority!, sha256: old.sha256, inflatedSha256: old.inflatedSha256! };
  } else {
    pin = await fetchAnchor(spec);
  }
  const match = !!pin.idlAuthority && !!base.upgradeAuthority && pin.idlAuthority === base.upgradeAuthority;
  entries.push({
    ...base,
    ...pin,
    verified: match,
    verification: match
      ? "on-chain IDL account; its authority equals the program's upgrade authority; hash pinned"
      : base.programData && !base.upgradeAuthority
        ? `on-chain IDL account, hash pinned, but the program is immutable (no upgrade authority), so the IDL authority ${pin.idlAuthority} cannot be tied to the deployed code`
        : `on-chain IDL account, hash pinned, but its authority ${pin.idlAuthority} is not the upgrade authority ${base.upgradeAuthority ?? "(not read)"}`,
    ...(spec.note ? { note: spec.note } : {})
  });
}

const changed = JSON.stringify(entries) !== JSON.stringify(oldManifest.idls);
const manifest: Manifest = { schema: "kelvara.idl-manifest/v1", generatedAt: changed || !oldManifest.generatedAt ? new Date().toISOString() : oldManifest.generatedAt, idls: entries };
writeJson(p("manifest.json"), manifest);

// ---------------------------------------------------------------- 3. convert

const roots: Record<string, RootNode> = {};
for (const m of entries) {
  const raw = readJson<unknown>(p("raw", `${m.name}.json`));
  let root = (m.format === "codama" ? raw : rootNodeFromAnchor(raw as IdlV00 | IdlV01)) as RootNode;
  if (root?.kind !== "rootNode") throw new Error(`${m.name}: conversion did not return a rootNode`);
  // Anchor legacy IDLs often omit metadata.address; pin the program id from the manifest.
  if (root.program.publicKey !== m.programId) root = { ...root, program: { ...root.program, publicKey: m.programId } } as RootNode;
  // Compact: no docs, errors or events (see src/compact.ts); the extension bundles these files.
  root = compactRoot(root);
  roots[m.name] = root;
  writeJson(p("roots", `${m.name}.json`), root, false);
}
writeJson(
  p("roots", "index.json"),
  entries.map((m) => ({ name: m.name, programId: m.programId, decoder: "codama", instructions: roots[m.name]!.program.instructions?.length ?? 0 }))
);

// ---------------------------------------------------------------- 4. capability and authority maps

const curatedFiles: Record<string, CuratedFile> = {};
for (const spec of PROGRAMS) if (existsSync(p("curated", `${spec.name}.json`))) curatedFiles[spec.name] = readJson<CuratedFile>(p("curated", `${spec.name}.json`));

const errors: string[] = [];
for (const spec of PROGRAMS) {
  if (!spec.capabilities) continue;
  const ixs = spec.decoder === "loader" ? loaderInstructions() : rootInstructions(roots[spec.name]!);
  const checkedAgainst = spec.decoder === "loader" ? "packages/core/src/decode/builtin.ts (hand-written decoder)" : `packages/idls/roots/${spec.name}.json`;
  const curated = curatedFiles[spec.name] ? resolveCurated(curatedFiles[spec.name]!, curatedFiles) : undefined;
  if (curated) errors.push(...checkCurated(curated, ixs, spec.decoder === "idl" && enumVariants(roots[spec.name]!, "authorityType").length ? enumVariants(roots[spec.name]!, "authorityType") : null));
  writeJson(p("capabilities", `${spec.name}.json`), buildCapabilityMap({ program: spec.name, programId: spec.programId, instructions: ixs, checkedAgainst, ...(curated ? { curated } : {}) }));
}
if (errors.length) throw new Error(`curated maps do not match the IDLs:\n${errors.join("\n")}`);

for (const spec of PROGRAMS) {
  if (!spec.authorityMap) continue;
  const m = entries.find((e) => e.name === spec.name)!;
  const map = buildAuthorityMap(readJson<AnchorIdlJson>(p("raw", `${spec.name}.json`)), { programId: spec.programId, name: spec.name, source: `packages/idls/raw/${spec.name}.json`, verified: spec.authorityMap.verifiedOverride ?? m.verified });
  writeJson(p("authority", `${spec.name}.json`), { schema: "kelvara.authority-map/v1", review: spec.authorityMap.review, ...map });
}

// ---------------------------------------------------------------- 5. registry

const registry = {
  schema: "kelvara.idl-registry/v1",
  programs: PROGRAMS.map((spec) => {
    const m = entries.find((e) => e.name === spec.name);
    const ch = programChain(chain.responses, spec.programId);
    return {
      name: spec.name,
      programId: spec.programId,
      priority: spec.priority,
      decoder: spec.decoder === "idl" ? "codama" : "builtin",
      root: m ? `roots/${m.name}.json` : null,
      rootSha256: m ? sha256(readFileSync(p("roots", `${m.name}.json`))) : null,
      idl: m ? `raw/${m.name}.json` : null,
      sha256: m?.sha256 ?? null,
      source: m?.source ?? spec.builtinSource ?? null,
      verified: m?.verified ?? false,
      executable: ch?.executable ?? null,
      upgradeAuthority: ch?.upgradeAuthority ?? null,
      capabilities: spec.capabilities ? `capabilities/${spec.name}.json` : null,
      capabilityMap: spec.capabilities ? (curatedFiles[spec.name] ? "curated" : "keyword") : null,
      authorityMap: spec.authorityMap ? `authority/${spec.name}.json` : null
    };
  })
};
writeJson(p("registry.json"), registry);

for (const r of registry.programs) {
  console.log(`${r.name.padEnd(23)} ${r.priority.padEnd(7)} ${r.decoder.padEnd(8)} exec=${String(r.executable).padEnd(5)} verified=${String(r.verified).padEnd(5)} ${r.capabilityMap ?? "-"}${r.authorityMap ? " +authority" : ""}`);
}
