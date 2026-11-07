// S4 trap scenario end to end on a running localnet. Run with `pnpm --filter @kelvara/scenarios test:e2e`,
// which brings localnet up first if it is not healthy. Fails (never skips) without a validator.
/* global Buffer */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('trap-local end to end: the buy simulates as a normal purchase; the creator then pulls the tokens back', async () => {
  const { setup, attack, readMint, readTokenAccount, BUY_AMOUNT, PRICE_LAMPORTS } = await import('../scripts/trap-local.mjs');
  const { localRpc } = await import('../scripts/lib/tx.mjs');
  const s = await setup();
  const rpc = localRpc(s.rpcUrl);

  const m = await readMint(rpc, s.token.mint);
  assert.equal(m.extensions.permanentDelegate, s.creator);
  assert.equal(m.freezeAuthority, s.creator);
  assert.equal(m.extensions.tokenMetadata.symbol, 'SHINY');
  assert.notEqual(s.creator, s.seller);

  const wire = Buffer.from(readFileSync(new URL('../.localnet/trap/buy.partial.b64', import.meta.url), 'utf8').trim(), 'base64');
  assert.equal(wire[0], 2);
  assert.ok(wire.subarray(1, 65).every((b) => b === 0), 'user signature slot is empty');
  assert.ok(!wire.subarray(65, 129).every((b) => b === 0), 'seller signature present');
  assert.deepEqual(s.buy.missingSignatures, [s.user]);

  const sim = s.buy.simulation;
  assert.equal(sim.err, null);
  assert.equal(sim.tokenDelta[s.userAta], BUY_AMOUNT.toString());
  assert.equal(sim.tokenDelta[s.sellerAta], (-BUY_AMOUNT).toString());
  assert.equal(sim.lamportsDelta[s.seller], PRICE_LAMPORTS);
  assert.ok(sim.lamportsDelta[s.user] < -PRICE_LAMPORTS && sim.lamportsDelta[s.user] > -PRICE_LAMPORTS - 5_000_000);

  const r = await attack();
  assert.equal(r.userAmountAfterBuy, BUY_AMOUNT.toString());
  assert.equal(r.userAmountAfterPull, '0');
  assert.equal(r.userAccountState, 'Frozen');
  const acc = await readTokenAccount(rpc, s.userAta);
  assert.equal(acc.amount, 0n);
  assert.equal(acc.owner, s.user);
});
