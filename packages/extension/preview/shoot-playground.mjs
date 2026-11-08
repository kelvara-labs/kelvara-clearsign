/* global window, document, CustomEvent */
// Dev-only: screenshots the devnet playground (static files + mocked /api/scenarios) disconnected and connected.
//   node preview/shoot-playground.mjs <demoDir> <outDir>
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, "../../../tools/selfcheck/package.json"))("@playwright/test");
const demo = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
// Real recorded devnet wallet from fixtures/poison (no invented address).
const poison = JSON.parse(readFileSync(path.resolve(here, "../../../fixtures/poison/manifest.json"), "utf8"));
const account = poison.cases.find((c) => c.network === "devnet").user;
const catalog = [
  { id: "good", title: "A harmless hello", expected: "L0", label: "GOOD · Memo", description: "A plain memo signed by your connected account. Only the network fee would apply if submitted.", account: null },
  { id: "trap", title: "The shiny token trap", expected: "L2", label: "BAD · Token-2022", description: "Buy SHINY: its creator keeps a permanent delegate and freeze authority over your tokens.", account },
  { id: "admin", title: "Q4 fee update", expected: "L3", label: "BAD · Authority hijack", description: "A “Q4 fee update” approves a Squads proposal that transfers program upgrade authority to an attacker.", account },
  { id: "sweep", title: "The airdrop that takes everything", expected: "L4", label: "BAD · Wallet sweep", description: "A claim drains all SOL and both token balances to a non-signing collector, then closes your token accounts.", account },
  { id: "fees", title: "Q4 fee update", expected: "Proposed fee change", label: "FEE · Council vote", description: "Approve a real Token-2022 fee proposal: 25 → 75 basis points (0.25% → 0.75%).", account }
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const files = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const server = createServer((req, res) => {
  if (req.url === "/api/scenarios") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ chain: "solana:devnet", shared: { account, importFile: ".keys/member-a.json" }, scenarios: catalog })); }
  const f = files[req.url];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] }); res.end(readFileSync(path.join(demo, f)));
}).listen(47742, "127.0.0.1");
const browser = await chromium.launch();
for (const [w, h] of [[360, 740], [375, 667], [1280, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto("http://127.0.0.1:47742/");
  await page.waitForTimeout(600);
  const walk = async (tag) => { for (let i = 0; i < 6; i++) { await page.screenshot({ path: path.join(out, `playground-${tag}-slide${i + 1}-${w}.png`) }); if (i < 5) { await page.click("#next"); await page.waitForTimeout(700); } } await page.evaluate(() => document.getElementById("track").scrollTo({ left: 0, behavior: "instant" })); await page.waitForTimeout(300); };
  await walk("disconnected");
  await page.evaluate((address) => {
    const wallet = { name: "Phantom (preview)", features: { "standard:connect": { connect: async () => ({ accounts: [{ address, chains: ["solana:devnet"], features: ["solana:signTransaction"] }] }) }, "solana:signTransaction": { signTransaction: async () => { throw new Error("preview"); } } } };
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api) => api.register(wallet) }));
  }, account);
  await page.selectOption("#wallets", "0");
  await page.click("#connect");
  await page.waitForTimeout(500);
  await walk("connected");
  await page.close();
}
await browser.close();
server.close();
console.log("playground shots ->", out);
