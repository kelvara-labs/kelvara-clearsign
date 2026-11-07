// S3 admin scenario end to end on a running localnet. Run with `pnpm --filter @kelvara/scenarios test:e2e`,
// which brings localnet up first if it is not healthy. Fails (never skips) without a validator.
/* global Buffer */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { b58decode } from '../scripts/lib/tx.mjs';

test('admin-local end to end: approval is a durable-nonce approve that moves nothing; the attack changes the upgrade authority', async () => {
  const { setup, attack, readUpgradeAuthority, MEMO } = await import('../scripts/admin-local.mjs');
  const { localRpc } = await import('../scripts/lib/tx.mjs');
  const s = await setup();
  const rpc = localRpc(s.rpcUrl);
  assert.equal((await readUpgradeAuthority(rpc, s.demoProgram)).authority, s.vault);
  assert.equal(s.threshold, 2);
  assert.equal(s.timeLock, 0);
  assert.notEqual(s.nonce.funder, s.members.A);
  assert.deepEqual(s.approval.signers, [s.members.A]);

  const wire = Buffer.from(readFileSync(new URL('../.localnet/admin/approval.unsigned.b64', import.meta.url), 'utf8').trim(), 'base64');
  assert.equal(wire[0], 1);
  assert.ok(wire.subarray(1, 65).every((b) => b === 0), 'signature slot is empty');
  assert.ok(wire.includes(Buffer.from(MEMO)), 'memo text in the approval');
  assert.ok(wire.includes(Buffer.from(b58decode(s.nonce.value))), 'recent blockhash is the nonce value');
  // Simulation: only Member A's fee leaves; vault and outsider unchanged.
  const delta = s.approval.simulation.lamportsDelta;
  assert.equal(delta[s.vault], 0);
  assert.equal(delta[s.outsider], 0);
  assert.ok(delta[s.members.A] < 0 && delta[s.members.A] >= -10_000);

  const r = await attack();
  assert.equal(r.upgradeAuthorityAfter, s.attacker);
  assert.equal((await readUpgradeAuthority(rpc, s.demoProgram)).authority, s.attacker);
});
