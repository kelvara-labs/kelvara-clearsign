// Copy static assets (manifest, pages) into dist/, the unpacked extension root.
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
cpSync(path.join(pkg, "static"), path.join(pkg, "dist"), { recursive: true });
console.log("static -> dist");
