// Extension bundle: four entry points (main-world hook, isolated bridge, service worker, report UI).
// Run from the repo root or from packages/extension: node ../../esbuild.config.mjs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, "packages/extension");

await build({
  entryPoints: {
    hook: path.join(ext, "src/hook.ts"),
    bridge: path.join(ext, "src/bridge.ts"),
    "service-worker": path.join(ext, "src/service-worker.ts"),
    ui: path.join(ext, "src/ui.ts")
  },
  outdir: path.join(ext, "dist"),
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  sourcemap: process.argv.includes("--dev") ? "inline" : false,
  minify: !process.argv.includes("--dev"),
  legalComments: "none",
  logLevel: "info"
});
