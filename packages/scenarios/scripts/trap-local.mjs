#!/usr/bin/env node
/* global Buffer */
// User scenario on localnet (PLAN.md M4, task S4): the Token-2022 trap token $SHINY.
//   pnpm --filter @kelvara/scenarios scenario:trap-local            set up + emit the partially signed buy tx
//   pnpm --filter @kelvara/scenarios scenario:trap-local --attack   then the user buys and the creator pulls it back
//   pnpm --filter @kelvara/scenarios scenario:trap-local:attack     attack only, on the last setup
//
// Needs a running `localnet:up` (Token-2022 and ATA are built into solana-test-validator). Setup:
//  1. Keys in <repo>/.keys/localnet/: trap-creator, trap-seller, trap-user (kept); a fresh mint key per run in
//     .keys/localnet/trap-run/.
//  2. Token-2022 mint "$SHINY" (6 decimals): PermanentDelegate = creator, freeze authority = creator,
//     mint authority = creator, MetadataPointer -> the mint itself, on-mint TokenMetadata name/symbol/uri.
//  3. Creator mints 1,000,000 SHINY to the seller's associated token account.
//  4. Builds the "buy": fee payer the user; ATA CreateIdempotent for the user's SHINY account, System transfer
//     1 SOL user -> seller, Token-2022 TransferChecked 50,000 SHINY seller -> user (seller signs).
//     The seller signs now; the user's signature slot stays empty. Written to .localnet/trap/buy.partial.b64
//     for `kelvara analyze`, with addresses and the simulation result in .localnet/trap/scenario.json.
// Attack: the user signs the emitted bytes and submits (the buy lands as a normal purchase), then the creator,
// as permanent delegate, moves the whole 50,000 SHINY out of the user's account without the user's signature
// and freezes it. The script reads the balances back and fails unless the user holds 0 SHINY and is frozen.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MINT_LEN_FIXED,
  TOKEN_2022,
  ataAddress,
  createAccount,
  createAtaIdempotent,
  freezeAccount,
  initializeMetadataPointer,
  initializeMint2,
  initializePermanentDelegate,
  initializeTokenMetadata,
  mintTo,
  parseMint,
  parseTokenAccount,
  systemTransfer,
  tokenMetadataLen,
  transferChecked
} from './lib/token2022.mjs';
import { b58encode, compileLegacy, localRpc, readKeypair } from './lib/tx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const REPO = resolve(PKG, '../..');
const STATE = join(PKG, '.localnet', 'state.json');
const OUT = join(PKG, '.localnet', 'trap');
const KEYS = join(REPO, '.keys', 'localnet');
const RUN_KEYS = join(KEYS, 'trap-run');

export const TOKEN = { name: 'Shiny', symbol: 'SHINY', uri: '', decimals: 6 };
export const PRICE_LAMPORTS = 1_000_000_000; // 1 SOL
export const BUY_AMOUNT = 50_000n * 10n ** 6n; // 50,000 SHINY
const SELLER_SUPPLY = 1_000_000n * 10n ** 6n;
const STABLE_KEYS = ['trap-creator', 'trap-seller', 'trap-user'];

const log = (...a) => console.log('[trap-local]', ...a);

