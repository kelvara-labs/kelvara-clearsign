#!/usr/bin/env node
/* global Buffer */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b58decode, b58encode, compileLegacy, readKeypair } from './lib/tx.mjs';
import { heliusDevnet, redact } from './lib/helius.mjs';
import { KEYS, PKG, REPO } from './lib/devnet.mjs';
import { buildBuy, partialSign } from './trap-local.mjs';
import { SHARED_STATE, sharedAccount } from './demo-prepare.mjs';
import { currentSweep, unsignedWire } from './sweep-devnet.mjs';
import { FEE_STATE, feeApproval } from './demo-prepare-fees.mjs';
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../demo');
export function validateAccount(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error('Invalid wallet address');
  const bytes = b58decode(value);
  if (bytes.length !== 32 || b58encode(bytes) !== value) throw new Error('Invalid wallet address');
  return value;
}
export function createPlayground({ catalog, transaction, shared }) {
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    const origins = hosts.map(h => `http://${h}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || !hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin)) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return reply(403, { error: 'Local same-origin GET requests only' });
    const staticRoutes = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (staticRoutes[req.url]) {
      const [file, type] = staticRoutes[req.url];
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); res.end(readFileSync(join(assets, file))); return;
    }
    if (req.url === '/api/scenarios') return reply(200, { chain: 'solana:devnet', shared, scenarios: catalog });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/transaction') return reply(404, { error: 'Not found' });
    const kind = url.searchParams.get('kind');
    const entry = catalog.find(c => c.id === kind);
    if (!entry) return reply(404, { error: 'Unknown scenario' });
    if ([...url.searchParams.keys()].length !== 2 || !url.searchParams.has('account')) return reply(400, { error: 'Expected kind and account only' });
    let account;
    try { account = validateAccount(url.searchParams.get('account')); } catch { return reply(400, { error: 'Invalid wallet address' }); }
    if (entry.account && entry.account !== account) return reply(409, { error: `Select required devnet account: ${entry.account}` });
    try { return reply(200, { chain: 'solana:devnet', account, expected: entry.expected, ...await transaction(kind, account) }); }
    catch (e) { console.error('[demo] transaction unavailable:', redact(e?.message ?? e)); return reply(503, { error: 'Pre-attack transaction unavailable. Check server log and scenario state; no transaction was submitted.' }); }
  });
  return server;
}
export async function loadPlayground() {
  const read = kind => JSON.parse(readFileSync(join(PKG, '.devnet', kind, 'scenario.json')));
  const admin = read('admin'), trap = read('trap');
  const shared = JSON.parse(readFileSync(SHARED_STATE));
  if (sharedAccount(admin, readKeypair(join(KEYS, 'member-a.json'))) !== shared.account) throw new Error('Run demo:prepare for current Member A');
  const rpc = await heliusDevnet(REPO);
  const catalog = [
    { id: 'good', title: 'A harmless hello', expected: 'L0', label: 'GOOD · Memo', description: 'A plain memo signed by your connected account. Only the network fee would apply if submitted.', account: null },
    { id: 'trap', title: 'The shiny token trap', expected: 'L2', label: 'BAD · Token-2022', description: 'Buy SHINY: its creator keeps a permanent delegate and freeze authority over your tokens.', account: shared.account },
    { id: 'admin', title: 'Q4 fee update', expected: 'L3', label: 'BAD · Authority hijack', description: 'A “Q4 fee update” approves a Squads proposal that transfers program upgrade authority to an attacker.', account: shared.account },
    { id: 'sweep', title: 'The airdrop that takes everything', expected: 'L4', label: 'BAD · Wallet sweep', description: 'A claim drains all SOL and both token balances to a non-signing collector, then closes your token accounts.', account: shared.account }
  ];
  const fees = existsSync(FEE_STATE) ? JSON.parse(readFileSync(FEE_STATE)) : null;
  if (fees) catalog.push({ id: 'fees', title: 'Q4 fee update', expected: 'Proposed fee change', label: 'FEE · Council vote', description: 'Approve a real Token-2022 fee proposal: 25 → 75 basis points (0.25% → 0.75%); maximum 1 → 2 tokens (6 decimals). Execution schedules activation two epochs later; approval does not execute it.', account: shared.account });
  const transaction = async (kind, account) => {
    if (kind === 'admin') return { transaction: readFileSync(join(PKG, '.devnet/admin/approval.unsigned.b64'), 'utf8').trim(), durableNonce: admin.nonce.account };
    const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    let wire;
    if (kind === 'fees' && fees) wire = feeApproval(fees, bh.blockhash);
    else if (kind === 'good') {
      const compiled = compileLegacy({ feePayer: account, recentBlockhash: bh.blockhash, instructions: [{ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', keys: [{ pubkey: account, isSigner: true, isWritable: false }], data: Buffer.from('Hello from ClearSign devnet playground') }] });
      wire = unsignedWire(compiled);
    } else if (kind === 'trap') wire = partialSign(buildBuy({ user: shared.account, seller: trap.seller, mint: trap.token.mint, recentBlockhash: bh.blockhash }).compiled, readKeypair(join(KEYS, 'trap-seller.json')));
    else if (kind === 'sweep') {
      const sw = await currentSweep(rpc, { user: shared.account, collector: shared.collector, mints: shared.mints });
      return { transaction: sw.wire.toString('base64'), recentBlockhash: sw.recentBlockhash, lastValidBlockHeight: sw.lastValidBlockHeight };
    } else throw new Error('Unknown scenario');
    return { transaction: wire.toString('base64'), recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
  };
  return { catalog, transaction, shared };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = createPlayground(await loadPlayground());
    server.on('error', e => { console.error(`[demo] ${e.code ?? 'server error'}`); process.exitCode = 1; });
    const port = Number(process.env.PORT) || 47731;
    server.listen(port, '127.0.0.1', () => console.log(`[demo] http://localhost:${port} · devnet · signTransaction only · pid ${process.pid} · cwd ${process.cwd()}`));
  } catch { console.error('[demo] Missing devnet setup; prepare admin, trap and sweep before starting.'); process.exitCode = 1; }
}
