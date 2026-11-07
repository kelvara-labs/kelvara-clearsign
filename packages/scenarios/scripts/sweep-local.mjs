#!/usr/bin/env node
/* global Buffer */
// Wallet-sweep scenario on localnet (task S12): the sweep-devnet "claim airdrop" story on a running `localnet:up`,
// the L4 case for G7 (rule wallet.sweep).
//   pnpm --filter @kelvara/scenarios scenario:sweep-local            set up + emit the unsigned sweep
//   pnpm --filter @kelvara/scenarios scenario:sweep-local --attack   then the user really signs it
//   pnpm --filter @kelvara/scenarios scenario:sweep-local:attack     attack only, on the last setup
//
// Same builders as sweep-devnet (buildSweep / currentSweep). Setup:
//  1. Keys in <repo>/.keys/localnet/: sweep-minter, sweep-collector (kept); per run a fresh user and two fresh
//     plain Token-2022 mints in .keys/localnet/sweep-run/ (so no earlier run's ATAs or balances leak in).
//  2. Airdrops: minter 1 SOL, user USER_FLOAT. The minter mints the user 1,250 of mint A (6 decimals) and
//     4,200,000 of mint B (9 decimals) into the user's ATAs.
//     The collector's ATAs are pre-created too (the attacker prepares its drop accounts in advance).
//  3. One legacy tx, fee payer and only signer the user (buildSweep plain): per mint TransferChecked(all) into the
//     collector's ATA, then System Transfer of every lamport but the fee to the collector, which never signs.
//     The user's ATAs stay open at 0 (their rent is the ATAs', not the wallet's). This is the exact shape the
//     engine's wallet.sweep rule proves today.
//     Also emitted: the realistic S9 devnet shape (CreateIdempotent + TransferChecked + CloseAccount per mint) to a
//     second collector without ATAs, from the same pre-state -> sweep-ata.unsigned.b64 (L4 once engine E16 lands). -> .localnet/sweep/sweep.unsigned.b64 + scenario.json.
// Attack: the user signs the emitted bytes (rebuilt if the blockhash expired) and submits; fails unless the user
// ends with 0 lamports and the collector holds every token.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINTS, currentSweep } from './sweep-devnet.mjs';
import { TOKEN_2022, ataAddress, createAccount, createAtaIdempotent, initializeMint2, mintTo, parseTokenAccount } from './lib/token2022.mjs';
import { b58encode, localRpc, readKeypair } from './lib/tx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const REPO = resolve(PKG, '../..');
const STATE = join(PKG, '.localnet', 'state.json');
export const OUT = join(PKG, '.localnet', 'sweep');
export const USER_FLOAT = 2_000_000_000; // 2 SOL
const MINT_LEN = 82;

const log = (...a) => console.log('[sweep-local]', ...a);

function keygen(path, force) {
  if (existsSync(path) && !force) return;
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '--force', '-o', path], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function loadState() {
  if (!existsSync(STATE)) throw new Error('no .localnet/state.json; run `pnpm --filter @kelvara/scenarios localnet:up` first');
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

const balance = async (rpc, pk) => (await rpc.call('getBalance', [pk, { commitment: 'confirmed' }])).value;

async function tokenAmount(rpc, ata) {
  const { value } = await rpc.call('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]);
  return value ? parseTokenAccount(Buffer.from(value.data[0], 'base64')).amount : null;
}

/** The sweep for the last setup, rebuilt from current balances on a fresh blockhash (unsigned wire). */
export async function freshSweep(s, rpc = localRpc(s.rpcUrl), { ata = false } = {}) {
  const mints = s.tokens.map((t) => ({ mint: t.mint, decimals: t.decimals }));
  if (ata) return currentSweep(rpc, { user: s.user, collector: s.ataSweep.collector, mints });
  return currentSweep(rpc, { user: s.user, collector: s.collector, mints, plain: true });
}

// Simulates an unsigned sweep and fails unless the user ends at 0 (or exactly the fee) and the collector holds
// every token. `closesUserAtas`: the realistic shape also closes the user's ATAs.
async function simulateSweep(rpc, sw, user, collector, closesUserAtas) {
  const watched = [user, collector, ...sw.tokens.flatMap((t) => [ataAddress(user, t.mint), ataAddress(collector, t.mint)])];
  const sim = await rpc.call('simulateTransaction', [
    sw.wire.toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } }
  ]);
  if (sim.value.err) throw new Error(`sweep simulation failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs)}`);
  const post = sim.value.accounts;
  const userPost = post[0]?.lamports ?? 0;
  if (userPost !== 0 && userPost !== sw.fee) throw new Error(`simulation leaves the user ${userPost} lamports (fee ${sw.fee})`);
  sw.tokens.forEach((t, i) => {
    const acc = post[3 + 2 * i];
    const got = acc ? parseTokenAccount(Buffer.from(acc.data[0], 'base64')).amount : null;
    const userAta = post[2 + 2 * i];
    const userAtaOk = closesUserAtas ? !userAta || userAta.lamports === 0 : userAta !== null;
    if (got !== t.amount || !userAtaOk) throw new Error(`simulation: token ${t.mint} not fully swept (${got})`);
  });
  return { err: null, unitsConsumed: sim.value.unitsConsumed, userLamportsPost: userPost };
}

