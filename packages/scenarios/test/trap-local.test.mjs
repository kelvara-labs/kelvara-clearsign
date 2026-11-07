// S4 trap scenario unit tests: offline, no validator. The end-to-end case is e2e/trap-local.test.mjs.
/* global Buffer */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BUY_AMOUNT, PRICE_LAMPORTS, buildBuy, partialSign } from '../scripts/trap-local.mjs';
import {
  ATA_PROGRAM,
  EXT,
  MINT_LEN_FIXED,
  TOKEN_2022,
  TOKEN_METADATA_INITIALIZE,
  ataAddress,
  initializeMint2,
  initializePermanentDelegate,
  parseMint,
  parseTokenAccount,
  transferChecked
} from '../scripts/lib/token2022.mjs';
import { b58decode, b58encode, findProgramAddress } from '../scripts/lib/tx.mjs';

const [CREATOR, SELLER, USER, MINT] = ['11111111111111111111111111111112', '11111111111111111111111111111113', '11111111111111111111111111111114', 'So11111111111111111111111111111111111111112'];
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

test('Token-2022 instruction tags and layouts', () => {
  const pd = initializePermanentDelegate(MINT, CREATOR);
  assert.equal(pd.programId, TOKEN_2022);
  assert.equal(pd.data[0], 35);
  assert.deepEqual(pd.data.subarray(1), Buffer.from(b58decode(CREATOR)));
  const im = initializeMint2(MINT, 6, CREATOR, CREATOR);
  assert.deepEqual([im.data[0], im.data[1], im.data[34]], [20, 6, 1]); // freeze authority Some
  assert.equal(im.data.length, 67);
  assert.equal(initializeMint2(MINT, 6, CREATOR, null).data.length, 35);
  const tc = transferChecked(SELLER, MINT, USER, CREATOR, 5n, 6);
  assert.deepEqual([tc.data[0], tc.data.readBigUInt64LE(1), tc.data[9]], [12, 5n, 6]);
  assert.deepEqual(TOKEN_METADATA_INITIALIZE, createHash('sha256').update('spl_token_metadata_interface:initialize_account').digest().subarray(0, 8));
  assert.equal(MINT_LEN_FIXED, 166 + 36 + 68);
});

test('ATA address is the PDA [owner, token program, mint] of the ATA program', () => {
  const expected = findProgramAddress([b58decode(USER), b58decode(TOKEN_2022), b58decode(MINT)], ATA_PROGRAM)[0];
  assert.equal(ataAddress(USER, MINT), expected);
  assert.notEqual(ataAddress(USER, MINT), ataAddress(SELLER, MINT));
});

test('parseMint reads freeze authority and the PermanentDelegate TLV', () => {
  const b = Buffer.alloc(166 + 36);
  b.writeUInt32LE(1, 46);
  Buffer.from(b58decode(CREATOR)).copy(b, 50);
  b[44] = 6;
  b[45] = 1;
  b[165] = 1;
  b.writeUInt16LE(EXT.PermanentDelegate, 166);
  b.writeUInt16LE(32, 168);
  Buffer.from(b58decode(CREATOR)).copy(b, 170);
  const m = parseMint(b);
  assert.equal(m.freezeAuthority, CREATOR);
  assert.equal(m.mintAuthority, null);
  assert.equal(m.extensions.permanentDelegate, CREATOR);
  const acc = Buffer.alloc(170);
  acc.writeBigUInt64LE(7n, 64);
  acc[108] = 2;
  assert.deepEqual([parseTokenAccount(acc).amount, parseTokenAccount(acc).state], [7n, 'Frozen']);
});

test('buy: user is fee payer, seller co-signs; partial signature leaves the user slot empty', () => {
  const sellerKp = { publicKey: SELLER, sign: (m) => createHash('sha512').update(m).digest() };
  const { compiled, userAta, sellerAta } = buildBuy({ user: USER, seller: SELLER, mint: MINT, recentBlockhash: BLOCKHASH });
  assert.deepEqual(compiled.signers, [USER, SELLER]);
  const wire = partialSign(compiled, sellerKp);
  assert.equal(wire[0], 2);
  assert.ok(wire.subarray(1, 65).every((x) => x === 0), 'user slot empty');
  assert.deepEqual(wire.subarray(65, 129), sellerKp.sign(compiled.message));
  const msg = wire.subarray(129);
  assert.ok(msg.includes(Buffer.from(b58decode(BLOCKHASH))));
  assert.ok(msg.includes(Buffer.from(b58decode(userAta))) && msg.includes(Buffer.from(b58decode(sellerAta))));
  // 1 SOL system transfer and 50,000 SHINY TransferChecked are in the message
  const lam = Buffer.alloc(8);
  lam.writeBigUInt64LE(BigInt(PRICE_LAMPORTS));
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(BUY_AMOUNT);
  assert.ok(msg.includes(Buffer.concat([Buffer.from([2, 0, 0, 0]), lam])));
  assert.ok(msg.includes(Buffer.concat([Buffer.from([12]), amt, Buffer.from([6])])));
  assert.equal(b58encode(msg.subarray(4, 36)), USER);
});
