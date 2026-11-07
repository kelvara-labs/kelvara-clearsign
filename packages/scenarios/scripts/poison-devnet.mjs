#!/usr/bin/env node
/* global Buffer */
// Address-poisoning scenario on devnet (PLAN.md M6, task S7). The L4 example for the closing shot.
//   pnpm --filter @kelvara/scenarios scenario:poison-devnet            set up + emit the unsigned 0.5 SOL send
//   pnpm --filter @kelvara/scenarios scenario:poison-devnet --attack   then the user really sends it (funds recovered)
//   pnpm --filter @kelvara/scenarios scenario:poison-devnet:attack     attack only, on the last setup
//
// Helius devnet only. Payer: <main checkout>/.keys/devnet-payer.json (the human's ~5 devnet SOL, never mainnet).
// Setup:
//  1. Keys in <repo>/.keys/devnet/: poison-friend (kept), poison-user (kept until an attack has sent to the
//     lookalike; then the next setup makes a new user, who has never sent to it). The payer tops the user up to 0.8 SOL.
//  2. The user pays the friend 0.01 SOL: the real transfer the attacker copies.
//  3. The attacker grinds a lookalike of the friend (solana-keygen grind, first 3 and last 2 characters), kept in
//     .keys/devnet/poison-lookalike.json (grinding takes minutes to an hour, so it is done once per friend). The payer funds it with 0.002 SOL.
//  4. The lookalike sends the user 0.0001 SOL of dust (signed and paid by the lookalike alone).
//  5. Builds what the page asks for: the user sends 0.5 SOL to the lookalike (fee payer user, signature slot
//     empty) -> .devnet/poison/send.unsigned.b64, with addresses, matched characters, history signatures and the
//     simulation in .devnet/poison/scenario.json.
// Attack: the user signs those bytes (rebuilt on a fresh blockhash if expired) and submits; the script fails unless
// the lookalike gained 0.5 SOL. Then the lookalike's and the user's balances go back to the payer, so devnet SOL
// is not burned (the lookalike is refunded 0.002 SOL on the next setup).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heliusDevnet } from './lib/helius.mjs';
import { lookalike } from './lib/poison.mjs';
import { systemTransfer } from './lib/token2022.mjs';
import { b58encode, compileLegacy, readKeypair } from './lib/tx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const REPO = resolve(PKG, '../..');
const OUT = join(PKG, '.devnet', 'poison');
const KEYS = join(REPO, '.keys', 'devnet');

export const USER_FLOAT = 800_000_000; // 0.8 SOL
export const FRIEND_PAYMENT = 10_000_000; // 0.01 SOL
export const LOOKALIKE_FUNDING = 2_000_000; // 0.002 SOL, stays rent-exempt after the dust
export const DUST = 100_000; // 0.0001 SOL
export const SEND = 500_000_000; // 0.5 SOL, what the page asks for
export const GRIND = { prefix: 3, suffix: 2 };

const log = (...a) => console.log('[poison-devnet]', ...a);

function mainCheckout() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim();
  return resolve(common, '..');
}

function keygen(path) {
  if (existsSync(path)) return;
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '--force', '-o', path], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** The pattern the attacker grinds for: first 3 and last 2 characters of the friend. */
export const grindPattern = (friend) => `${friend.slice(0, GRIND.prefix)}:${friend.slice(-GRIND.suffix)}`;

