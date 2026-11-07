#!/usr/bin/env node
// G6 gate (`pnpm test:localnet`): both demo stories on localnet, end to end, through the real CLI.
//  1. Localnet: reuse it when `localnet check` passes, else a fresh `localnet up` (ledger reset), as test:e2e does.
//  2. Admin: fresh scenario:admin-local setup -> `kelvara analyze --network localnet --json` on the unsigned
//     approval -> L3 with authority.transfer (setAuthority to the attacker), lifetime.durable_nonce,
//     nonce.staged_by_outsider, squads.zero_timelock_execution and a "Simulation shows" line from an ok simulation.
//     Then the attack runs: the proposal executes and the demo program's upgrade authority is the attacker.
//  3. Trap: fresh scenario:trap-local setup -> analyze --wallet <user> on the seller-signed buy -> L2 with
//     token2022.permanent_delegate + token.freeze_authority naming the creator, "Simulation shows" line. Then the
//     attack runs: the buy lands, the creator pulls the 50,000 SHINY back with the permanent delegate and freezes.
// Asserts levels, rule ids and addresses, never wording. Prints `G6 localnet PASS|FAIL <seconds> ...`, exit 0 / 1.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '../..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'kelvara.mjs');
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);

class GateFail extends Error {}
const fail = (msg) => { throw new GateFail(msg); };
const missing = (ruleId) => fail(`missing claim ${ruleId}`);
const ok = (msg) => console.log(`[G6] ok  ${msg}`);

export function analyze(file, { wallet } = {}) {
  const args = [CLI, 'analyze', '--network', 'localnet', '--json'];
  if (wallet) args.push('--wallet', wallet);
  args.push(file);
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) fail(`kelvara analyze ${file} exit ${r.status ?? r.signal}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(0, 5).join(' | ')}`);
  let out;
  try { out = JSON.parse(r.stdout); } catch { fail(`kelvara analyze ${file}: stdout is not JSON`); }
  if (out.kind !== 'kelvara.cli.result/v1' || !out.report) fail(`kelvara analyze ${file}: unexpected result kind ${out.kind}`);
  return out;
}

// Pure checks on a CLI result, exported for the offline unit test.
export function claimOf(result, ruleId, mustMention = []) {
  const claims = (result.report.claims ?? []).filter((c) => c.ruleId === ruleId);
  if (!claims.length) missing(ruleId);
  const hit = claims.find((c) => mustMention.every((s) => c.statement.includes(s)));
  if (!hit) fail(`claim ${ruleId} does not name ${mustMention.join(', ')}`);
  return hit;
}

export function checkSimulation(result, label) {
  const sim = result.report.simulation;
  if (sim?.status !== 'ok') fail(`${label}: simulation status ${sim?.status ?? 'missing'}, expected ok`);
  if (!/^Simulation shows/.test(sim.summary ?? '')) fail(`${label}: no "Simulation shows" line`);
}

export function checkAdmin(result, s) {
  if (result.alertLevel !== 'L3') fail(`admin approval is ${result.alertLevel}, expected L3 critical`);
  claimOf(result, 'authority.transfer', ['setAuthority', s.attacker]);
  claimOf(result, 'lifetime.durable_nonce');
  claimOf(result, 'nonce.staged_by_outsider');
  claimOf(result, 'squads.zero_timelock_execution');
  checkSimulation(result, 'admin approval');
}

export function checkTrap(result, s) {
  if (result.alertLevel !== 'L2') fail(`trap purchase is ${result.alertLevel}, expected L2 warning`);
  claimOf(result, 'token2022.permanent_delegate', [s.creator]);
  claimOf(result, 'token.freeze_authority', [s.creator]);
  checkSimulation(result, 'trap purchase');
}

async function main() {
  if (!existsSync(CLI)) fail(`no CLI at ${CLI}; run pnpm build`);
  const { check, up } = await import('./localnet.mjs');
  const { localRpc } = await import('./lib/tx.mjs');
  try {
    await check({ quiet: true });
    ok('localnet healthy, reusing it');
  } catch (e) {
    console.log(`[G6] localnet not ready (${e?.message ?? e}); starting a fresh one`);
    await up();
  }

  // Story 1: Squads upgrade hijack.
  const admin = await import('./admin-local.mjs');
  const a = await admin.setup();
  const ar = analyze(join(PKG, '.localnet', 'admin', 'approval.unsigned.b64'));
  checkAdmin(ar, a);
  ok(`admin approval ${ar.alertLevel} ${ar.level}: ${ar.report.claims.map((c) => c.ruleId).join(', ')}`);
  ok(`admin ${ar.report.simulation.summary}`);
  const aa = await admin.attack();
  const auth = (await admin.readUpgradeAuthority(localRpc(a.rpcUrl), a.demoProgram)).authority;
  if (aa.upgradeAuthorityAfter !== a.attacker || auth !== a.attacker) fail(`after the attack the upgrade authority is ${auth}, expected attacker ${a.attacker}`);
  ok(`attack: proposal executed, demo program upgrade authority is now the attacker ${a.attacker}`);

  // Story 2: Token-2022 trap token.
  const trap = await import('./trap-local.mjs');
  const t = await trap.setup();
  const tr = analyze(join(PKG, '.localnet', 'trap', 'buy.partial.b64'), { wallet: t.user });
  checkTrap(tr, t);
  ok(`trap purchase ${tr.alertLevel} ${tr.level}: ${tr.report.claims.map((c) => c.ruleId).join(', ')}`);
  ok(`trap ${tr.report.simulation.summary.split('; ').slice(0, 4).join('; ')}`);
  const ta = await trap.attack();
  const acc = await trap.readTokenAccount(localRpc(t.rpcUrl), t.userAta);
  if (ta.userAmountAfterBuy !== trap.BUY_AMOUNT.toString()) fail(`buy left the user with ${ta.userAmountAfterBuy} SHINY, expected ${trap.BUY_AMOUNT}`);
  if (acc.amount !== 0n || ta.userAccountState !== 'Frozen') fail(`after the pull-back the user holds ${acc.amount} (state ${ta.userAccountState}), expected 0 and Frozen`);
  ok(`attack: buy landed (${ta.userAmountAfterBuy} base units), creator pulled it all back and froze the account`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
    console.log(`G6  localnet     PASS     ${secs()}`);
    process.exit(0);
  } catch (e) {
    console.log(`G6  localnet     FAIL     ${secs()}  ${e instanceof GateFail ? e.message : (e?.stack ?? e)}`);
    process.exit(1);
  }
}
