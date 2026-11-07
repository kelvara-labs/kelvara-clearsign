#!/usr/bin/env node
/* global Buffer */
// Tags real executed scenario transactions for the G7 Playwright specs (test-dapp/e2e/README.md, "fixtures"):
//   pnpm --filter @kelvara/scenarios fixtures:e2e
// Reads the signatures the last localnet attacks recorded and stores those exact executed bytes from the running
// validator as kelvara.fixture.tx/v1 fixtures with "e2e": role, then rebuilds fixtures/tx/manifest.json:
//   l3-batch  the Squads approval Member A signed (AdvanceNonce + Memo "Q4 fee update" + proposalApprove),
//             as executed by scenario:admin-local --attack (.localnet/admin/attack.json approvalSignature)
//   l2-trap   the $SHINY buy (user pays 1 SOL, seller sends 50,000 SHINY), as executed by
//             scenario:trap-local --attack (.localnet/trap/attack.json buySignature)
// Both are network "localnet": analyzing them needs that validator's state (the mint, the multisig), so the
// specs must run against the same localnet the scenarios ran on. l4-sweep stays untagged until
// scenario:sweep-devnet exists; benign uses the default mainnet System transfer.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TX_FIXTURES, walkFixtures, writeManifest } from './lib/manifest.mjs';
import { localRpc } from './lib/tx.mjs';
import { parseWireTransaction } from './wire.mjs';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALNET = join(PKG, '.localnet');

const ROLES = [
  {
    role: 'l3-batch',
    dir: 'admin',
    from: (a) => a.approvalSignature,
    program: { slug: 'squads-v4', programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', priority: 'P0', name: 'Squads v4' },
    label: 'scenario:admin-local: Member A approves "Q4 fee update" on a durable nonce (its vault transaction gives the upgrade authority to the attacker); executed on localnet'
  },
  {
    role: 'l2-trap',
    dir: 'trap',
    from: (a) => a.buySignature,
    program: { slug: 'token-2022', programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', priority: 'P0', name: 'Token-2022' },
    label: 'scenario:trap-local: buy 50,000 $SHINY (permanent delegate + freeze authority = creator) for 1 SOL; executed on localnet'
  }
];

const state = JSON.parse(readFileSync(join(LOCALNET, 'state.json'), 'utf8'));
const rpc = localRpc(state.rpcUrl);
let failed = 0;
for (const r of ROLES) {
  const attackPath = join(LOCALNET, r.dir, 'attack.json');
  if (!existsSync(attackPath)) {
    console.log(`[fixtures:e2e] skip ${r.role}: no ${r.dir}/attack.json (run scenario:${r.dir}-local --attack)`);
    continue;
  }
  const sig = r.from(JSON.parse(readFileSync(attackPath, 'utf8')));
  const res = await rpc.call('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!res) {
    console.log(`[fixtures:e2e] FAIL ${r.role}: ${sig} not on this validator (ledger reset?)`);
    failed++;
    continue;
  }
  if (res.meta?.err !== null) throw new Error(`${r.role}: ${sig} failed on chain`);
  const bytes = Buffer.from(res.transaction[0], 'base64');
  const wire = parseWireTransaction(bytes);
  if (wire.signatures[0] !== sig) throw new Error(`${r.role}: first signature ${wire.signatures[0]} != ${sig}`);
  // One fixture per role: drop older ones from previous runs.
  for (const f of walkFixtures()) if (JSON.parse(readFileSync(f, 'utf8')).e2e === r.role && !f.endsWith(`${sig}.json`)) rmSync(f);
  const record = {
    schema: 'kelvara.fixture.tx/v1',
    network: 'localnet',
    signature: sig,
    slot: res.slot,
    blockTime: res.blockTime ?? null,
    fetchedAt: new Date().toISOString(),
    source: 'localnet:getTransaction',
    program: r.program,
    encoding: 'base64',
    transaction: res.transaction[0],
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: res.version ?? 'legacy',
    invocation: 'top-level',
    meta: res.meta,
    label: r.label,
    tags: ['scenario', r.dir],
    e2e: r.role
  };
  const dir = join(TX_FIXTURES, 'localnet', r.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sig}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(`[fixtures:e2e] ${r.role} -> tx/localnet/${r.dir}/${sig}.json`);
}
writeManifest();
if (failed) process.exitCode = 1;
