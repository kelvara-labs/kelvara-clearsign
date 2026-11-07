// S7 poisoning: offline tests (no network). The devnet run itself is e2e/poison-devnet.test.mjs.
/* global Buffer */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEND, buildSend, grindPattern } from '../scripts/poison-devnet.mjs';
import { isDust, lookalike } from '../scripts/lib/poison.mjs';
import { b58decode } from '../scripts/lib/tx.mjs';

test('lookalike: at least 5 matching characters across start and end, at least 2 on each side', () => {
  const real = 'Fr3xKq8ZzS7v2bWmD1pQe4nHcYtLuA6gR9jPkM5s9q';
  assert.deepEqual(lookalike('Fr3ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk9q', real), { prefix: 3, suffix: 2, match: true });
  assert.equal(lookalike('Fr3ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmq', real).match, false, '3+1: suffix below 2');
  assert.equal(lookalike('FrABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkm9q', real).match, false, '2+2 = 4 < 5');
  assert.equal(lookalike('FrABCDEFGHJKLMNPQRSTUVWXYZabcdefghijks9q', real).match, true, '2+3 = 5');
  assert.equal(lookalike(real, real).match, false, 'the same address is not a lookalike');
});

test('grind pattern takes the first 3 and last 2 characters of the friend', () => {
  assert.equal(grindPattern('Fr3xKq8ZzS7v2bWmD1pQe4nHcYtLuA6gR9jPkM5s9q'), 'Fr3:9q');
});

test('dust thresholds: SOL up to 0.001, zero-amount tokens, USDC/USDT up to $0.01', () => {
  assert.equal(isDust({ kind: 'sol', amount: '100000' }), true);
  assert.equal(isDust({ kind: 'sol', amount: '1000000' }), true);
  assert.equal(isDust({ kind: 'sol', amount: '1000001' }), false);
  assert.equal(isDust({ kind: 'sol', amount: '0' }), false);
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(isDust({ kind: 'token', amount: '0', mint: 'So11111111111111111111111111111111111111112' }), true);
  assert.equal(isDust({ kind: 'token', amount: '10000', mint: USDC }), true);
  assert.equal(isDust({ kind: 'token', amount: '10001', mint: USDC }), false);
  assert.equal(isDust({ kind: 'token', amount: '1', mint: 'So11111111111111111111111111111111111111112' }), false, 'unpriced token: not dust here');
});

test('the page request: one System transfer of 0.5 SOL, fee payer user, one empty signature slot', () => {
  const user = '11111111111111111111111111111112';
  const to = '11111111111111111111111111111113';
  const { compiled, wire } = buildSend({ user, to, recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' });
  assert.deepEqual(compiled.signers, [user]);
  assert.equal(wire[0], 1);
  assert.ok(wire.subarray(1, 65).every((b) => b === 0));
  const msg = wire.subarray(65);
  assert.deepEqual([...msg.subarray(0, 3)], [1, 0, 1]); // 1 signer, 0 ro signed, 1 ro unsigned (System)
  assert.deepEqual(msg.subarray(4, 36), Buffer.from(b58decode(user)));
  const data = msg.subarray(msg.length - 12);
  assert.equal(data.readUInt32LE(0), 2);
  assert.equal(data.readBigUInt64LE(4), BigInt(SEND));
});

test('poison fixtures: >= 5 mainnet poisonings and >= 20 first sends, every claim re-derived from recorded calls', async () => {
  const { verifyPoisonFixtures } = await import('../scripts/lib/poison-verify.mjs');
  assert.deepEqual(verifyPoisonFixtures(), []);
});