function keygen(path, force) {
  if (existsSync(path) && !force) return;
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '--force', '-o', path], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function accountBytes(rpc, pubkey) {
  const { value } = await rpc.call('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
  return value ? { ...value, bytes: Buffer.from(value.data[0], 'base64') } : null;
}

export async function readMint(rpc, mint) {
  const acc = await accountBytes(rpc, mint);
  if (!acc || acc.owner !== TOKEN_2022) throw new Error(`${mint} is not a Token-2022 account`);
  return parseMint(acc.bytes);
}

export async function readTokenAccount(rpc, address) {
  const acc = await accountBytes(rpc, address);
  return acc ? parseTokenAccount(acc.bytes) : null;
}

function loadState() {
  if (!existsSync(STATE)) throw new Error('no .localnet/state.json; run `pnpm --filter @kelvara/scenarios localnet:up` first');
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

// The buy as the dApp would hand it to the wallet: fee payer user, seller co-signs.
export function buildBuy({ user, seller, mint, recentBlockhash }) {
  const sellerAta = ataAddress(seller, mint);
  const userAta = ataAddress(user, mint);
  const compiled = compileLegacy({
    feePayer: user,
    instructions: [
      createAtaIdempotent(user, user, mint),
      systemTransfer(user, seller, PRICE_LAMPORTS),
      transferChecked(sellerAta, mint, userAta, seller, BUY_AMOUNT, TOKEN.decimals)
    ],
    recentBlockhash
  });
  return { compiled, sellerAta, userAta };
}

// Wire tx with the seller's signature in place and every other slot zeroed.
export function partialSign(compiled, sellerKp) {
  const sigs = compiled.signers.map((p) => (p === sellerKp.publicKey ? Buffer.from(sellerKp.sign(compiled.message)) : Buffer.alloc(64)));
  return Buffer.concat([Buffer.from([compiled.signers.length]), ...sigs, Buffer.from(compiled.message)]);
}

export async function setup() {
  const state = loadState();
  const rpc = localRpc(state.rpcUrl);
  await rpc.call('getHealth');

  mkdirSync(RUN_KEYS, { recursive: true, mode: 0o700 });
  for (const n of STABLE_KEYS) keygen(join(KEYS, `${n}.json`), false);
  keygen(join(RUN_KEYS, 'mint.json'), true);
  const [creator, seller, user] = STABLE_KEYS.map((n) => readKeypair(join(KEYS, `${n}.json`)));
  const mintKey = readKeypair(join(RUN_KEYS, 'mint.json'));
  const mint = mintKey.publicKey;

  await rpc.airdrop(creator.publicKey, 10e9);
  await rpc.airdrop(seller.publicKey, 2e9);
  await rpc.airdrop(user.publicKey, 5e9);

  // 1. the mint: extensions first, then InitializeMint2, then metadata (reallocs into prefunded lamports)
  const fullLen = MINT_LEN_FIXED + tokenMetadataLen(TOKEN);
  const rent = await rpc.call('getMinimumBalanceForRentExemption', [fullLen]);
  await rpc.send(
    [
      createAccount(creator.publicKey, mint, rent, MINT_LEN_FIXED, TOKEN_2022),
      initializePermanentDelegate(mint, creator.publicKey),
      initializeMetadataPointer(mint, creator.publicKey, mint),
      initializeMint2(mint, TOKEN.decimals, creator.publicKey, creator.publicKey),
      initializeTokenMetadata({ mint, updateAuthority: creator.publicKey, mintAuthority: creator.publicKey, ...TOKEN })
    ],
    creator,
    [mintKey]
  );
  const m = await readMint(rpc, mint);
  if (m.extensions.permanentDelegate !== creator.publicKey) throw new Error(`permanent delegate is ${m.extensions.permanentDelegate}`);
  if (m.freezeAuthority !== creator.publicKey) throw new Error(`freeze authority is ${m.freezeAuthority}`);
  if (m.extensions.tokenMetadata?.symbol !== TOKEN.symbol) throw new Error('token metadata missing');
  log(`mint $${TOKEN.symbol} ${mint}: permanent delegate + freeze authority = creator ${creator.publicKey}`);

  // 2. seller inventory
  const sellerAta = ataAddress(seller.publicKey, mint);
  await rpc.send([createAtaIdempotent(creator.publicKey, seller.publicKey, mint), mintTo(mint, sellerAta, creator.publicKey, SELLER_SUPPLY)], creator, []);
  log(`seller ${seller.publicKey} holds ${SELLER_SUPPLY / 10n ** 6n} SHINY`);

  // 3. the buy, partially signed by the seller
  const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const { compiled, userAta } = buildBuy({ user: user.publicKey, seller: seller.publicKey, mint, recentBlockhash: bh.blockhash });
  if (compiled.signers.length !== 2 || compiled.signers[0] !== user.publicKey) throw new Error(`unexpected signers ${compiled.signers}`);
  const wire = partialSign(compiled, seller);

  // Simulation: a normal purchase. 1 SOL (+ fee + ATA rent) leaves the user, 50,000 SHINY arrive.
  const watched = [user.publicKey, seller.publicKey, userAta, sellerAta];
  const pre = (await rpc.call('getMultipleAccounts', [watched, { encoding: 'base64', commitment: 'confirmed' }])).value;
  const sim = await rpc.call('simulateTransaction', [
    wire.toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } }
  ]);
  if (sim.value.err) throw new Error(`buy simulation failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs)}`);
  const post = sim.value.accounts;
  const tokenAmt = (acc) => (acc ? parseTokenAccount(Buffer.from(acc.data[0], 'base64')).amount : 0n);
  const lamportsDelta = Object.fromEntries(watched.map((p, i) => [p, (post[i]?.lamports ?? 0) - (pre[i]?.lamports ?? 0)]));
  const tokenDelta = { [userAta]: (tokenAmt(post[2]) - tokenAmt(pre[2])).toString(), [sellerAta]: (tokenAmt(post[3]) - tokenAmt(pre[3])).toString() };
  if (tokenDelta[userAta] !== BUY_AMOUNT.toString()) throw new Error(`simulation: user receives ${tokenDelta[userAta]}`);
  if (lamportsDelta[seller.publicKey] !== PRICE_LAMPORTS) throw new Error(`simulation: seller receives ${lamportsDelta[seller.publicKey]}`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'buy.partial.b64'), wire.toString('base64') + '\n');
  const scenario = {
    scenario: 'trap-local',
    createdAt: new Date().toISOString(),
    rpcUrl: state.rpcUrl,
    token: { mint, ...TOKEN, program: TOKEN_2022, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority, permanentDelegate: m.extensions.permanentDelegate },
    creator: creator.publicKey,
    seller: seller.publicKey,
    user: user.publicKey,
    sellerAta,
    userAta,
    buy: {
      file: 'packages/scenarios/.localnet/trap/buy.partial.b64',
      recentBlockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      feePayer: user.publicKey,
      signers: compiled.signers,
      signedBy: [seller.publicKey],
      missingSignatures: [user.publicKey],
      priceLamports: PRICE_LAMPORTS,
      amount: BUY_AMOUNT.toString(),
      instructions: ['ATA CreateIdempotent (user SHINY account)', 'System Transfer 1 SOL user -> seller', 'Token-2022 TransferChecked 50,000 SHINY seller -> user'],
      // Looks like a normal purchase: the user pays 1 SOL plus fee and ATA rent, and receives 50,000 SHINY.
      simulation: { err: null, unitsConsumed: sim.value.unitsConsumed, lamportsDelta, tokenDelta }
    },
    keyFiles: { ...Object.fromEntries(STABLE_KEYS.map((n) => [n, `.keys/localnet/${n}.json`])), mint: '.keys/localnet/trap-run/mint.json' }
  };
  writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  log(`buy tx (seller-signed, user slot empty, ${wire.length} bytes) -> ${scenario.buy.file}`);
  log(`input for kelvara analyze: ${scenario.buy.file}, RPC ${state.rpcUrl}`);
  return scenario;
}

