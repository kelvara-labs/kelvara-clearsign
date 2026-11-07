/* global Buffer */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { RENT_EXEMPT_EMPTY, loaderCloseProgram, planRecycle, withdrawNonce } from '../scripts/lib/recycle.mjs';
import { TOKEN_2022 } from '../scripts/lib/token2022.mjs';
import { BPF_LOADER_UPGRADEABLE, SYSTEM_PROGRAM, b58encode, compileLegacy } from '../scripts/lib/tx.mjs';

const pk = () => b58encode(randomBytes(32));
const tag = (ix) => ix.data[0];
const lamportsOf = (ix) => Number(Buffer.from(ix.data).readBigUInt64LE(4));

// The trap state after an attack, as getTokenAccountsByOwner showed it on devnet: the creator holds the pulled
// 50,000 SHINY, the seller 950,000, the buyer a frozen empty account; the seller holds the 1 SOL price.
function trapState() {
  const [payer, creator, seller, user, mint] = [pk(), pk(), pk(), pk(), pk()];
  const ta = (owner, amount, frozen) => ({ address: pk(), owner, mint, amount, decimals: 6, frozen, freezeAuthority: creator, lamports: 1_513_840 });
  return {
    payer, creator, seller, user, mint,
    actors: [{ name: 'trap-creator', publicKey: creator }, { name: 'trap-seller', publicKey: seller }, { name: 'trap-user', publicKey: user }],
    tokenAccounts: [ta(creator, 50_000_000_000n, false), ta(seller, 950_000_000_000n, false), ta(user, 0n, true)],
    balances: { [creator]: 94_452_960, [seller]: 1_100_000_000, [user]: 98_476_160 }
  };
}

test('trap: thaws the frozen buyer account, burns, closes every token account and drains all actors to the payer', () => {
  const s = trapState();
  const plan = planRecycle({ ...s, freezers: new Set([s.creator]) });
  assert.deepEqual(plan.skipped, []);
  const ixs = plan.txs.flatMap((t) => t.instructions);
  const token = ixs.filter((ix) => ix.programId === TOKEN_2022);
  assert.equal(token.filter((ix) => tag(ix) === 11).length, 1, 'one thaw (the buyer)');
  assert.equal(token.filter((ix) => tag(ix) === 15).length, 2, 'burns only the non-empty accounts');
  const closes = token.filter((ix) => tag(ix) === 9);
  assert.equal(closes.length, 3);
  for (const c of closes) assert.equal(c.keys[1].pubkey, s.payer, 'rent goes to the payer');
  // thaw comes before close of the same account
  const userAcc = s.tokenAccounts[2].address;
  const order = ixs.map((ix, i) => [ix, i]).filter(([ix]) => ix.keys[0]?.pubkey === userAcc).map(([ix]) => tag(ix));
  assert.deepEqual(order, [11, 9]);
  const transfers = ixs.filter((ix) => ix.programId === SYSTEM_PROGRAM);
  assert.equal(transfers.length, 3);
  for (const t of transfers) {
    assert.equal(t.keys[1].pubkey, s.payer);
    assert.equal(lamportsOf(t), s.balances[t.keys[0].pubkey], 'drained to exactly 0 (the payer pays the fee)');
  }
  assert.equal(plan.lamportsToPayer, 1_100_000_000 + 94_452_960 + 98_476_160 + 3 * 1_513_840);
  // every transaction fits a legacy packet with the payer as fee payer
  for (const tx of plan.txs) {
    const { message, signers } = compileLegacy({ feePayer: s.payer, instructions: tx.instructions, recentBlockhash: pk() });
    assert.ok(1 + 64 * signers.length + message.length <= 1232, `${tx.label} too large`);
    assert.equal(signers[0], s.payer);
    assert.deepEqual(new Set(signers.slice(1)), new Set(tx.signers));
  }
});

test('a frozen account whose freeze authority is not ours, or one we do not own, is left alone', () => {
  const s = trapState();
  const foreign = { ...s.tokenAccounts[0], owner: pk() };
  const plan = planRecycle({ ...s, tokenAccounts: [s.tokenAccounts[2], foreign], freezers: new Set() });
  assert.equal(plan.skipped.length, 2);
  assert.equal(plan.txs.flatMap((t) => t.instructions).filter((ix) => ix.programId === TOKEN_2022).length, 0);
});

test('reserve keeps a rent-exempt float, never an amount the runtime would reject', () => {
  const s = trapState();
  assert.throws(() => planRecycle({ ...s, reserve: 5000 }), /reserve/);
  const plan = planRecycle({ ...s, tokenAccounts: [], reserve: RENT_EXEMPT_EMPTY });
  for (const t of plan.txs.flatMap((x) => x.instructions)) assert.equal(lamportsOf(t), s.balances[t.keys[0].pubkey] - RENT_EXEMPT_EMPTY);
  assert.equal(planRecycle({ ...s, tokenAccounts: [], balances: {} }).txs.length, 0, 'empty actors: nothing to send');
});

test('the payer is never an actor', () => {
  const s = trapState();
  assert.throws(() => planRecycle({ ...s, actors: [...s.actors, { name: 'payer', publicKey: s.payer }] }), /payer/);
});

test('nonce withdraw and program close encode the System and loader layouts', () => {
  const [nonce, to, auth, pd, prog] = [pk(), pk(), pk(), pk(), pk()];
  const w = withdrawNonce(nonce, to, auth, 1_447_680);
  assert.equal(w.programId, SYSTEM_PROGRAM);
  assert.equal(Buffer.from(w.data).readUInt32LE(0), 5);
  assert.equal(lamportsOf(w), 1_447_680);
  assert.deepEqual(w.keys.map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, true], [false, false], [false, false], [true, false]]);
  const c = loaderCloseProgram(pd, to, auth, prog);
  assert.equal(c.programId, BPF_LOADER_UPGRADEABLE);
  assert.equal(Buffer.from(c.data).readUInt32LE(0), 5);
  assert.deepEqual(c.keys.map((k) => k.pubkey), [pd, to, auth, prog]);
  assert.deepEqual(c.keys.map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, true], [true, false], [false, true]]);
});
