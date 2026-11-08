#!/usr/bin/env node
/* global Buffer */
// ABI: https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/instruction.rs
// State: https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/mod.rs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime, KEYS, PKG } from './lib/devnet.mjs';
import { readKeypair, b58decode, b58encode, compileLegacy } from './lib/tx.mjs';
import { createAccount, initializeMint2, TOKEN_2022 } from './lib/token2022.mjs';
import { compileVaultMessage, readMultisig, readProposal, transactionPda, proposalPda, vaultTransactionCreate, proposalCreate, proposalApprove } from './lib/squads.mjs';
import { unsignedWire } from './sweep-devnet.mjs';
import { MEMO } from './admin-local.mjs';
export const FEE_STATE = join(PKG, '.devnet/fees/scenario.json');
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const setTransferFee = (mint, authority, basisPoints, maximumFee) => ({ programId: TOKEN_2022, keys: [meta(mint, false, true), meta(authority, true, false)], data: Buffer.concat([Buffer.from([26, 5]), u16(basisPoints), u64(maximumFee)]) });
export function readFeeConfig(bytes) {
  const b = Buffer.from(bytes);
  if (b.length !== 278 || b[165] !== 1 || b.readUInt16LE(166) !== 1 || b.readUInt16LE(168) !== 108) throw new Error('Unexpected TransferFeeConfig mint layout');
  const v = b.subarray(170);
  const fee = o => ({ epoch: v.readBigUInt64LE(o).toString(), maximumFee: v.readBigUInt64LE(o + 8).toString(), basisPoints: v.readUInt16LE(o + 16) });
  return { authority: b58encode(v.subarray(0, 32)), withdrawAuthority: b58encode(v.subarray(32, 64)), withheldAmount: v.readBigUInt64LE(64).toString(), olderTransferFee: fee(72), newerTransferFee: fee(90) };
}
export function feeApproval(state, recentBlockhash) {
  return unsignedWire(compileLegacy({ feePayer: state.member, recentBlockhash, instructions: [
    { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', keys: [meta(state.member, true, false)], data: Buffer.from(MEMO) },
    proposalApprove({ multisig: state.multisig, member: state.member, proposal: state.proposal, memo: MEMO })
  ] }));
}
export async function prepareFees() {
  const { rpc, payer } = await runtime('admin');
  const admin = JSON.parse(readFileSync(join(PKG, '.devnet/admin/scenario.json')));
  const account = async address => {
    const { value } = await rpc.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!value) throw new Error('Missing required devnet account');
    return { ...value, bytes: Buffer.from(value.data[0], 'base64') };
  };
  if (existsSync(FEE_STATE)) {
    const saved = JSON.parse(readFileSync(FEE_STATE));
    if (saved.multisig !== admin.multisig || saved.member !== admin.members.A) throw new Error('Fee setup belongs to different council; refusing automatic reset');
    if (readProposal((await account(saved.proposal)).bytes).status !== 'Active') throw new Error('Fee proposal is no longer Active');
    console.log(JSON.stringify({ reused: true, ...saved, currentConfig: readFeeConfig((await account(saved.mint)).bytes) }));
    return saved;
  }
  const before = (await rpc.call('getBalance', [payer.publicKey])).value;
  if (before < 520_000_000) throw new Error('Need 0.52 SOL to preserve 0.5 SOL floor');
  const keyPath = join(KEYS, 'fee-mint.json');
  if (!existsSync(keyPath)) execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '-o', keyPath], { stdio: 'ignore' });
  const mint = readKeypair(keyPath), vault = admin.vault;
  const rent = await rpc.call('getMinimumBalanceForRentExemption', [278]);
  const init = { programId: TOKEN_2022, keys: [meta(mint.publicKey, false, true)], data: Buffer.concat([Buffer.from([26, 0, 1]), Buffer.from(b58decode(vault)), Buffer.from([1]), Buffer.from(b58decode(vault)), u16(25), u64(1_000_000)]) };
  const { value: existingMint } = await rpc.call('getAccountInfo', [mint.publicKey, { encoding: 'base64', commitment: 'confirmed' }]);
  const mintSignature = existingMint ? null : await rpc.send([createAccount(payer.publicKey, mint.publicKey, rent, 278, TOKEN_2022), init, initializeMint2(mint.publicKey, 6, payer.publicKey, null)], payer, [mint]);
  const mintAccount = await account(mint.publicKey);
  if (mintAccount.owner !== TOKEN_2022) throw new Error('Wrong mint owner');
  const config = readFeeConfig(mintAccount.bytes);
  if (config.authority !== vault || config.newerTransferFee.basisPoints !== 25) throw new Error('Incorrect initial fee configuration');
  const ms = readMultisig((await account(admin.multisig)).bytes);
  const index = ms.transactionIndex + 1n;
  const transaction = transactionPda(admin.multisig, index), proposal = proposalPda(admin.multisig, index);
  const ix = setTransferFee(mint.publicKey, vault, 75, 2_000_000);
  const message = compileVaultMessage({ accountKeys: [vault, mint.publicKey, TOKEN_2022], numSigners: 1, numWritableSigners: 0, numWritableNonSigners: 1, instructions: [{ programId: TOKEN_2022, keys: [mint.publicKey, vault], data: ix.data }] });
  const creator = readKeypair(join(KEYS, 'member-c.json'));
  if ((await rpc.call('getBalance', [payer.publicKey])).value < 510_000_000) throw new Error('Insufficient budget for proposal while preserving 0.5 SOL floor');
  const proposalSignature = await rpc.send([
    vaultTransactionCreate({ multisig: admin.multisig, transaction, creator: creator.publicKey, rentPayer: payer.publicKey, message, memo: MEMO }),
    proposalCreate({ multisig: admin.multisig, proposal, creator: creator.publicKey, rentPayer: payer.publicKey, transactionIndex: index })
  ], payer, [creator]);
  if (readProposal((await account(proposal)).bytes).status !== 'Active') throw new Error('New proposal not Active');
  if (readProposal((await account(admin.proposal)).bytes).status !== 'Active') throw new Error('Original malicious proposal not Active');
  const after = (await rpc.call('getBalance', [payer.publicKey])).value;
  if (after < 500_000_000) throw new Error('Payer floor breached');
  const lockedRent = mintAccount.lamports + (await account(transaction)).lamports + (await account(proposal)).lamports;
  const state = { network: 'devnet', memo: MEMO, member: admin.members.A, multisig: admin.multisig, vault, mint: mint.publicKey, decimals: 6, transaction, proposal, transactionIndex: index.toString(), config, proposed: { basisPoints: 75, maximumFee: '2000000', activation: 'Execution epoch + 2 (Token-2022 scheduling)' }, innerDataHex: ix.data.toString('hex'), mintSignature, proposalSignature, payerBefore: before, payerAfter: after, spentLamports: before - after, lockedRent, feesLamports: before - after - lockedRent };
  mkdirSync(join(PKG, '.devnet/fees'), { recursive: true });
  writeFileSync(FEE_STATE, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify(state));
  return state;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareFees().catch(e => { console.error('[demo:prepare-fees]', e.message); process.exitCode = 1; });
