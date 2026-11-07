#!/usr/bin/env node
/* global Buffer */
// G7 localnet cases (task S12): fresh admin-local (L3), trap-local (L2) and sweep-local (L4) setups on the running
// localnet, no attack, as one machine-readable file for the e2e specs.
//   pnpm --filter @kelvara/scenarios scenario:e2e-cases            set up, write .localnet/e2e-cases.json
//   ... --json      also print the object on stdout (logs go to stderr)
//   ... --verify    also run `kelvara analyze --network localnet --wallet <signer> --inventory` on each case and
//                   fail unless the level is the expected one
//   ... --serve     after setup, serve http://127.0.0.1:8784: GET /cases (whole object) and GET /cases/<role>;
//                   trap and sweep are rebuilt on a fresh blockhash per request (same accounts and signers, the
//                   seller re-signs the buy), admin is the fixed durable-nonce approval
//   ... --no-setup  reuse the last setups (with --serve or --verify)
//   ... --with-ata-sweep  add case l4-sweep-ata: the realistic S9 sweep shape (ATA create + close). Opt-in until
//                   engine E16 makes wallet.sweep prove it; today it analyzes as L1.
// Localnet: reused when `localnet check` passes, else a fresh `localnet up` (S10 takeover of a foreign validator).
// Shape (agreed with verifier V10): {network, rpcUrl, createdAt, cases: [{role, scenario, expectLevel, tx, signer,
// file, recentBlockhash, lastValidBlockHeight?}]}. tx is the base64 wire tx, unsigned or partially signed;
// signer is the pubkey the test wallet must present. Public data only: never a key.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '../..');
const LOCAL = join(PKG, '.localnet');
export const OUT = join(LOCAL, 'e2e-cases.json');
export const PORT = 8784;
export const ROLES = ['l3-admin', 'l2-trap', 'l4-sweep'];

const readB64 = (rel) => readFileSync(join(REPO, rel), 'utf8').trim();
const readScenario = (dir) => JSON.parse(readFileSync(join(LOCAL, dir, 'scenario.json'), 'utf8'));

/** Pure: the case list from the three scenario.json objects and their wire txs (base64). */
export function buildCases({ admin, trap, sweep }, wires, createdAt = new Date().toISOString(), { withAtaSweep = false } = {}) {
  const rpcUrl = admin.rpcUrl;
  if (trap.rpcUrl !== rpcUrl || sweep.rpcUrl !== rpcUrl) throw new Error('scenarios were set up on different RPCs');
  if (withAtaSweep && !sweep.ataSweep) throw new Error('sweep setup has no ataSweep; run sweep-local setup again');
  for (const [name, w] of Object.entries(wires)) {
    const bytes = Buffer.from(w ?? '', 'base64');
    if (!bytes.length || bytes.length < 1 + 64 * bytes[0] + 3) throw new Error(`${name}: not a wire tx`);
  }
  return {
    network: 'localnet',
    rpcUrl,
    createdAt,
    cases: [
      { role: 'l3-admin', scenario: 'admin-local', expectLevel: 'L3', tx: wires.admin, signer: admin.approval.feePayer, file: admin.approval.file, recentBlockhash: admin.nonce.value, durableNonce: admin.nonce.account },
      { role: 'l2-trap', scenario: 'trap-local', expectLevel: 'L2', tx: wires.trap, signer: trap.buy.feePayer, file: trap.buy.file, recentBlockhash: trap.buy.recentBlockhash, lastValidBlockHeight: trap.buy.lastValidBlockHeight },
      { role: 'l4-sweep', scenario: 'sweep-local', expectLevel: 'L4', tx: wires.sweep, signer: sweep.sweep.feePayer, file: sweep.sweep.file, recentBlockhash: sweep.sweep.recentBlockhash, lastValidBlockHeight: sweep.sweep.lastValidBlockHeight },
      ...(withAtaSweep
        ? [{ role: 'l4-sweep-ata', scenario: 'sweep-local', expectLevel: 'L4', tx: wires.sweepAta, signer: sweep.ataSweep.feePayer, file: sweep.ataSweep.file, recentBlockhash: sweep.ataSweep.recentBlockhash, lastValidBlockHeight: sweep.ataSweep.lastValidBlockHeight }]
        : [])
    ]
  };
}

function fromDisk(opts) {
  const admin = readScenario('admin'), trap = readScenario('trap'), sweep = readScenario('sweep');
  const wires = { admin: readB64(admin.approval.file), trap: readB64(trap.buy.file), sweep: readB64(sweep.sweep.file) };
  if (opts.withAtaSweep) wires.sweepAta = readB64(sweep.ataSweep.file);
  return buildCases({ admin, trap, sweep }, wires, undefined, opts);
}

