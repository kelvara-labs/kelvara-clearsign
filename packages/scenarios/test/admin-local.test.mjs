// S3 admin scenario unit tests: offline, no validator. The end-to-end case is e2e/admin-local.test.mjs.
/* global Buffer */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compileVaultMessage, multisigCreateV2, proposalApprove, proposalPda, transactionPda, vaultPda } from '../scripts/lib/squads.mjs';
import { b58decode } from '../scripts/lib/tx.mjs';

const MS = 'Ey1C2aWEuxbo6orrqytTEXRFDAQ6ZZknoJeV9y81jJMU';
const disc = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);

test('Squads discriminators are Anchor global:<snake_case>', () => {
  const ix = proposalApprove({ multisig: MS, member: MS, proposal: MS, memo: 'Q4 fee update' });
  assert.deepEqual(ix.data.subarray(0, 8), disc('proposal_approve'));
  // Option<String> Some: tag 1, u32 len, bytes
  assert.equal(ix.data[8], 1);
  assert.equal(ix.data.readUInt32LE(9), 13);
  assert.equal(ix.data.subarray(13).toString(), 'Q4 fee update');
});

test('multisigCreateV2 encodes threshold 2, time lock 0, three sorted members', () => {
  const keys = ['11111111111111111111111111111112', 'SysvarRent111111111111111111111111111111111', '11111111111111111111111111111113'];
  const ix = multisigCreateV2({ programConfig: MS, treasury: MS, multisig: MS, createKey: MS, creator: MS, threshold: 2, members: keys.map((key) => ({ key, permissions: 7 })), timeLock: 0 });
  const d = ix.data;
  assert.equal(d[8], 0); // configAuthority None
  assert.equal(d.readUInt16LE(9), 2);
  assert.equal(d.readUInt32LE(11), 3);
  const members = [0, 1, 2].map((i) => d.subarray(15 + 33 * i, 47 + 33 * i));
  for (let i = 1; i < 3; i++) assert.ok(Buffer.compare(members[i - 1], members[i]) < 0, 'members sorted');
  assert.equal(d.readUInt32LE(15 + 99), 0); // time lock
});

test('vault message: SetAuthority with the vault as the only signer', () => {
  const [vault, pd, attacker, loader] = [MS, '11111111111111111111111111111112', '11111111111111111111111111111113', 'BPFLoaderUpgradeab1e11111111111111111111111'];
  const msg = compileVaultMessage({
    accountKeys: [vault, pd, attacker, loader],
    numSigners: 1,
    numWritableSigners: 0,
    numWritableNonSigners: 1,
    instructions: [{ programId: loader, keys: [pd, vault, attacker], data: Buffer.from([4, 0, 0, 0]) }]
  });
  assert.deepEqual([...msg.subarray(0, 4)], [1, 0, 1, 4]);
  assert.deepEqual(msg.subarray(4, 36), Buffer.from(b58decode(vault)));
  const ix = msg.subarray(4 + 128);
  assert.deepEqual([...ix], [1, 3, 3, 1, 0, 2, 4, 0, 4, 0, 0, 0, 0]);
});

test('PDAs are distinct and deterministic', () => {
  const set = new Set([vaultPda(MS, 0), transactionPda(MS, 1), proposalPda(MS, 1), proposalPda(MS, 2)]);
  assert.equal(set.size, 4);
  assert.equal(vaultPda(MS, 0), vaultPda(MS, 0));
});
