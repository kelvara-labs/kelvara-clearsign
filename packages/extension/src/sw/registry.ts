// The engine's program registry, bundled into the service worker (no fetches, no Node APIs).
// Mirrors the CLI's loadRegistry (packages/cli/src/registry.ts): the IDL manifest's Codama roots for the
// decoder, Anchor IDLs as the decoder fallback and as authority maps, the Squads account decoder, and the
// scenarios' demo program IDL (unverified) as an authority map. Built once per worker, on first use.
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
import rawSquads from "../../../idls/raw/squads-v4.json";
import rawDrift from "../../../idls/raw/drift-v2.json";
import marginfi from "../../../scenarios/programs/marginfi_v2.idl.json";

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
  "drift-v2": rootDrift
};
const ANCHOR: Record<string, unknown> = { "squads-v4": rawSquads, "drift-v2": rawDrift };

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
  const demo = buildAuthorityMap(marginfi as unknown as AnchorIdlJson, { source: "packages/scenarios/programs/marginfi_v2.idl.json", verified: false });
  maps.set(demo.programId, demo);
  return { decoder, squadsAccounts, authorityMaps: [...maps.values()] };
}

let cached: Registry | null = null;
export function registry(): Registry {
  return (cached ??= buildRegistry());
}
