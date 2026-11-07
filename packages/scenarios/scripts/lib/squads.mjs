// Squads v4 instruction builders, hand-encoded from the on-chain Anchor IDL (packages/idls/raw/squads-v4.json on
// main, read from the program's anchor:idl account). No Squads code is used here: discriminators are Anchor's
// sha256("global:<snake_case_name>")[0..8], args are Borsh, PDAs follow the seeds the program checks.
/* global Buffer */
import { createHash } from 'node:crypto';
import { SYSTEM_PROGRAM, b58decode, findProgramAddress, pubkeyBytes } from './tx.mjs';

export const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const SEED = Buffer.from('multisig');

export const PERMISSION_ALL = 7; // Initiate | Vote | Execute

const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

// ---- Borsh ----
const u8 = (n) => Uint8Array.of(n);
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
export const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const bytes = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);
const str = (s) => bytes(Buffer.from(s, 'utf8'));
const option = (v, enc) => (v == null ? u8(0) : Buffer.concat([u8(1), enc(v)]));
const pk = (k) => Buffer.from(pubkeyBytes(k));

// ---- PDAs ----
export const multisigPda = (createKey) => findProgramAddress([SEED, SEED, pk(createKey)], SQUADS_PROGRAM)[0];
export const vaultPda = (multisig, index = 0) =>
  findProgramAddress([SEED, pk(multisig), Buffer.from('vault'), u8(index)], SQUADS_PROGRAM)[0];
export const transactionPda = (multisig, index) =>
  findProgramAddress([SEED, pk(multisig), Buffer.from('transaction'), u64(index)], SQUADS_PROGRAM)[0];
export const proposalPda = (multisig, index) =>
  findProgramAddress([SEED, pk(multisig), Buffer.from('transaction'), u64(index), Buffer.from('proposal')], SQUADS_PROGRAM)[0];

const m = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

// ---- instructions ----
export function multisigCreateV2({ programConfig, treasury, multisig, createKey, creator, threshold, members, timeLock, memo }) {
  const sorted = [...members].sort((a, b) => Buffer.compare(pk(a.key), pk(b.key)));
  const data = Buffer.concat([
    disc('multisig_create_v2'),
    option(null, pk), // configAuthority: None (autonomous; changes need a proposal)
    u16(threshold),
    u32(sorted.length),
    ...sorted.map((x) => Buffer.concat([pk(x.key), u8(x.permissions)])),
    u32(timeLock),
    option(null, pk), // rentCollector: None
    option(memo, str)
  ]);
  return {
    programId: SQUADS_PROGRAM,
    keys: [m(programConfig, false, false), m(treasury, false, true), m(multisig, false, true), m(createKey, true, false), m(creator, true, true), m(SYSTEM_PROGRAM, false, false)],
    data
  };
}

// Squads' compact TransactionMessage: u8 counts, u8-prefixed keys and instructions, u16-prefixed ix data.
// Accounts must already be ordered: writable signers, readonly signers, writable non-signers, readonly non-signers.
export function compileVaultMessage({ accountKeys, numSigners, numWritableSigners, numWritableNonSigners, instructions }) {
  const index = new Map(accountKeys.map((k, i) => [k, i]));
  const parts = [u8(numSigners), u8(numWritableSigners), u8(numWritableNonSigners), u8(accountKeys.length), ...accountKeys.map(pk), u8(instructions.length)];
  for (const ix of instructions) {
    parts.push(u8(index.get(ix.programId)), u8(ix.keys.length), Uint8Array.from(ix.keys.map((k) => index.get(k))), u16(ix.data.length), Buffer.from(ix.data));
  }
  parts.push(u8(0)); // no address table lookups
  return Buffer.concat(parts);
}

export function vaultTransactionCreate({ multisig, transaction, creator, rentPayer, vaultIndex = 0, message, memo }) {
  const data = Buffer.concat([disc('vault_transaction_create'), u8(vaultIndex), u8(0), bytes(message), option(memo, str)]);
  return {
    programId: SQUADS_PROGRAM,
    keys: [m(multisig, false, true), m(transaction, false, true), m(creator, true, false), m(rentPayer, true, true), m(SYSTEM_PROGRAM, false, false)],
    data
  };
}

export function proposalCreate({ multisig, proposal, creator, rentPayer, transactionIndex, draft = false }) {
  return {
    programId: SQUADS_PROGRAM,
    keys: [m(multisig, false, false), m(proposal, false, true), m(creator, true, false), m(rentPayer, true, true), m(SYSTEM_PROGRAM, false, false)],
    data: Buffer.concat([disc('proposal_create'), u64(transactionIndex), u8(draft ? 1 : 0)])
  };
}

export function proposalApprove({ multisig, member, proposal, memo }) {
  return {
    programId: SQUADS_PROGRAM,
    keys: [m(multisig, false, false), m(member, true, true), m(proposal, false, true)],
    data: Buffer.concat([disc('proposal_approve'), option(memo, str)])
  };
}

// remaining: the vault message's account keys in order, with the message's writable flags, never as signers
// (the vault PDA signs inside the program).
export function vaultTransactionExecute({ multisig, proposal, transaction, member, remaining }) {
  return {
    programId: SQUADS_PROGRAM,
    keys: [m(multisig, false, false), m(proposal, false, true), m(transaction, false, false), m(member, true, false), ...remaining.map((r) => m(r.pubkey, false, r.isWritable))],
    data: disc('vault_transaction_execute')
  };
}

// ---- account readers ----
// Multisig: disc 8, create_key 32, config_authority 32, threshold u16, time_lock u32, transaction_index u64, ...
export function readMultisig(data) {
  const b = Buffer.from(data);
  return {
    threshold: b.readUInt16LE(72),
    timeLock: b.readUInt32LE(74),
    transactionIndex: b.readBigUInt64LE(78)
  };
}

// Proposal: disc 8, multisig 32, transaction_index u64, status enum (u8 tag + i64 timestamp), bump, approved vec...
const PROPOSAL_STATUS = ['Draft', 'Active', 'Rejected', 'Approved', 'Executing', 'Executed', 'Cancelled'];
export function readProposal(data) {
  const b = Buffer.from(data);
  const status = PROPOSAL_STATUS[b[48]] ?? `unknown(${b[48]})`;
  let o = 49 + (b[48] === 4 ? 0 : 8) + 1; // Executing carries no timestamp
  const n = b.readUInt32LE(o);
  o += 4;
  const approved = [];
  for (let i = 0; i < n; i++) approved.push(b.subarray(o + 32 * i, o + 32 * (i + 1)));
  return { status, approvedCount: n, approved };
}

export { b58decode };
