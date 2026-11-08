import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.argv[2] ?? "/tmp/signguard-design/site");
const port = Number(process.argv[3] ?? 47740);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
createServer(async (req, res) => {
  const p = path.join(root, new URL(req.url, "http://x").pathname.replace(/\.\./g, ""));
  try { const b = await readFile(p); res.writeHead(200, { "content-type": types[path.extname(p)] ?? "text/plain" }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1", () => console.log(`preview http://127.0.0.1:${port}`));