// solana-keygen grind writes <pubkey>.json into its cwd; it runs in a private temp dir under .keys/devnet.
function grindLookalike(friend) {
  const path = join(KEYS, 'poison-lookalike.json');
  const metaPath = join(KEYS, 'poison-lookalike.meta.json');
  if (existsSync(path) && existsSync(metaPath) && JSON.parse(readFileSync(metaPath, 'utf8')).friend === friend) return path;
  const tmp = join(KEYS, 'grind-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  log(`grinding a lookalike of ${friend} (${grindPattern(friend)}) ...`);
  execFileSync('solana-keygen', ['grind', '--starts-and-ends-with', `${grindPattern(friend)}:1`], { cwd: tmp, stdio: ['ignore', 'ignore', 'inherit'] });
  const file = readdirSync(tmp).find((f) => f.endsWith('.json'));
  if (!file) throw new Error('grind produced no keypair');
  renameSync(join(tmp, file), path);
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(metaPath, JSON.stringify({ friend, pattern: grindPattern(friend), seconds: Math.round((Date.now() - t0) / 1000) }, null, 2) + '\n');
  log(`ground in ${Math.round((Date.now() - t0) / 1000)} s`);
  return path;
}

const balance = async (rpc, pk) => (await rpc.call('getBalance', [pk, { commitment: 'confirmed' }])).value;

// What the page hands the wallet: user -> lookalike 0.5 SOL, fee payer user, one empty signature slot.
export function buildSend({ user, to, recentBlockhash }) {
  const compiled = compileLegacy({ feePayer: user, instructions: [systemTransfer(user, to, SEND)], recentBlockhash });
  const wire = Buffer.concat([Buffer.from([compiled.signers.length]), Buffer.alloc(64 * compiled.signers.length), Buffer.from(compiled.message)]);
  return { compiled, wire };
}

export async function setup() {
  const rpc = await heliusDevnet(REPO);
  const payerPath = join(mainCheckout(), '.keys', 'devnet-payer.json');
  if (!existsSync(payerPath)) throw new Error('no .keys/devnet-payer.json in the main checkout (NEEDS_HUMAN: ~5 devnet SOL)');
  const payer = readKeypair(payerPath);
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const userMeta = join(KEYS, 'poison-user.meta.json');
  if (existsSync(userMeta) && JSON.parse(readFileSync(userMeta, 'utf8')).sentToLookalike) {
    rmSync(join(KEYS, 'poison-user.json'), { force: true });
    rmSync(userMeta, { force: true });
    log('last user already sent to the lookalike; making a new user');
  }
  keygen(join(KEYS, 'poison-user.json'));
  keygen(join(KEYS, 'poison-friend.json'));
  const user = readKeypair(join(KEYS, 'poison-user.json'));
  const friend = readKeypair(join(KEYS, 'poison-friend.json'));
  const need = USER_FLOAT + LOOKALIKE_FUNDING + 10_000_000;
  const payerBal = await balance(rpc, payer.publicKey);
  log(`payer ${payer.publicKey}: ${payerBal / 1e9} SOL`);

  // 1. user float
  const userBal = await balance(rpc, user.publicKey);
  if (userBal < SEND + FRIEND_PAYMENT + 10_000_000) {
    if (payerBal < need) throw new Error(`payer has ${payerBal / 1e9} SOL, needs ${need / 1e9}`);
    const s = await rpc.send([systemTransfer(payer.publicKey, user.publicKey, USER_FLOAT - userBal)], payer, []);
    log(`payer topped the user ${user.publicKey} up to 0.8 SOL: ${s}`);
  }

  // 2. the real transfer
  const friendSig = await rpc.send([systemTransfer(user.publicKey, friend.publicKey, FRIEND_PAYMENT)], user, []);
  log(`user paid friend ${friend.publicKey} 0.01 SOL: ${friendSig}`);

  // 3. the lookalike
  const look = readKeypair(grindLookalike(friend.publicKey));
  const m = lookalike(look.publicKey, friend.publicKey);
  if (!m.match || m.prefix < GRIND.prefix || m.suffix < GRIND.suffix) throw new Error(`grind result ${look.publicKey} does not match ${friend.publicKey}`);
  log(`lookalike ${look.publicKey} (matches ${m.prefix} at the start, ${m.suffix} at the end)`);
  const lookBal = await balance(rpc, look.publicKey);
  if (lookBal < LOOKALIKE_FUNDING) {
    const s = await rpc.send([systemTransfer(payer.publicKey, look.publicKey, LOOKALIKE_FUNDING - lookBal)], payer, []);
    log(`payer funded the lookalike: ${s}`);
  }

  // 4. dust, right after the real transfer
  const dustSig = await rpc.send([systemTransfer(look.publicKey, user.publicKey, DUST)], look, []);
  log(`lookalike sent the user 0.0001 SOL of dust: ${dustSig}`);

  // 5. the request the page makes
  const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const { compiled, wire } = buildSend({ user: user.publicKey, to: look.publicKey, recentBlockhash: bh.blockhash });
  const watched = [user.publicKey, look.publicKey];
  const pre = (await rpc.call('getMultipleAccounts', [watched, { encoding: 'base64', commitment: 'confirmed' }])).value;
  const sim = await rpc.call('simulateTransaction', [
    wire.toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } }
  ]);
  if (sim.value.err) throw new Error(`send simulation failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs)}`);
  const lamportsDelta = Object.fromEntries(watched.map((p, i) => [p, (sim.value.accounts[i]?.lamports ?? 0) - (pre[i]?.lamports ?? 0)]));
  if (lamportsDelta[look.publicKey] !== SEND) throw new Error(`simulation: lookalike receives ${lamportsDelta[look.publicKey]}`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'send.unsigned.b64'), wire.toString('base64') + '\n');
  const scenario = {
    scenario: 'poison-devnet',
    createdAt: new Date().toISOString(),
    network: 'devnet',
    chain: 'solana:devnet',
    user: user.publicKey,
    friend: friend.publicKey,
    lookalike: look.publicKey,
    match: { prefix: m.prefix, suffix: m.suffix, ground: grindPattern(friend.publicKey) },
    friendPayment: { signature: friendSig, lamports: FRIEND_PAYMENT },
    dust: { signature: dustSig, lamports: DUST, from: look.publicKey },
    send: {
      file: 'packages/scenarios/.devnet/poison/send.unsigned.b64',
      recentBlockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      feePayer: user.publicKey,
      signers: compiled.signers,
      missingSignatures: [user.publicKey],
      lamports: SEND,
      instructions: ['System Transfer 0.5 SOL user -> lookalike'],
      // Simulation shows a plain transfer; only history shows the recipient is a farmed lookalike.
      simulation: { err: null, unitsConsumed: sim.value.unitsConsumed, lamportsDelta }
    },
    expect: { rule: 'address.poisoning', level: 'L4' },
    keyFiles: { user: '.keys/devnet/poison-user.json', friend: '.keys/devnet/poison-friend.json', lookalike: '.keys/devnet/poison-lookalike.json' }
  };
  writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  log(`send tx (unsigned, ${wire.length} bytes) -> ${scenario.send.file}`);
  log(`expected: address.poisoning L4 for ${look.publicKey} (looks like ${friend.publicKey})`);
  return scenario;
}

