// S9 scenario:sweep-devnet end to end on Helius devnet: setup, then the user really signs the "claim airdrop"
// sweep; the executed tx becomes the l4-sweep e2e fixture and everything returns to the payer (~0.00002 devnet
// SOL per run after the first). Run with `pnpm --filter @kelvara/scenarios test:devnet`. Needs
// .keys/devnet-payer.json in the main checkout and HELIUS_API_KEY in its .env.
/* global Buffer */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OUT, attack, setup } from '../scripts/sweep-devnet.mjs';
import { REPO } from '../scripts/lib/devnet.mjs';

test('sweep-devnet: the claim-airdrop tx drains every lamport and token of the user to a non-signer', { timeout: 10 * 60_000 }, async () => {
  const s = await setup();
  assert.equal(s.sweep.simulation.err, null);
  assert.equal(s.sweep.signers.length, 1);
  assert.equal(s.sweep.signers[0], s.user);
  assert.ok(!s.sweep.signers.includes(s.collector));
  assert.equal(s.tokens.length, 2);
  const wire = Buffer.from(readFileSync(join(OUT, 'sweep.unsigned.b64'), 'utf8').trim(), 'base64');
  assert.ok(wire.subarray(1, 65).every((b) => b === 0), 'user signature slot is empty');
  const a = await attack();
  assert.equal(a.userLamportsAfter, 0);
  assert.deepEqual(a.tokens.map((t) => t.collector), s.tokens.map((t) => t.amount));
  const f = JSON.parse(readFileSync(join(REPO, a.fixture), 'utf8'));
  assert.equal(f.e2e, 'l4-sweep');
  assert.equal(f.network, 'devnet');
  assert.equal(f.signature, a.sweepSignature);
});
