// Offline checks of the G6 gate's assertions (scripts/test-localnet.mjs): rule ids, levels and addresses decide,
// never wording. The live run is `pnpm test:localnet`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdmin, checkTrap } from '../scripts/test-localnet.mjs';

const sim = { status: 'ok', summary: 'Simulation shows: Transaction 0: A -0.000005 SOL' };
const claim = (ruleId, statement = ruleId) => ({ ruleId, statement });
const admin = (claims, alertLevel = 'L3') => ({ alertLevel, report: { simulation: sim, claims } });
const s = { attacker: 'ATTACKER', creator: 'CREATOR' };
const adminClaims = () => [
  claim('authority.transfer', 'Proposed setAuthority program.upgrade: X gives authority to ATTACKER.'),
  claim('lifetime.durable_nonce'), claim('nonce.staged_by_outsider'), claim('squads.zero_timelock_execution'),
];

test('admin: passes with the four required claims at L3', () => assert.doesNotThrow(() => checkAdmin(admin(adminClaims()), s)));
test('admin: names the missing rule id', () =>
  assert.throws(() => checkAdmin(admin(adminClaims().filter((c) => c.ruleId !== 'nonce.staged_by_outsider')), s), /missing claim nonce\.staged_by_outsider/));
test('admin: wrong level fails', () => assert.throws(() => checkAdmin(admin(adminClaims(), 'L2'), s), /expected L3/));
test('admin: authority.transfer must name the attacker', () => {
  const c = adminClaims(); c[0] = claim('authority.transfer', 'setAuthority to SOMEONE');
  assert.throws(() => checkAdmin(admin(c), s), /does not name/);
});
test('admin: failed simulation fails', () =>
  assert.throws(() => checkAdmin({ alertLevel: 'L3', report: { simulation: { status: 'error' }, claims: adminClaims() } }, s), /simulation status/));
test('trap: L2 with delegate + freeze naming the creator', () => {
  const r = admin([claim('token2022.permanent_delegate', 'Permanent delegate CREATOR'), claim('token.freeze_authority', 'Freeze authority CREATOR')], 'L2');
  assert.doesNotThrow(() => checkTrap(r, s));
  assert.throws(() => checkTrap({ ...r, report: { ...r.report, claims: r.report.claims.slice(0, 1) } }, s), /missing claim token\.freeze_authority/);
});