export async function attack() {
  const s = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
  const rpc = await heliusDevnet(REPO);
  const user = readKeypair(join(REPO, s.keyFiles.user));
  const look = readKeypair(join(REPO, s.keyFiles.lookalike));
  const payer = readKeypair(join(mainCheckout(), '.keys', 'devnet-payer.json'));

  let wire = Buffer.from(readFileSync(join(OUT, 'send.unsigned.b64'), 'utf8').trim(), 'base64');
  let rebuilt = false;
  const { value: valid } = await rpc.call('isBlockhashValid', [s.send.recentBlockhash, { commitment: 'confirmed' }]);
  if (!valid) {
    const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    wire = buildSend({ user: user.publicKey, to: s.lookalike, recentBlockhash: bh.blockhash }).wire;
    rebuilt = true;
    log('emitted blockhash expired; the same send rebuilt on a fresh blockhash');
  }
  const before = await balance(rpc, s.lookalike);
  const message = wire.subarray(1 + 64 * wire[0]);
  const sig = Buffer.from(user.sign(message));
  sig.copy(wire, 1);
  const sendSig = b58encode(sig);
  await rpc.call('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  await rpc.confirm(sendSig);
  const after = await balance(rpc, s.lookalike);
  if (after - before !== SEND) throw new Error(`lookalike gained ${after - before} lamports, expected ${SEND}`);
  log(`user sent 0.5 SOL to the lookalike: ${sendSig}. The poisoning worked.`);

  // Recovery: everything the lookalike holds goes back to the payer (account closes at 0).
  const fee = 5000;
  const recoverSig = await rpc.send([systemTransfer(look.publicKey, payer.publicKey, after - fee)], look, []);
  log(`lookalike balance returned to the payer: ${recoverSig}`);
  writeFileSync(join(KEYS, 'poison-user.meta.json'), JSON.stringify({ user: user.publicKey, sentToLookalike: sendSig }, null, 2) + '\n');
  const userLeft = await balance(rpc, user.publicKey);
  const userRecoverSig = userLeft > fee ? await rpc.send([systemTransfer(user.publicKey, payer.publicKey, userLeft - fee)], user, []) : null;
  if (userRecoverSig) log(`user's remaining balance returned to the payer: ${userRecoverSig}`);
  // The friend keeps no SOL either: its 0.01 SOL goes back (the payer pays the fee; the friend key stays).
  const friend = readKeypair(join(REPO, s.keyFiles.friend));
  const friendLeft = await balance(rpc, friend.publicKey);
  const friendRecoverSig = friendLeft > 0 ? await rpc.send([systemTransfer(friend.publicKey, payer.publicKey, friendLeft)], payer, [friend]) : null;
  if (friendRecoverSig) log(`friend's ${friendLeft / 1e9} SOL returned to the payer: ${friendRecoverSig}`);
  const result = { sendSignature: sendSig, sendRebuilt: rebuilt, lookalikeGained: after - before, recoverSignature: recoverSig, userRecoverSignature: userRecoverSig, friendRecoverSignature: friendRecoverSig, at: new Date().toISOString() };
  writeFileSync(join(OUT, 'attack.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (!args.includes('--attack-only')) await setup();
    if (args.includes('--attack') || args.includes('--attack-only')) await attack();
  } catch (e) {
    console.error(`[poison-devnet] FAIL ${e?.message ?? e}`);
    process.exit(1);
  }
}
