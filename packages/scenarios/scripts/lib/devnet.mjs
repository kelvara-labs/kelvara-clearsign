/* global Buffer */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heliusDevnet, loadHeliusKey, redact } from './helius.mjs';
import { b58encode, findProgramAddress, readKeypair } from './tx.mjs';
import { systemTransfer } from './token2022.mjs';
import { PAYER_FLOOR } from './recycle.mjs';
import { mainCheckout as resolveMainCheckout } from './main-checkout.mjs';
import { SQUADS_PROGRAM } from './squads.mjs';
import { readUpgradeAuthority } from '../admin-local.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PKG = join(REPO, 'packages/scenarios');
export const KEYS = join(REPO, '.keys/devnet');
export function mainCheckout() {
  return resolveMainCheckout(REPO, '.keys/devnet-payer.json');
}
export function exportSolflare(keyPath, output) {
  const raw = JSON.parse(readFileSync(keyPath, 'utf8'));
  if (raw.length !== 64 || raw.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('invalid devnet keypair');
  writeFileSync(output, b58encode(raw) + '\n', { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  chmodSync(output, 0o600);
}
function keygen(path) {
  if (existsSync(path)) return;
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '-o', path], { stdio: 'ignore' });
  chmodSync(path, 0o600);
}
export async function runtime(kind) {
  if (!['admin', 'trap'].includes(kind)) throw new Error('unknown devnet scenario');
  const payerPath = join(mainCheckout(), '.keys/devnet-payer.json');
  if (!existsSync(payerPath)) throw new Error('NEEDS_HUMAN: fund .keys/devnet-payer.json in main checkout with devnet SOL; never use a mainnet key');
  const rpc = await heliusDevnet(REPO);
  const payer = readKeypair(payerPath);
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const fund = async (pubkey) => {
    // Localnet asks for large airdrops; devnet tops each actor up only as needed.
    const target = kind === 'trap' && existsSync(join(KEYS, 'trap-user.json')) && pubkey === readKeypair(join(KEYS, 'trap-user.json')).publicKey ? 1_100_000_000 : 100_000_000;
    const bal = (await rpc.call('getBalance', [pubkey, { commitment: 'confirmed' }])).value;
    if (bal >= target) return;
    const available = (await rpc.call('getBalance', [payer.publicKey, { commitment: 'confirmed' }])).value;
    if (available - (target - bal) < PAYER_FLOOR) throw new Error(`NEEDS_HUMAN: devnet payer has ${available / 1e9} SOL; topping up ${pubkey} would take it below the ${PAYER_FLOOR / 1e9} SOL floor (run --recycle first, or refill it)`);
    await rpc.send([systemTransfer(payer.publicKey, pubkey, target - bal)], payer, []);
  };
  return { network: 'devnet', rpc, payer, payerPath, fund, keys: KEYS, out: join(PKG, '.devnet', kind), state: { rpcUrl: 'helius-devnet' } };
}
export async function prepareAdmin(ctx) {
  const { rpc } = ctx;
  const programConfig = findProgramAddress([Buffer.from('multisig'), Buffer.from('program_config')], SQUADS_PROGRAM)[0];
  const { value } = await rpc.call('getMultipleAccounts', [[SQUADS_PROGRAM, programConfig], { encoding: 'base64', commitment: 'confirmed' }]);
  if (!value[0]?.executable || value[1]?.owner !== SQUADS_PROGRAM) throw new Error('real Squads v4 devnet program/config unavailable; PLAN fallback: record Story 1 on labeled localnet');
  const treasury = b58encode(Buffer.from(value[1].data[0], 'base64').subarray(48, 80));
  const demoKey = join(KEYS, 'demo-program.json');
  const authorityKey = join(KEYS, 'demo-upgrade-authority.json');
  keygen(demoKey);
  keygen(authorityKey);
  const programId = readKeypair(demoKey).publicKey;
  const { value: deployed } = await rpc.call('getAccountInfo', [programId, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!deployed) {
    const source = join(PKG, 'programs/devnet-demo');
    const elf = join(source, 'target/deploy/signguard_devnet_demo.so');
    execFileSync('cargo-build-sbf', ['--manifest-path', join(source, 'Cargo.toml'), '--sbf-out-dir', join(source, 'target/deploy')], { stdio: 'inherit' });
    const rent = await rpc.call('getMinimumBalanceForRentExemption', [readFileSync(elf).length * 2 + 45]);
    const bal = (await rpc.call('getBalance', [ctx.payer.publicKey, { commitment: 'confirmed' }])).value;
    if (bal < rent * 3 + PAYER_FLOOR) throw new Error('NEEDS_HUMAN: devnet payer needs more devnet SOL for demo deployment');
    // CLI URL lives in a private config file, never in argv or output.
    const config = join(KEYS, 'deploy-config.yml');
    const payerLink = join(KEYS, 'deploy-payer.json');
    rmSync(payerLink, { force: true });
    symlinkSync(ctx.payerPath, payerLink);
    writeFileSync(config, 'json_rpc_url: "https://devnet.helius-rpc.com/?api-key=' + loadHeliusKey(REPO) + '"\nwebsocket_url: ""\nkeypair_path: ' + JSON.stringify(payerLink) + '\ncommitment: confirmed\n', { mode: 0o600 });
    try {
      execFileSync('solana', ['--config', config, 'program', 'deploy', elf, '--use-rpc', '--program-id', demoKey, '--upgrade-authority', authorityKey], { stdio: 'pipe', timeout: 10 * 60_000 });
    } catch (e) {
      throw new Error(redact('devnet deploy failed: ' + (e.stderr?.toString() ?? e.message)));
    } finally {
      rmSync(config, { force: true });
      rmSync(payerLink, { force: true });
    }
  }
  // A previous unexecuted proposal still owns the program: use a new demo
  // only after finishing its attack, rather than silently losing authority.
  const authority = await readUpgradeAuthority(rpc, programId);
  ctx.state = { rpcUrl: 'helius-devnet', demo: { programId }, keyFiles: { 'demo-upgrade-authority': '.keys/devnet/demo-upgrade-authority.json' }, squads: { program: { programId: SQUADS_PROGRAM }, programConfig, accounts: [{ role: 'treasury', pubkey: treasury }] } };
  return authority;
}
