#!/usr/bin/env node
// Runs the validator-dependent scenario tests in e2e/. Uses the running localnet when `localnet check`
// passes; otherwise brings up a fresh one first (`localnet up`, ledger reset). Exit code = node --test's.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, up } from './localnet.mjs';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  await check({ quiet: true });
  console.log('[e2e] localnet healthy, reusing it');
} catch (e) {
  console.log(`[e2e] localnet not ready (${e?.message ?? e}); starting a fresh one`);
  await up();
}
const r = spawnSync(process.execPath, ['--test', 'e2e/'], { cwd: PKG, stdio: 'inherit' });
process.exit(r.status ?? 1);
