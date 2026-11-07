// S12, offline: the G7 localnet case list and the plain sweep shape. No validator, no network.
/* global Buffer */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCases, ROLES } from '../scripts/e2e-cases.mjs';
import { buildSweep } from '../scripts/sweep-devnet.mjs';
import { TOKEN_2022 } from '../scripts/lib/token2022.mjs';
import { SYSTEM_PROGRAM } from '../scripts/lib/tx.mjs';
import { parseWireTransaction } from '../scripts/wire.mjs';

const user = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
const collector = '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
const tokens = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amount: 1_250_000_000n },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 9, amount: 4_200_000_000_000_000n }
];
const recentBlockhash = '11111111111111111111111111111111';

test('plain sweep (sweep-local): only TransferChecked per token + one System Transfer of every lamport but the fee', () => {
  const lamports = 2_000_000_000, fee = 5000;
  const { compiled, wire, sol } = buildSweep({ user, collector, tokens, lamports, fee, ataRent: 2_074_080, recentBlockhash, plain: true });
  assert.equal(sol, lamports - fee, 'no ATA rent: the collector ATAs already exist');
  assert.deepEqual(compiled.signers, [user]);
  const tx = parseWireTransaction(wire);
  const keys = tx.staticAccountKeys;
  assert.deepEqual(tx.instructions.map((i) => keys[i.programIdIndex]), [TOKEN_2022, TOKEN_2022, SYSTEM_PROGRAM]);
  assert.ok(tx.instructions.slice(0, 2).every((i) => Buffer.from(i.data)[0] === 12), 'TransferChecked');
});

test('e2e cases: agreed shape, one case per role, signer = fee payer, no key material', () => {
  const sweepWire = buildSweep({ user, collector, tokens, lamports: 2e9, fee: 5000, ataRent: 0, recentBlockhash, plain: true }).wire.toString('base64');
  const rpcUrl = 'http://127.0.0.1:8899';
  const admin = { rpcUrl, approval: { feePayer: 'A1', file: 'packages/scenarios/.localnet/admin/approval.unsigned.b64' }, nonce: { account: 'N1', value: 'BH1' } };
  const trap = { rpcUrl, buy: { feePayer: 'U2', file: 'packages/scenarios/.localnet/trap/buy.partial.b64', recentBlockhash: 'BH2', lastValidBlockHeight: 7 } };
  const sweep = { rpcUrl, sweep: { feePayer: user, file: 'packages/scenarios/.localnet/sweep/sweep.unsigned.b64', recentBlockhash, lastValidBlockHeight: 9 } };
  const out = buildCases({ admin, trap, sweep }, { admin: sweepWire, trap: sweepWire, sweep: sweepWire }, 'T');
  assert.deepEqual(Object.keys(out), ['network', 'rpcUrl', 'createdAt', 'cases']);
  assert.equal(out.network, 'localnet');
  assert.deepEqual(out.cases.map((c) => c.role), ROLES);
  assert.deepEqual(out.cases.map((c) => c.expectLevel), ['L3', 'L2', 'L4']);
  assert.deepEqual(out.cases.map((c) => c.signer), ['A1', 'U2', user]);
  for (const c of out.cases) for (const k of ['role', 'scenario', 'expectLevel', 'tx', 'signer', 'file']) assert.ok(c[k], `${c.role}.${k}`);
  assert.doesNotMatch(JSON.stringify(out), /secret|keyFiles|\.keys\//i);
  assert.throws(() => buildCases({ admin, trap: { ...trap, rpcUrl: 'http://127.0.0.1:1' }, sweep }, { admin: sweepWire, trap: sweepWire, sweep: sweepWire }), /different RPCs/);
  assert.throws(() => buildCases({ admin, trap, sweep }, { admin: '', trap: sweepWire, sweep: sweepWire }), /not a wire tx/);

  // Opt-in realistic sweep case (engine E16): only with withAtaSweep, and only when the setup emitted it.
  const wires = { admin: sweepWire, trap: sweepWire, sweep: sweepWire, sweepAta: sweepWire };
  assert.deepEqual(buildCases({ admin, trap, sweep }, wires, 'T').cases.map((c) => c.role), ROLES);
  assert.throws(() => buildCases({ admin, trap, sweep }, wires, 'T', { withAtaSweep: true }), /no ataSweep/);
  const ataSweep = { file: 'packages/scenarios/.localnet/sweep/sweep-ata.unsigned.b64', feePayer: user, recentBlockhash, lastValidBlockHeight: 9 };
  const extra = buildCases({ admin, trap, sweep: { ...sweep, ataSweep } }, wires, 'T', { withAtaSweep: true }).cases.at(-1);
  assert.deepEqual([extra.role, extra.expectLevel, extra.signer, extra.file], ['l4-sweep-ata', 'L4', user, ataSweep.file]);
});

test('saved cases reject expiry without rewriting bytes or losing the seller signature', async () => {
  const { checkSavedCase } = await import('../scripts/e2e-cases.mjs');
  const c = { role: 'l2-trap', tx: 'unchanged partially signed bytes', recentBlockhash: 'expired' };
  const original = { ...c };
  const calls = [];
  await assert.rejects(checkSavedCase(c, { call: async (...args) => { calls.push(args); return { value: false }; } }), (e) => {
    assert.match(e.message, /STALE.*blockhash/);
    assert.deepEqual(e.diagnostics.blockhash, { value: false });
    return true;
  });
  assert.deepEqual(c, original);
  assert.deepEqual(calls, [['isBlockhashValid', ['expired', { commitment: 'confirmed' }]]]);
});

test('saved durable nonce bypasses recent-blockhash expiry but rejects failed simulation with exact error and logs', async () => {
  const { checkSavedCase } = await import('../scripts/e2e-cases.mjs');
  const c = { role: 'l3-admin', tx: 'nonce bytes', durableNonce: 'nonce account' };
  const response = { value: { err: { InstructionError: [0, 'InvalidArgument'] }, logs: ['nonce already advanced'] } };
  await assert.rejects(checkSavedCase(c, { call: async (method, params) => {
    assert.equal(method, 'simulateTransaction');
    assert.equal(params[0], c.tx);
    assert.equal(params[1].replaceRecentBlockhash, false);
    assert.equal(params[1].sigVerify, false);
    return response;
  } }), (e) => {
    assert.match(e.message, /cannot simulate.*InstructionError/);
    assert.deepEqual(e.diagnostics.simulation, response);
    return true;
  });
});

test('usable saved cases retain their exact bytes and simulation evidence', async () => {
  const { checkSavedCase } = await import('../scripts/e2e-cases.mjs');
  const c = { role: 'l4-sweep-ata', tx: 'saved bytes', recentBlockhash: 'valid' };
  const methods = [];
  const result = await checkSavedCase(c, { call: async (method, params) => {
    methods.push(method);
    if (method === 'isBlockhashValid') return { value: true };
    assert.equal(params[0], 'saved bytes');
    return { value: { err: null, logs: [] } };
  } });
  assert.deepEqual(methods, ['isBlockhashValid', 'simulateTransaction']);
  assert.equal(result.simulation.value.err, null);
});
