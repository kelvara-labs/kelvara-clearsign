import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtime, prepareAdmin, exportSolflare, KEYS } from './lib/devnet.mjs';
import { serveAttacker } from './lib/attacker-page.mjs';
import { balanceOf, closePrograms, recycle, sol, withdrawNonce } from './lib/recycle.mjs';
import { proposalApprove, readProposal, vaultTransactionExecute } from './lib/squads.mjs';
/* global Buffer */
import { SYSTEM_PROGRAM, b58decode as bs58, readKeypair } from './lib/tx.mjs';
import * as admin from './admin-local.mjs';
import * as trap from './trap-local.mjs';

const OPTIONS = ['--reset', '--attack', '--attack-only', '--no-serve', '--serve-only', '--recycle'];
const ADMIN_ACTORS = ['member-a', 'member-b', 'member-c', 'attacker', 'outsider', 'demo-upgrade-authority'];
const TRAP_ACTORS = ['trap-creator', 'trap-seller', 'trap-user'];
// Only keys under .keys/devnet are ever loaded here; the payer comes from runtime().
const key = (name) => readKeypair(join(KEYS, name + '.json'));
const haveKey = (name) => existsSync(join(KEYS, name + '.json'));

async function accountBytes(rpc, pubkey) {
  const { value } = await rpc.call('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
  return value ? { ...value, bytes: Buffer.from(value.data[0], 'base64') } : null;
}

// An old admin setup whose proposal never executed still holds the demo program in its vault. Finish it (we
// hold A, B and C) so the upgrade authority comes back to the attacker key, which is ours, and the program can
// be reused instead of deploying a new one.
async function finishOldProposal(ctx, s, log) {
  const { rpc, payer } = ctx;
  let { authority } = await admin.readUpgradeAuthority(rpc, s.demoProgram);
  if (authority !== s.vault) return authority;
  const acc = await accountBytes(rpc, s.proposal);
  if (!acc) return authority;
  let p = readProposal(acc.bytes);
  for (const [name, pub] of [['member-a', s.members.A], ['member-b', s.members.B]]) {
    if (p.status !== 'Active') break;
    if (p.approved.some((b) => Buffer.from(b).equals(Buffer.from(bs58(pub))))) continue;
    const sig = await rpc.send([proposalApprove({ multisig: s.multisig, member: pub, proposal: s.proposal, memo: admin.MEMO })], payer, [key(name)]);
    log(`recycle: old proposal approved by ${name}: ${sig}`);
    p = readProposal((await accountBytes(rpc, s.proposal)).bytes);
  }
  if (p.status === 'Approved') {
    const sig = await rpc.send(
      [vaultTransactionExecute({ multisig: s.multisig, proposal: s.proposal, transaction: s.vaultTransaction, member: s.members.C, remaining: s.vaultMessageAccounts })],
      payer,
      [key('member-c')]
    );
    log(`recycle: old proposal executed, demo program back to a key we hold: ${sig}`);
  }
  ({ authority } = await admin.readUpgradeAuthority(rpc, s.demoProgram));
  return authority;
}

async function recycleAdmin(ctx, log) {
  const { rpc, payer } = ctx;
  const statePath = join(ctx.out, 'scenario.json');
  const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (s?.proposal && ['member-a', 'member-b', 'member-c'].every(haveKey)) await finishOldProposal(ctx, s, log);
  // The durable nonce: Member A is its authority, so all of its lamports can go back (closing it).
  const noncePath = join(KEYS, 'admin-run', 'nonce.json');
  if (existsSync(noncePath) && haveKey('member-a')) {
    const nonce = readKeypair(noncePath).publicKey;
    const acc = await accountBytes(rpc, nonce);
    const a = key('member-a');
    if (acc && acc.owner === SYSTEM_PROGRAM && acc.bytes.length === 80 && Buffer.from(acc.bytes.subarray(8, 40)).equals(Buffer.from(bs58(a.publicKey)))) {
      const sig = await rpc.send([withdrawNonce(nonce, payer.publicKey, a.publicKey, acc.lamports)], payer, [a]);
      log(`recycle: closed the durable nonce (${sol(acc.lamports)} SOL back): ${sig}`);
    }
  }
  // Demo programs abandoned by earlier --reset runs: the attacker (ours) holds their upgrade authority.
  const archive = join(KEYS, 'archive');
  const archived = existsSync(archive)
    ? readdirSync(archive).map((d) => join(archive, d, 'demo-program.json')).filter(existsSync).map((p) => readKeypair(p).publicKey)
    : [];
  const holders = ['attacker', 'demo-upgrade-authority'].filter(haveKey).map(key);
  await closePrograms({ rpc, payer, programIds: archived, holders, readUpgradeAuthority: admin.readUpgradeAuthority, log });
  return recycle({ rpc, payer, keypairs: ADMIN_ACTORS.filter(haveKey).map(key), actorNames: ADMIN_ACTORS.filter(haveKey).map((n) => [n, key(n)]), log });
}

async function recycleTrap(ctx, log) {
  const names = TRAP_ACTORS.filter(haveKey);
  const keys = names.map(key);
  // The creator is the freeze authority of every $SHINY mint, so it can thaw the buyer's frozen account.
  const freezers = haveKey('trap-creator') ? [key('trap-creator')] : [];
  return recycle({ rpc: ctx.rpc, payer: ctx.payer, keypairs: keys, actorNames: names.map((n, i) => [n, keys[i]]), freezers, log });
}

export async function recycleScenario(kind, ctx) {
  const log = (...a) => console.log(`[${kind}-devnet]`, ...a);
  return (kind === 'admin' ? recycleAdmin : recycleTrap)(ctx, log);
}

export async function run(kind, args = process.argv.slice(2)) {
  const unknown = args.filter(a => !OPTIONS.includes(a));
  if (unknown.length) throw new Error('unknown options: ' + unknown.join(' '));
  if (args.includes('--reset') && (args.includes('--attack-only') || args.includes('--serve-only'))) throw new Error('--reset requires setup');
  if (args.includes('--recycle') && args.length > 1) throw new Error('--recycle runs alone');
  const ctx = await runtime(kind);
  const log = (...a) => console.log(`[${kind}-devnet]`, ...a);
  const impl = kind === 'admin' ? admin : trap;
  const statePath = join(ctx.out, 'scenario.json');
  const payerBefore = await balanceOf(ctx.rpc, ctx.payer.publicKey);
  log(`payer ${ctx.payer.publicKey} before: ${sol(payerBefore)} SOL`);
  const payerReport = async (result) => {
    const after = await balanceOf(ctx.rpc, ctx.payer.publicKey);
    log(`payer after: ${sol(after)} SOL (${after >= payerBefore ? '+' : '-'}${sol(Math.abs(after - payerBefore))} this run)`);
    return Object.assign(result ?? {}, { payer: { before: payerBefore, after } });
  };
  const attackAndRecycle = async () => {
    const result = await impl.attack(ctx);
    result.recycle = await recycleScenario(kind, ctx);
    return payerReport(result);
  };
  if (args.includes('--recycle')) return payerReport(await recycleScenario(kind, ctx));
  let scenario;
  if (args.includes('--attack-only')) return attackAndRecycle();
  if (args.includes('--serve-only')) scenario = JSON.parse(readFileSync(statePath, 'utf8'));
  else {
    if (existsSync(statePath) && !args.includes('--reset')) throw new Error('scenario already exists; use --serve-only, --attack-only, or --reset for fresh accounts');
    // Recycle the old setup before replacing it: its SOL, token accounts and nonce go back to the payer.
    if (args.includes('--reset')) await recycleScenario(kind, ctx);
    if (args.includes('--reset') && existsSync(ctx.out)) {
      renameSync(ctx.out, ctx.out + '-archive-' + Date.now());
    }
    if (kind === 'admin') {
      // Reuse the demo program while its upgrade authority is a key we hold (after an attack: the attacker);
      // a new deploy costs fees and locks rent. Only one we cannot control is archived.
      const demoKey = join(KEYS, 'demo-program.json');
      if (args.includes('--reset') && existsSync(demoKey)) {
        const ours = new Set(['attacker', 'demo-upgrade-authority'].filter(haveKey).map((n) => key(n).publicKey));
        const authority = await admin.readUpgradeAuthority(ctx.rpc, readKeypair(demoKey).publicKey).then((x) => x.authority, () => null);
        if (ours.has(authority)) log(`reusing demo program ${readKeypair(demoKey).publicKey} (upgrade authority is ours)`);
        else {
          const archive = join(KEYS, 'archive', String(Date.now()));
          mkdirSync(archive, { recursive: true, mode: 0o700 });
          renameSync(demoKey, join(archive, 'demo-program.json'));
        }
      }
      await prepareAdmin(ctx);
    }
    scenario = await impl.setup(ctx);
    scenario.network = 'devnet';
    scenario.chain = 'solana:devnet';
    writeFileSync(statePath, JSON.stringify(scenario, null, 2) + '\n');
    const name = kind === 'admin' ? 'member-a' : 'trap-user';
    const exportPath = join(KEYS, name + '.solflare.txt');
    exportSolflare(join(KEYS, name + '.json'), exportPath);
    log(`Solflare private-key import file: ${exportPath} (devnet only; contents never logged)`);
  }
  if (args.includes('--attack')) return attackAndRecycle();
  await payerReport();
  if (!args.includes('--no-serve')) return serveAttacker(kind, ctx, scenario);
  return scenario;
}
