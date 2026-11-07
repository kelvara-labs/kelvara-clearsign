// Release zip: dist/kelvara-signguard.zip, the Chrome Web Store upload (manifest.json at the zip root).
// Clean production build of packages/extension (no sourcemaps, no key: the extension only reads the key from
// its options page; PLAN 1a), then a reproducible zip: sorted entries, fixed mtimes, no extra attributes.
// G10 then checks the zip (hosts, eval, permissions, no API key).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "packages/extension");
const extDist = path.join(ext, "dist");
const out = path.join(root, "dist/kelvara-signguard.zip");

rmSync(extDist, { recursive: true, force: true });
execFileSync("pnpm", ["--filter", "@kelvara/extension", "build"], { cwd: root, stdio: "inherit" });

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(path.relative(extDist, p));
  }
})(extDist);
const bad = files.filter((f) => /\.map$|(^|\/)\.env|\.pem$|\.key$|keypair/i.test(f));
if (bad.length) throw new Error(`refusing to package: ${bad.join(", ")}`);
if (!files.includes("manifest.json")) throw new Error("no manifest.json in packages/extension/dist");

const fixed = new Date("2026-01-01T00:00:00Z");
for (const f of files) utimesSync(path.join(extDist, f), fixed, fixed);
mkdirSync(path.dirname(out), { recursive: true });
if (existsSync(out)) rmSync(out);
execFileSync("zip", ["-X", "-q", "-D", out, ...files], { cwd: extDist, stdio: "inherit" });
console.log(`release: ${path.relative(root, out)} (${files.length} files, ${statSync(out).size} bytes)`);
