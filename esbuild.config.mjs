// Extension bundle: four entry points (main-world hook and isolated bridge as IIFE; service worker and report UI as ESM).
// Run from the repo root or from packages/extension: node ../../esbuild.config.mjs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, "packages/extension");

const common = {
  outdir: path.join(ext, "dist"),
  bundle: true,
  target: "chrome120",
  platform: "browser",
  sourcemap: process.argv.includes("--dev") ? "inline" : false,
  minify: !process.argv.includes("--dev"),
  legalComments: "none",
  logLevel: "info",
  // Production builds of dependencies: drops dev-only message tables (e.g. @solana/errors links).
  define: { "process.env.NODE_ENV": '"production"' },
  // See config/esbuild-shims/json-stable-stringify.mjs: avoids function-bind's Function() in the SW (G10).
  alias: { "json-stable-stringify": path.join(root, "config/esbuild-shims/json-stable-stringify.mjs") }
};

// Content scripts run as classic scripts: IIFE keeps every binding out of the page's globals,
// so a page cannot reassign the hook's functions or the channel name.
await build({
  ...common,
  entryPoints: { hook: path.join(ext, "src/hook.ts"), bridge: path.join(ext, "src/bridge.ts") },
  format: "iife"
});

// Module service worker and report UI.
await build({
  ...common,
  entryPoints: { "service-worker": path.join(ext, "src/service-worker.ts"), ui: path.join(ext, "src/ui.ts") },
  format: "esm"
});
