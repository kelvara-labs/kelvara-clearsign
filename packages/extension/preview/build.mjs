// Dev-only preview harness (never shipped: lives outside static/ and dist/).
//   node preview/build.mjs [outDir]   builds the real UI bundle + static pages + preview pages into outDir
//   node preview/serve.mjs [outDir]   serves it; open /host.html?case=L3, /popup.html?state=ready, /options.html
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const out = path.resolve(process.argv[2] ?? "/tmp/signguard-design/site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({ entryPoints: { ui: path.join(pkg, "src/ui.ts") }, outdir: out, bundle: true, format: "esm", target: "chrome120", platform: "browser", minify: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' }, alias: { "json-stable-stringify": path.resolve(pkg, "../../config/esbuild-shims/json-stable-stringify.mjs") } });
cpSync(path.join(pkg, "static"), out, { recursive: true });

const gen = path.join(here, ".gen.mjs");
await build({ entryPoints: [path.join(here, "gen-data.ts")], outfile: gen, bundle: true, platform: "node", format: "esm", logLevel: "error", banner: { js: "/* eslint-disable */\nimport{createRequire}from'module';const require=createRequire(import.meta.url);" } });
execFileSync("node", [gen, path.join(out, "verdicts.json")], { cwd: pkg, stdio: "inherit" });

cpSync(path.join(here, "page"), out, { recursive: true });
for (const f of ["popup.html", "options.html", "report.html"]) {
  const html = readFileSync(path.join(out, f), "utf8").replace('<script type="module" src="ui.js">', '<script src="stub.js"></script><script type="module" src="ui.js">');
  writeFileSync(path.join(out, f), html);
}
console.log("preview ->", out);