export async function attack() {
  const s = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
  const rpc = localRpc(s.rpcUrl);
  const kp = (n) => readKeypair(join(REPO, s.keyFiles[n]));
  const [creator, seller, user] = STABLE_KEYS.map(kp);
  const mint = s.token.mint;

  // The user signs the emitted bytes. A normal buy uses a recent blockhash, so if it has expired (attack run
  // long after setup) the dApp would hand out the same buy again on a fresh blockhash; we do exactly that.
  let wire = Buffer.from(readFileSync(join(OUT, 'buy.partial.b64'), 'utf8').trim(), 'base64');
  let rebuilt = false;
  const { value: valid } = await rpc.call('isBlockhashValid', [s.buy.recentBlockhash, { commitment: 'confirmed' }]);
  if (!valid) {
    const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    wire = partialSign(buildBuy({ user: user.publicKey, seller: seller.publicKey, mint, recentBlockhash: bh.blockhash }).compiled, seller);
    rebuilt = true;
    log('emitted blockhash expired; same buy rebuilt on a fresh blockhash and re-signed by the seller');
  }
  const message = wire.subarray(1 + 64 * wire[0]);
  const userSig = Buffer.from(user.sign(message));
  userSig.copy(wire, 1); // slot 0 = fee payer = user
  const bs58sig = b58encode(userSig);
  await rpc.call('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  await rpc.confirm(bs58sig);
  const afterBuy = await readTokenAccount(rpc, s.userAta);
  if (afterBuy?.amount !== BigInt(s.buy.amount)) throw new Error(`user holds ${afterBuy?.amount} after the buy`);
  log(`buy landed ${bs58sig}: user holds 50,000 SHINY`);

  // The creator, as permanent delegate, takes it all back and freezes the account. No user signature.
  const creatorAta = ataAddress(creator.publicKey, mint);
  const pullSig = await rpc.send(
    [
      createAtaIdempotent(creator.publicKey, creator.publicKey, mint),
      transferChecked(s.userAta, mint, creatorAta, creator.publicKey, afterBuy.amount, TOKEN.decimals),
      freezeAccount(s.userAta, mint, creator.publicKey)
    ],
    creator,
    []
  );
  const final = await readTokenAccount(rpc, s.userAta);
  if (final.amount !== 0n || final.state !== 'Frozen') throw new Error(`user account after pull: ${final.amount} SHINY, ${final.state}`);
  log(`creator pulled ${afterBuy.amount / 10n ** 6n} SHINY back with the permanent delegate and froze the user's account: ${pullSig}`);
  const result = {
    buySignature: bs58sig,
    buyRebuilt: rebuilt,
    pullSignature: pullSig,
    userAmountAfterBuy: afterBuy.amount.toString(),
    userAmountAfterPull: final.amount.toString(),
    userAccountState: final.state,
    at: new Date().toISOString()
  };
  writeFileSync(join(OUT, 'attack.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = args.includes('--attack-only') ? attack : args.includes('--attack') ? async () => (await setup(), attack()) : setup;
  run().then(
    () => process.exit(0),
    (e) => {
      console.error('[trap-local]', e?.message ?? e);
      process.exit(1);
    }
  );
}
