#!/usr/bin/env node
// Offline check of fixtures/tx: every file matches the manifest, its bytes hash to sha256, the first
// signature equals the file name, legacy/v0 messages parse cleanly, no fixture carries an api key, and
// every program has at least --count fixtures; fixtures/poison re-derived from its recorded calls
// (lib/poison-verify.mjs). Exit 0 = all good. No network.
/* global Buffer */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAMS, DRIFT_REPLAY } from './fixture-programs.mjs';
import { parseWireTransaction } from './wire.mjs';
import { verifyPoisonFixtures } from './lib/poison-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../fixtures');
const i = process.argv.indexOf('--count');
const COUNT = i >= 0 ? Number(process.argv[i + 1]) : 5;
const failures = [];
const fail = (m) => failures.push(m);

const manifest = JSON.parse(readFileSync(join(root, 'tx', 'manifest.json'), 'utf8'));
if (manifest.count !== manifest.fixtures.length) fail('manifest count mismatch');
const perSlug = new Map();
for (const e of manifest.fixtures) {
  const path = join(root, e.path);
  let r;
  try {
    r = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${e.path}: unreadable (${err.message})`);
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  if (/api-key|helius-rpc\.com/i.test(raw)) fail(`${e.path}: contains an RPC URL or api key`);
  if (r.schema !== 'kelvara.fixture.tx/v1') fail(`${e.path}: schema ${r.schema}`);
  const bytes = Buffer.from(r.transaction, 'base64');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== r.sha256 || sha !== e.sha256) fail(`${e.path}: sha256 mismatch`);
  if (basename(path, '.json') !== r.signature || r.signature !== e.signature) fail(`${e.path}: signature/file name mismatch`);
  if (!['legacy', 0, 1].includes(r.version)) fail(`${e.path}: unexpected version ${r.version}`);
  if (!r.meta || !('loadedAddresses' in r.meta || r.version === 'legacy')) fail(`${e.path}: meta.loadedAddresses missing`);
  if (r.meta?.err !== null) fail(`${e.path}: transaction failed on chain`);
  if (r.version !== 1) {
    try {
      const tx = parseWireTransaction(bytes);
      if (tx.signatures[0] !== r.signature) fail(`${e.path}: first signature differs from record`);
      if ((r.version === 0) !== (tx.version === 0)) fail(`${e.path}: version differs from wire bytes`);
      const loaded = r.meta.loadedAddresses ?? { writable: [], readonly: [] };
      const wantLoaded = tx.lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0);
      if (wantLoaded !== loaded.writable.length + loaded.readonly.length) fail(`${e.path}: loadedAddresses count differs from lookups`);
    } catch (err) {
      fail(`${e.path}: wire parse failed (${err.message})`);
    }
  }
  if (!e.path.startsWith('tx/drift-replay/')) perSlug.set(e.slug, (perSlug.get(e.slug) ?? 0) + 1);
}
for (const p of PROGRAMS) {
  const n = perSlug.get(p.slug) ?? 0;
  if (n < COUNT) fail(`${p.slug}: ${n}/${COUNT} fixtures`);
}
for (const r of DRIFT_REPLAY) {
  if (!manifest.fixtures.some((e) => e.path === `tx/drift-replay/${r.signature}.json`)) fail(`drift-replay ${r.role}: missing`);
}
const poison = verifyPoisonFixtures();
for (const f of poison) fail(`poison: ${f}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${failures.length ? 'FAIL' : 'PASS'} fixtures: ${manifest.fixtures.length} checked, ${PROGRAMS.length} programs, ${DRIFT_REPLAY.length} replay txs, poison cases checked`);
process.exitCode = failures.length ? 1 : 0;