export async function setup(context = {}) {
  const KEYS = context.keys ?? join(REPO, '.keys', 'localnet');
  const RUN_KEYS = join(KEYS, 'sweep-run');
  const state = context.state ?? loadState();
  const rpc = context.rpc ?? localRpc(state.rpcUrl);
  await rpc.call('getHealth');

  mkdirSync(RUN_KEYS, { recursive: true, mode: 0o700 });
  keygen(join(KEYS, 'sweep-minter.json'), false);
  keygen(join(KEYS, 'sweep-collector.json'), false);
  keygen(join(KEYS, 'sweep-collector-ata.json'), false);
  keygen(join(RUN_KEYS, 'user.json'), true);
  for (const m of MINTS) keygen(join(RUN_KEYS, `${m.key}.json`), true);
  const minter = readKeypair(join(KEYS, 'sweep-minter.json'));
  const collector = readKeypair(join(KEYS, 'sweep-collector.json'));
  // The realistic (S9 devnet) shape needs a collector with no ATAs for these mints: the sweep creates them.
  const ataCollector = readKeypair(join(KEYS, 'sweep-collector-ata.json'));
  const user = readKeypair(join(RUN_KEYS, 'user.json'));
  const mints = MINTS.map((m) => ({ ...m, kp: readKeypair(join(RUN_KEYS, `${m.key}.json`)) })).map((m) => ({ ...m, mint: m.kp.publicKey }));

  await (context.fund ?? rpc.airdrop)(minter.publicKey, 1e9);
  await (context.fund ?? rpc.airdrop)(user.publicKey, USER_FLOAT);

  const mintRent = await rpc.call('getMinimumBalanceForRentExemption', [MINT_LEN]);
  for (const m of mints) {
    await rpc.send(
      [
        createAccount(minter.publicKey, m.mint, mintRent, MINT_LEN, TOKEN_2022),
        initializeMint2(m.mint, m.decimals, minter.publicKey, null),
        createAtaIdempotent(minter.publicKey, user.publicKey, m.mint),
        createAtaIdempotent(minter.publicKey, collector.publicKey, m.mint),
        mintTo(m.mint, ataAddress(user.publicKey, m.mint), minter.publicKey, m.amount)
      ],
      minter,
      [m.kp]
    );
    log(`${m.label} ${m.mint}: user holds ${m.amount} base units`);
  }

  const sw = await currentSweep(rpc, { user: user.publicKey, collector: collector.publicKey, mints, plain: true });
  if (sw.tokens.length !== mints.length) throw new Error(`user holds ${sw.tokens.length} of ${mints.length} airdrop tokens`);
  const simulation = await simulateSweep(rpc, sw, user.publicKey, collector.publicKey, false);
  // Same user, same pre-state: the realistic shape (per mint CreateIdempotent + TransferChecked + CloseAccount, then
  // all but fee and ATA rent), as the devnet "Claim airdrop" page asks. Offered as an extra case for engine E16.
  const ata = await currentSweep(rpc, { user: user.publicKey, collector: ataCollector.publicKey, mints });
  const ataSimulation = await simulateSweep(rpc, ata, user.publicKey, ataCollector.publicKey, true);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'sweep.unsigned.b64'), sw.wire.toString('base64') + '\n');
  writeFileSync(join(OUT, 'sweep-ata.unsigned.b64'), ata.wire.toString('base64') + '\n');
  const scenario = {
    scenario: 'sweep-local',
    createdAt: new Date().toISOString(),
    network: 'localnet',
    rpcUrl: state.rpcUrl,
    user: user.publicKey,
    collector: collector.publicKey,
    minter: minter.publicKey,
    tokens: sw.tokens.map((t) => ({ mint: t.mint, decimals: t.decimals, amount: t.amount.toString(), label: mints.find((m) => m.mint === t.mint).label, program: TOKEN_2022 })),
    sweep: {
      file: 'packages/scenarios/.localnet/sweep/sweep.unsigned.b64',
      recentBlockhash: sw.recentBlockhash,
      lastValidBlockHeight: sw.lastValidBlockHeight,
      feePayer: user.publicKey,
      signers: sw.compiled.signers,
      missingSignatures: [user.publicKey],
      lamports: sw.lamports,
      fee: sw.fee,
      solToCollector: sw.sol,
      instructions: [
        ...sw.tokens.map(() => 'Token-2022 TransferChecked all -> collector ATA (pre-created by the attacker)'),
        'System Transfer all remaining lamports user -> collector'
      ],
      simulation
    },
    ataSweep: {
      file: 'packages/scenarios/.localnet/sweep/sweep-ata.unsigned.b64',
      collector: ataCollector.publicKey,
      recentBlockhash: ata.recentBlockhash,
      lastValidBlockHeight: ata.lastValidBlockHeight,
      feePayer: user.publicKey,
      signers: ata.compiled.signers,
      lamports: ata.lamports,
      fee: ata.fee,
      ataRent: ata.ataRent,
      solToCollector: ata.sol,
      instructions: [
        ...ata.tokens.flatMap(() => ['ATA CreateIdempotent(collector) paid by user', 'Token-2022 TransferChecked all -> collector', 'Token-2022 CloseAccount user ATA, rent -> collector']),
        'System Transfer all remaining lamports user -> collector'
      ],
      simulation: ataSimulation,
      note: 'realistic S9 devnet shape; L4 only once engine E16 lands'
    },
    expect: { rule: 'wallet.sweep', level: 'L4' },
    keyFiles: { user: '.keys/localnet/sweep-run/user.json', collector: '.keys/localnet/sweep-collector.json', ataCollector: '.keys/localnet/sweep-collector-ata.json', minter: '.keys/localnet/sweep-minter.json' }
  };
  writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  log(`sweep tx (unsigned, ${sw.wire.length} bytes) -> ${scenario.sweep.file}`);
  log(`realistic sweep (ATA create + close, ${ata.wire.length} bytes, collector ${ataCollector.publicKey}) -> ${scenario.ataSweep.file}`);
  log(`expected: wallet.sweep L4 (all ${sw.lamports / 1e9} SOL and ${sw.tokens.length} tokens -> ${collector.publicKey}, not a signer); analyze with --wallet ${user.publicKey}`);
  return scenario;
}

