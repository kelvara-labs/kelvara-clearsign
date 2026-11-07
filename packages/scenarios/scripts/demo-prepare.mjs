#!/usr/bin/env node
/* global Buffer */
// Funds only the existing dedicated Member A; never resets or executes a proposal.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime, PKG, KEYS, exportSolflare } from './lib/devnet.mjs';
import { readKeypair } from './lib/tx.mjs';
import { ataAddress, createAtaIdempotent, mintTo, parseTokenAccount, systemTransfer } from './lib/token2022.mjs';
import { PAYER_FLOOR } from './lib/recycle.mjs';
export const SHARED_STATE = join(PKG, '.devnet/playground.json');
export function sharedAccount(admin, member) {
  if (admin.members.A !== member.publicKey || admin.approval.feePayer !== member.publicKey) throw new Error('Member A key does not match existing admin approval');
  return member.publicKey;
}
export async function prepare() {
  const ctx = await runtime('admin');
  const admin = JSON.parse(readFileSync(join(PKG, '.devnet/admin/scenario.json')));
  const sweep = JSON.parse(readFileSync(join(PKG, '.devnet/sweep/scenario.json')));
  const account = sharedAccount(admin, readKeypair(join(KEYS, 'member-a.json')));
  const { rpc, payer } = ctx;
  const balance = async pk => (await rpc.call('getBalance', [pk, { commitment: 'confirmed' }])).value;
  const before = await balance(payer.publicKey), have = await balance(account);
  const instructions = [];
  if (have < 1_100_000_000) instructions.push(systemTransfer(payer.publicKey, account, 1_100_000_000 - have));
  for (const t of sweep.tokens) {
    const ata = ataAddress(account, t.mint);
    const { value } = await rpc.call('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]);
    const held = value ? parseTokenAccount(Buffer.from(value.data[0], 'base64')).amount : 0n;
    if (!value) instructions.push(createAtaIdempotent(payer.publicKey, account, t.mint));
    if (held < BigInt(t.amount)) instructions.push(mintTo(t.mint, ata, payer.publicKey, BigInt(t.amount) - held));
  }
  if (before - Math.max(0, 1_100_000_000 - have) - 10_000_000 < PAYER_FLOOR) throw new Error('Devnet payer would fall below its floor');
  if (instructions.length) await rpc.send(instructions, payer, []);
  const importFile = join(KEYS, 'member-a.solflare.txt');
  exportSolflare(join(KEYS, 'member-a.json'), importFile);
  const state = { chain: 'solana:devnet', account, importFile, collector: sweep.collector, mints: sweep.tokens.map(({ mint, decimals }) => ({ mint, decimals })), preparedAt: new Date().toISOString() };
  writeFileSync(SHARED_STATE, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ account, importFile, payerBefore: before, payerAfter: await balance(payer.publicKey), accountLamports: await balance(account) }));
  return state;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare().catch(e => { console.error('[demo:prepare]', e.message); process.exitCode = 1; });
