// Build and serve the test dApp on localhost (content scripts do not run on file://).
//   node test-dapp/scripts/serve.mjs [--port 5174] [--host 127.0.0.1] [--build-only]
// Also serves fixtures/ read-only at /fixtures/ so specs can fetch real transaction bytes.
// No network beyond the loopback listener.
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, copyFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dappRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(dappRoot, "..");
const dist = path.join(dappRoot, "dist");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const port = Number(arg("--port", process.env.TEST_DAPP_PORT ?? "5174"));
const host = arg("--host", "127.0.0.1");

export async function buildDapp() {
  await mkdir(dist, { recursive: true });
  await build({
    entryPoints: [path.join(dappRoot, "src/app.ts")],
    outfile: path.join(dist, "app.js"),
    bundle: true,
    format: "iife",
    target: "chrome120",
    platform: "browser",
    sourcemap: "inline",
    logLevel: "warning"
  });
  await copyFile(path.join(dappRoot, "static/index.html"), path.join(dist, "index.html"));
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream" };

function resolveSafe(base, rel) {
  const p = path.resolve(base, "." + rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

await buildDapp();
if (process.argv.includes("--build-only")) process.exit(0);

const fixtures = path.join(repoRoot, "fixtures");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let file;
    if (url.pathname.startsWith("/fixtures/")) file = resolveSafe(fixtures, url.pathname.slice("/fixtures".length));
    else file = resolveSafe(dist, url.pathname === "/" ? "/index.html" : url.pathname);
    if (!file || !(await stat(file)).isFile()) throw new Error("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});
server.listen(port, host, () => console.log(`test dApp: http://${host}:${port}/`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