export async function attack(context = {}) {
  const s = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
  const rpc = context.rpc ?? localRpc(s.rpcUrl);
  const user = readKeypair(join(REPO, s.keyFiles.user));
  if (user.publicKey !== s.user) throw new Error('user key differs from the last setup; run setup again');
  let wire = Buffer.from(readFileSync(join(OUT, 'sweep.unsigned.b64'), 'utf8').trim(), 'base64');
  let rebuilt = false;
  const { value: valid } = await rpc.call('isBlockhashValid', [s.sweep.recentBlockhash, { commitment: 'confirmed' }]);
  if (!valid || (await balance(rpc, s.user)) !== s.sweep.lamports) {
    wire = (await freshSweep(s, rpc)).wire;
    rebuilt = true;
    log('emitted sweep expired or balances moved; rebuilt from current balances on a fresh blockhash');
  }
  const message = wire.subarray(1 + 64 * wire[0]);
  const sig = Buffer.from(user.sign(message));
  sig.copy(wire, 1);
  const sweepSig = b58encode(sig);
  const collectorBefore = await balance(rpc, s.collector);
  await rpc.call('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  await rpc.confirm(sweepSig);
  const userAfter = await balance(rpc, s.user);
  const collectorAfter = await balance(rpc, s.collector);
  const tokens = [];
  for (const t of s.tokens) tokens.push({ mint: t.mint, userAta: await tokenAmount(rpc, ataAddress(s.user, t.mint)), collector: await tokenAmount(rpc, ataAddress(s.collector, t.mint)) });
  if (userAfter !== 0) throw new Error(`user still holds ${userAfter} lamports after the sweep`);
  for (const t of tokens) if (t.userAta !== 0n || t.collector?.toString() !== s.tokens.find((x) => x.mint === t.mint).amount) throw new Error(`token ${t.mint} not swept`);
  log(`user signed the "claim airdrop": ${sweepSig}. User holds 0 SOL and 0 of every token; collector gained ${(collectorAfter - collectorBefore) / 1e9} SOL + all tokens.`);
  const result = { sweepSignature: sweepSig, sweepRebuilt: rebuilt, collectorGainedLamports: collectorAfter - collectorBefore, userLamportsAfter: userAfter, tokens: tokens.map((t) => ({ mint: t.mint, collector: t.collector.toString() })), at: new Date().toISOString() };
  writeFileSync(join(OUT, 'attack.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = args.includes('--attack-only') ? attack : args.includes('--attack') ? async () => (await setup(), attack()) : setup;
  run().then(
    () => process.exit(0),
    (e) => {
      console.error('[sweep-local]', e?.message ?? e);
      process.exit(1);
    }
  );
}
