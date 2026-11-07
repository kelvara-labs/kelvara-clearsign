// Live Helius devnet only: requires the main checkout's funded devnet payer.
// These tests spend devnet SOL. Wallet prompts remain human-only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../scripts/devnet-scenario.mjs';
import { PKG } from '../scripts/lib/devnet.mjs';

test('admin-devnet: real Squads nonce approval and upgrade authority takeover', { timeout: 15 * 60_000 }, async () => {
  const result = await run('admin', ['--reset', '--attack']);
  const s = JSON.parse(readFileSync(join(PKG, '.devnet/admin/scenario.json')));
  assert.equal(s.chain, 'solana:devnet');
  assert.equal(s.threshold, 2);
  assert.equal(s.timeLock, 0);
  assert.equal(s.nonce.authority, s.members.A);
  assert.notEqual(s.nonce.funder, s.members.A);
  assert.equal(s.approval.simulation.err, null);
  assert.equal(s.approval.simulation.lamportsDelta[s.vault], 0);
  assert.equal(result.upgradeAuthorityAfter, s.attacker);
});

test('trap-devnet: purchase then delegate reclaims and freezes without buyer', { timeout: 5 * 60_000 }, async () => {
  const result = await run('trap', ['--reset', '--attack']);
  const s = JSON.parse(readFileSync(join(PKG, '.devnet/trap/scenario.json')));
  assert.equal(s.chain, 'solana:devnet');
  assert.equal(s.token.permanentDelegate, s.creator);
  assert.equal(s.token.freezeAuthority, s.creator);
  assert.equal(s.buy.simulation.tokenDelta[s.userAta], s.buy.amount);
  assert.equal(result.userAmountAfterBuy, s.buy.amount);
  assert.equal(result.userAmountAfterPull, '0');
  assert.equal(result.userAccountState, 'Frozen');
});
