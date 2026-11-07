// Loads what the engine needs from the repo: the IDL registry (decoder), the Squads account decoder and
// authority maps (registry Anchor IDLs, the scenarios' demo program IDLs and any --idl files).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAuthorityMap, createDecoder, createSquadsDecoder, type AnchorIdlJson, type AuthorityMap, type Decoder, type ProgramEntry, type SquadsAccountDecoder } from "@kelvara/core";

type RootNode = NonNullable<ProgramEntry["root"]>;

export interface Registry {
  root: string;
  decoder: Decoder;
  squadsAccounts: SquadsAccountDecoder;
  authorityMaps: AuthorityMap[];
}

const isRoot = (dir: string): boolean => existsSync(path.join(dir, "pnpm-workspace.yaml")) && existsSync(path.join(dir, "packages/idls/manifest.json"));

/** Repo root: KELVARA_ROOT, else the first ancestor of the cwd or of this file that holds the workspace. */
export function findRoot(cwd = process.cwd()): string {
  const env = process.env.KELVARA_ROOT;
  if (env) {
    if (!isRoot(env)) throw new Error(`KELVARA_ROOT ${env} is not the kelvara-signguard repo`);
    return path.resolve(env);
  }
  for (const start of [cwd, path.dirname(fileURLToPath(import.meta.url))]) {
    let dir = path.resolve(start);
    for (;;) {
      if (isRoot(dir)) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error("cannot find the kelvara-signguard repo (set KELVARA_ROOT)");
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

interface ManifestIdl {
  name: string;
  programId: string;
  format: string;
  verified?: boolean;
}

/** `path` or `path:programId` (program id overrides the IDL's own address). */
export function parseIdlArg(arg: string): { file: string; programId?: string } {
  const m = /^(.*):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(arg);
  return m ? { file: m[1]!, programId: m[2]! } : { file: arg };
}

export function loadRegistry(opts: { root?: string; idls?: string[] } = {}): Registry {
  const root = opts.root ?? findRoot();
  const manifest = readJson<{ idls: ManifestIdl[] }>(path.join(root, "packages/idls/manifest.json"));
  const anchor = (e: ManifestIdl) => e.format.startsWith("anchor");
  const decoder = createDecoder(
    manifest.idls.map((e) => ({
      name: e.name,
      programId: e.programId,
      root: readJson<RootNode>(path.join(root, `packages/idls/roots/${e.name}.json`)),
      ...(anchor(e) ? { idl: readJson<AnchorIdlJson>(path.join(root, `packages/idls/raw/${e.name}.json`)) } : {})
    }))
  );
  const squadsAccounts = createSquadsDecoder(readJson<AnchorIdlJson>(path.join(root, "packages/idls/raw/squads-v4.json")));

  const maps = new Map<string, AuthorityMap>();
  const add = (file: string, verified: boolean, programId?: string) => {
    const rel = path.relative(root, file) || file;
    const map = buildAuthorityMap(readJson<AnchorIdlJson>(file), { ...(programId ? { programId } : {}), source: rel.startsWith("..") ? file : rel, verified });
    maps.set(map.programId, map); // later sources (explicit --idl) win
  };
  for (const e of manifest.idls.filter(anchor)) add(path.join(root, `packages/idls/raw/${e.name}.json`), e.verified === true, e.programId);
  // The demo program's IDL (scenarios; unverified per its README).
  const programs = path.join(root, "packages/scenarios/programs");
  if (existsSync(programs)) for (const f of readdirSync(programs).filter((x) => x.endsWith(".idl.json")).sort()) add(path.join(programs, f), false);
  for (const a of opts.idls ?? []) {
    const { file, programId } = parseIdlArg(a);
    add(path.resolve(file), false, programId);
  }
  return { root, decoder, squadsAccounts, authorityMaps: [...maps.values()] };
}
