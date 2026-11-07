// The engine's program registry, bundled into the service worker (no fetches, no Node APIs).
// Mirrors the CLI's loadRegistry (packages/cli/src/registry.ts): E12's IDL manifest (packages/idls/manifest.json)
// drives the entry list; its Codama roots feed the decoder, Anchor IDLs are the decoder fallback and the
// authority maps, plus the Squads account decoder. The demo program (marginfi-v2) is a manifest entry since
// E12 (raw/marginfi-v2.json is the scenarios' marginfi_v2.idl.json content), so it is not bundled twice.
// esbuild needs static paths, so the files are listed below; the "bundled registry" test fails when the
// manifest or packages/idls/registry.json names a program whose files are not here. Built once, on first use.
import {
  buildAuthorityMap,
  createDecoder,
  createSquadsDecoder,
  type AnchorIdlJson,
  type AuthorityMap,
  type Decoder,
  type ProgramEntry,
  type SquadsAccountDecoder
} from "@kelvara/core";
import manifest from "../../../idls/manifest.json";
import rootSystem from "../../../idls/roots/system.json";
import rootToken from "../../../idls/roots/token.json";
import rootToken2022 from "../../../idls/roots/token-2022.json";
import rootSquads from "../../../idls/roots/squads-v4.json";
import rootDrift from "../../../idls/roots/drift-v2.json";
import rootMarginfi from "../../../idls/roots/marginfi-v2.json";
import rawSquads from "../../../idls/raw/squads-v4.json";
import rawDrift from "../../../idls/raw/drift-v2.json";
import rawMarginfi from "../../../idls/raw/marginfi-v2.json";

type RootNode = NonNullable<ProgramEntry["root"]>;

export interface Registry {
  decoder: Decoder;
  squadsAccounts: SquadsAccountDecoder;
  authorityMaps: AuthorityMap[];
}

interface ManifestIdl {
  name: string;
  programId: string;
  format: string;
  verified?: boolean;
}

const ROOTS: Record<string, unknown> = {
  system: rootSystem,
  token: rootToken,
  "token-2022": rootToken2022,
  "squads-v4": rootSquads,
  "drift-v2": rootDrift,
  "marginfi-v2": rootMarginfi
};
const ANCHOR: Record<string, unknown> = { "squads-v4": rawSquads, "drift-v2": rawDrift, "marginfi-v2": rawMarginfi };

/** Program names whose files this bundle carries (decoder roots; Anchor IDLs). */
export const BUNDLED = { roots: Object.keys(ROOTS), anchor: Object.keys(ANCHOR) };

/** Same entries as the CLI's registry; throws if the manifest names an IDL this bundle lacks. */
export function buildRegistry(): Registry {
  const idls = (manifest as { idls: ManifestIdl[] }).idls;
  const anchor = (e: ManifestIdl) => e.format.startsWith("anchor");
  const entries: ProgramEntry[] = idls.map((e) => {
    const root = ROOTS[e.name];
    if (!root) throw new Error(`IDL ${e.name} is in packages/idls/manifest.json but not bundled in the extension`);
    const idl = anchor(e) ? ANCHOR[e.name] : undefined;
    if (anchor(e) && !idl) throw new Error(`Anchor IDL ${e.name} is not bundled in the extension`);
    return { name: e.name, programId: e.programId, root: root as RootNode, ...(idl ? { idl: idl as AnchorIdlJson } : {}) };
  });
  const decoder = createDecoder(entries);
  const squadsAccounts = createSquadsDecoder(rawSquads as unknown as AnchorIdlJson);
  const maps = new Map<string, AuthorityMap>();
  for (const e of idls.filter(anchor))
    maps.set(e.programId, buildAuthorityMap(ANCHOR[e.name] as AnchorIdlJson, { programId: e.programId, source: `packages/idls/raw/${e.name}.json`, verified: e.verified === true }));
  return { decoder, squadsAccounts, authorityMaps: [...maps.values()] };
}

let cached: Registry | null = null;
export function registry(): Registry {
  return (cached ??= buildRegistry());
}