/** Same cases with trap and sweep rebuilt on a fresh blockhash (for long-running specs). */
async function freshCases(opts) {
  const { localRpc, readKeypair } = await import('./lib/tx.mjs');
  const trapMod = await import('./trap-local.mjs');
  const sweepMod = await import('./sweep-local.mjs');
  const admin = readScenario('admin'), trap = readScenario('trap'), sweep = readScenario('sweep');
  const rpc = localRpc(admin.rpcUrl);
  const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const seller = readKeypair(join(REPO, trap.keyFiles['trap-seller']));
  const buy = trapMod.partialSign(trapMod.buildBuy({ user: trap.user, seller: trap.seller, mint: trap.token.mint, recentBlockhash: bh.blockhash }).compiled, seller);
  const sw = await sweepMod.freshSweep(sweep, rpc);
  trap.buy = { ...trap.buy, recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
  sweep.sweep = { ...sweep.sweep, recentBlockhash: sw.recentBlockhash, lastValidBlockHeight: sw.lastValidBlockHeight };
  const wires = { admin: readB64(admin.approval.file), trap: buy.toString('base64'), sweep: sw.wire.toString('base64') };
  if (opts.withAtaSweep) {
    const ata = await sweepMod.freshSweep(sweep, rpc, { ata: true });
    sweep.ataSweep = { ...sweep.ataSweep, recentBlockhash: ata.recentBlockhash, lastValidBlockHeight: ata.lastValidBlockHeight };
    wires.sweepAta = ata.wire.toString('base64');
  }
  return buildCases({ admin, trap, sweep }, wires, undefined, opts);
}

async function setupAll() {
  const { check, up } = await import('./localnet.mjs');
  try {
    await check({ quiet: true });
    console.log('[e2e-cases] localnet healthy, reusing it');
  } catch (e) {
    console.log(`[e2e-cases] localnet not ready (${e?.message ?? e}); starting a fresh one`);
    await up();
  }
  await (await import('./admin-local.mjs')).setup();
  await (await import('./trap-local.mjs')).setup();
  await (await import('./sweep-local.mjs')).setup();
}

export function verify(cases) {
  const cli = join(REPO, 'packages', 'cli', 'dist', 'kelvara.mjs');
  const bad = [];
  for (const c of cases.cases) {
    const r = spawnSync(process.execPath, [cli, 'analyze', '--network', 'localnet', '--wallet', c.signer, '--inventory', '--json', '--tx', c.tx], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
    let level = `exit ${r.status}`, rules = '';
    try {
      const out = JSON.parse(r.stdout);
      level = out.alertLevel;
      rules = out.report.claims.map((x) => `${x.ruleId}:${x.level}`).join(', ');
    } catch { /* level stays the exit status */ }
    console.log(`[e2e-cases] ${c.role} ${level === c.expectLevel ? 'ok ' : 'BAD'} ${level} (expected ${c.expectLevel}) ${rules}`);
    if (level !== c.expectLevel) bad.push(`${c.role}: ${level}, expected ${c.expectLevel}`);
  }
  if (bad.length) throw new Error(bad.join('; '));
}

export function serve(port = PORT, opts = {}) {
  const server = createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    const host = (req.headers.host ?? '').split(':')[0];
    if (req.method !== 'GET' || !['127.0.0.1', 'localhost'].includes(host)) return reply(405, { error: 'GET from 127.0.0.1 only' });
    const m = /^\/cases(?:\/([a-z0-9-]+))?\/?$/.exec(new URL(req.url, 'http://x').pathname);
    if (!m) return reply(404, { error: 'GET /cases or /cases/<role>' });
    try {
      const all = await freshCases(opts);
      if (!m[1]) return reply(200, all);
      const one = all.cases.find((c) => c.role === m[1]);
      return one ? reply(200, { network: all.network, rpcUrl: all.rpcUrl, createdAt: all.createdAt, ...one }) : reply(404, { error: `roles: ${ROLES.join(', ')}` });
    } catch (e) {
      return reply(500, { error: String(e?.message ?? e) });
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = ['--json', '--verify', '--serve', '--no-setup', '--with-ata-sweep'];
  const opts = { withAtaSweep: args.includes('--with-ata-sweep') };
  const json = args.includes('--json');
  if (json) console.log = (...a) => console.error(...a); // stdout carries only the JSON
  try {
    const unknown = args.filter((a) => !known.includes(a));
    if (unknown.length) throw new Error('unknown options: ' + unknown.join(' '));
    if (!args.includes('--no-setup')) await setupAll();
    const cases = fromDisk(opts);
    writeFileSync(OUT, JSON.stringify(cases, null, 2) + '\n');
    console.log(`[e2e-cases] ${cases.cases.map((c) => `${c.role} signer ${c.signer}`).join('; ')} -> packages/scenarios/.localnet/e2e-cases.json`);
    if (args.includes('--verify')) verify(cases);
    if (json) process.stdout.write(JSON.stringify(cases) + '\n');
    if (args.includes('--serve')) {
      await serve(PORT, opts);
      console.log(`[e2e-cases] serving http://127.0.0.1:${PORT}/cases (fresh blockhash per request); Ctrl-C to stop`);
    } else process.exit(0);
  } catch (e) {
    console.error(`[e2e-cases] FAIL ${e?.message ?? e}`);
    process.exit(1);
  }
}
