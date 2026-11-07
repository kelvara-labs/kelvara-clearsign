// IDL path for the evidence explorer: which bundled IDL file decoded an instruction. Reads only
// E12's manifest (packages/idls/manifest.json), the same list registry.ts bundles, so it stays small.
import manifest from "../../../idls/manifest.json";

interface ManifestIdl {
  name: string;
  programId: string;
  format: string;
}

const BY_PROGRAM = new Map((manifest as { idls: ManifestIdl[] }).idls.map((e) => [e.programId, e]));

/**
 * Repo path of the IDL behind a decoded instruction: the Codama root for "codama", the Anchor IDL for
 * "anchor-fallback", a fixed label for the built-in decoders, null when nothing decoded it.
 */
export function idlPathFor(programId: string | null, decoder: string | null): string | null {
  if (decoder === "builtin") return "built-in decoder (packages/core)";
  if (!programId || (decoder !== "codama" && decoder !== "anchor-fallback")) return null;
  const e = BY_PROGRAM.get(programId);
  if (!e) return null;
  return decoder === "codama" ? `packages/idls/roots/${e.name}.json` : `packages/idls/raw/${e.name}.json`;
}
