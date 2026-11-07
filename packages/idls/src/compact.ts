// Compact Codama roots (M7 / E17): roots/<name>.json is what the decoder and the extension bundle read,
// so it carries only what decoding and the capability/authority maps use. Dropped: every `docs` field
// (human text on every node), and the program-level `errors` and `events` lists (error codes and
// emitted-event layouts, never parsed from instruction bytes). All three are optional in Codama's node
// types. The full text stays in raw/<name>.json (pinned, hashed). compact-roots.test.ts proves the
// compact roots decode, map and analyze exactly like the full conversion.
import type { RootNode } from "@codama/nodes";

/** Program-level fields that instruction decoding never reads. */
export const COMPACT_DROPPED_PROGRAM_FIELDS = ["errors", "events"] as const;

const stripDocs = (_key: string, value: unknown): unknown => {
  if (value && typeof value === "object" && !Array.isArray(value) && "docs" in value) {
    const { docs, ...rest } = value as { docs?: unknown };
    if (docs !== undefined && !(Array.isArray(docs) && docs.every((d) => typeof d === "string"))) throw new Error("compactRoot: a docs field that is not a string list");
    return rest;
  }
  return value;
};

/** The root without docs, errors and events (a new object; the input is not changed). */
export function compactRoot(root: RootNode): RootNode {
  const out = JSON.parse(JSON.stringify(root, stripDocs)) as { program: Record<string, unknown>; additionalPrograms?: Record<string, unknown>[] };
  for (const program of [out.program, ...(out.additionalPrograms ?? [])]) for (const f of COMPACT_DROPPED_PROGRAM_FIELDS) delete program[f];
  return out as unknown as RootNode;
}
