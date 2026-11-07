// S9 sweep-devnet, offline: the sweep the "claim airdrop" page asks for, and its page. No validator, no network.
/* global Buffer, fetch */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { buildSweep } from '../scripts/sweep-devnet.mjs';
import { serveAttacker, attackerHtml } from '../scripts/lib/attacker-page.mjs';
import { ATA_PROGRAM, TOKEN_2022, ataAddress } from '../scripts/lib/token2022.mjs';
import { SYSTEM_PROGRAM } from '../scripts/lib/tx.mjs';
import { parseWireTransaction } from '../scripts/wire.mjs';

// Addresses are derived only for the encoding test; nothing here touches a chain.
const user = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
const collector = '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
const mintA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const mintB = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const tokens = [
  { mint: mintA, decimals: 6, amount: 1_250_000_000n },
  { mint: mintB, decimals: 9, amount: 4_200_000_000_000_000n }
];
const recentBlockhash = '11111111111111111111111111111111';

test('sweep: one tx, user is fee payer and only signer, every token and every lamport but the fee to the collector', () => {
  const lamports = 50_000_000, fee = 5000, ataRent = 2_074_080;
  const { compiled, wire, sol } = buildSweep({ user, collector, tokens, lamports, fee, ataRent, recentBlockhash });
  assert.deepEqual(compiled.signers, [user]);
  assert.equal(sol, lamports - fee - 2 * ataRent);
  const tx = parseWireTransaction(wire);
  assert.equal(wire[0], 1);
  assert.ok(wire.subarray(1, 65).every((b) => b === 0), 'signature slot is empty');
  const keys = tx.staticAccountKeys;
  assert.equal(keys[0], user);
  assert.equal(tx.header.required, 1);
  assert.ok(keys.indexOf(collector) >= 1, 'collector is not a signer');
  const ix = tx.instructions.map((i) => ({ program: keys[i.programIdIndex], accounts: i.accounts.map((a) => keys[a]), data: Buffer.from(i.data) }));
  assert.deepEqual(ix.map((i) => i.program), [ATA_PROGRAM, TOKEN_2022, TOKEN_2022, ATA_PROGRAM, TOKEN_2022, TOKEN_2022, SYSTEM_PROGRAM]);
  tokens.forEach((t, n) => {
    const [create, transfer, close] = ix.slice(3 * n, 3 * n + 3);
    assert.deepEqual(create.accounts.slice(0, 4), [user, ataAddress(collector, t.mint), collector, t.mint]);
    assert.equal(transfer.data[0], 12);
    assert.equal(transfer.data.readBigUInt64LE(1), t.amount, 'whole balance');
    assert.deepEqual(transfer.accounts, [ataAddress(user, t.mint), t.mint, ataAddress(collector, t.mint), user]);
    assert.equal(close.data[0], 9);
    assert.deepEqual(close.accounts, [ataAddress(user, t.mint), collector, user]);
  });
  const last = ix.at(-1);
  assert.equal(last.data.readUInt32LE(0), 2);
  assert.equal(Number(last.data.readBigUInt64LE(4)), sol);
  assert.deepEqual(last.accounts, [user, collector]);
});

test('sweep: refuses when the user cannot pay', () => {
  assert.throws(() => buildSweep({ user, collector, tokens, lamports: 4_000_000, fee: 5000, ataRent: 2_074_080, recentBlockhash }), /not enough/);
});

test('sweep page: "Claim airdrop", Wallet Standard signTransaction only, served bytes rebuilt per request', async () => {
  const html = attackerHtml('sweep', user);
  assert.match(html, /<title>Claim airdrop<\/title>/);
  assert.match(html, /solana:signTransaction/);
  assert.doesNotMatch(html, /signAndSendTransaction|sendTransaction/);
  let n = 0;
  const server = serveAttacker('sweep', { sweepWire: async () => Buffer.from([++n]).toString('base64') }, { user }, { port: 0 });
  await once(server, 'listening');
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await (await fetch(url + '/transaction')).json()).transaction, Buffer.from([1]).toString('base64'));
    assert.equal((await (await fetch(url + '/transaction')).json()).transaction, Buffer.from([2]).toString('base64'));
    assert.equal((await fetch(url + '/scenario.json')).status, 404);
    assert.equal((await fetch(url + '/transaction', { method: 'POST' })).status, 403);
  } finally {
    server.close();
  }
});
