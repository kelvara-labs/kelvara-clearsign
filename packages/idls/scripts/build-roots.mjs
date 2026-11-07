#!/usr/bin/env node
// Convert every pinned IDL in raw/ to a Codama root node in roots/ (offline).
// Codama roots are copied as is; Anchor IDLs go through rootNodeFromAnchor.
// A failed conversion is recorded in roots/index.json as decoder "anchor-fallback",
// and the engine then uses its built-in Anchor decoder for that program.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(pkgDir, "manifest.json"), "utf8"));
const outDir = path.join(pkgDir, "roots");
mkdirSync(outDir, { recursive: true });

const index = [];
for (const m of manifest.idls) {
  const raw = JSON.parse(readFileSync(path.join(pkgDir, "raw", `${m.name}.json`), "utf8"));
  let root;
  let error;
  try {
    root = m.format === "codama" ? raw : rootNodeFromAnchor(raw);
    if (root?.kind !== "rootNode") throw new Error("conversion did not return a rootNode");
    if (root.program.publicKey !== m.programId) {
      // Anchor legacy IDLs often omit metadata.address; pin the program id from the manifest.
      root = { ...root, program: { ...root.program, publicKey: m.programId } };
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  if (root && !error) {
    writeFileSync(path.join(outDir, `${m.name}.json`), JSON.stringify(root) + "\n");
    index.push({ name: m.name, programId: m.programId, decoder: "codama", instructions: root.program.instructions.length });
  } else {
    index.push({ name: m.name, programId: m.programId, decoder: "anchor-fallback", error });
  }
  console.log(`${m.name.padEnd(11)} ${index.at(-1).decoder}${error ? `: ${error}` : ` (${index.at(-1).instructions} instructions)`}`);
}
writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
