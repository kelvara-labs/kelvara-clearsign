// S7 scenario:poison-devnet end to end on Helius devnet (spends ~0.011 devnet SOL per run; the rest is returned
// to the payer). Run with `pnpm --filter @kelvara/scenarios test:devnet`. Needs .keys/devnet-payer.json in the
// main checkout and HELIUS_API_KEY in its .env.
/* global Buffer */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DUST, SEND, attack, setup } from '../scripts/poison-devnet.mjs';
import { lookalike } from '../scripts/lib/poison.mjs';

test('poison-devnet: real transfer, ground lookalike, dust, then the 0.5 SOL send really reaches the lookalike', { timeout: 30 * 60_000 }, async () => {
  const s = await setup();
  const m = lookalike(s.lookalike, s.friend);
  assert.equal(m.match, true);
  assert.ok(m.prefix >= 3 && m.suffix >= 2);
  assert.equal(s.dust.lamports, DUST);
  assert.equal(s.send.simulation.err, null);
  assert.equal(s.send.simulation.lamportsDelta[s.lookalike], SEND);
  const wire = Buffer.from(readFileSync(new URL('../.devnet/poison/send.unsigned.b64', import.meta.url), 'utf8').trim(), 'base64');
  assert.equal(wire[0], 1);
  assert.ok(wire.subarray(1, 65).every((b) => b === 0), 'user signature slot is empty');
  const a = await attack();
  assert.equal(a.lookalikeGained, SEND);
});
