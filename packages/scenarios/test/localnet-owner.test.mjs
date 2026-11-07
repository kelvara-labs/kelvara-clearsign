// Offline checks of the localnet ownership logic (scripts/localnet.mjs): which validators on our ports were started
// by our scripts, in this checkout or another one, and which must never be touched. Uses a fake /proc tree.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findScriptValidators, foreignValidator, parseValidatorCmdline } from '../scripts/localnet.mjs';

const MY_LEDGER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.localnet', 'ledger');
const argv = (...a) => a.join('\0') + '\0';
const validator = (ledger, port = 8899, faucet = 9900) =>
  argv('solana-test-validator', '--ledger', ledger, '--reset', '--rpc-port', String(port), '--faucet-port', String(faucet));

function fakeProc(t, procs) {
  const root = mkdtempSync(join(tmpdir(), 'kelvara-proc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [pid, cmdline] of Object.entries(procs)) {
    mkdirSync(join(root, 'proc', pid), { recursive: true });
    writeFileSync(join(root, 'proc', pid, 'cmdline'), cmdline);
  }
  mkdirSync(join(root, 'proc', 'self'), { recursive: true });
  return { proc: join(root, 'proc'), root };
}
function checkoutLedger(root, name, pid) {
  const dir = join(root, name, 'packages', 'scenarios', '.localnet');
  mkdirSync(join(dir, 'ledger'), { recursive: true });
  if (pid != null) writeFileSync(join(dir, 'validator.pid'), String(pid));
  return join(dir, 'ledger');
}

test('parseValidatorCmdline: only solana-test-validator, with ledger and ports', () => {
  assert.deepEqual(parseValidatorCmdline(validator('/x/ledger', 8899, 9900)), { ledger: '/x/ledger', rpcPort: 8899, faucetPort: 9900 });
  assert.deepEqual(parseValidatorCmdline(argv('/usr/bin/solana-test-validator', '--ledger', 'l')), { ledger: 'l', rpcPort: 8899, faucetPort: 9900 });
  assert.equal(parseValidatorCmdline(argv('node', 'solana-test-validator', '--ledger', 'l')), null);
  assert.equal(parseValidatorCmdline(argv('agave-validator', '--ledger', 'l')), null);
  assert.equal(parseValidatorCmdline(''), null);
});

test('another checkout\'s script-started validator is foreign and ours to take over', (t) => {
  const f = fakeProc(t, {});
  const ledger = checkoutLedger(f.root, 'other', 4242);
  mkdirSync(join(f.proc, '4242'));
  writeFileSync(join(f.proc, '4242', 'cmdline'), validator(ledger));
  const v = foreignValidator({ procRoot: f.proc, ports: [8899, 9900] });
  assert.ok(v);
  assert.equal(v.pid, 4242);
  assert.equal(v.checkout, join(f.root, 'other'));
  assert.equal(v.ours, true);
  assert.equal(v.mine, false);
});

test('never touched: no pid file, wrong pid file, foreign ledger path, other process, other ports', (t) => {
  const f = fakeProc(t, {});
  const noPid = checkoutLedger(f.root, 'a', null);
  const wrongPid = checkoutLedger(f.root, 'b', 999);
  const add = (pid, cmd) => {
    mkdirSync(join(f.proc, String(pid)));
    writeFileSync(join(f.proc, String(pid), 'cmdline'), cmd);
  };
  add(11, validator(noPid));
  add(12, validator(wrongPid));
  add(13, validator(join(f.root, 'elsewhere', 'test-ledger')));
  add(14, argv('python3', '-m', 'http.server', '8899'));
  const other = checkoutLedger(f.root, 'c', 15);
  add(15, validator(other, 18899, 19900));
  const all = findScriptValidators({ procRoot: f.proc, ports: [8899, 9900] });
  assert.deepEqual(all.map((v) => v.pid).sort(), [11, 12, 13]);
  assert.ok(all.every((v) => !v.ours));
  assert.equal(foreignValidator({ procRoot: f.proc, ports: [8899, 9900] }), null);
});

test('this checkout\'s own validator is mine, not foreign', (t) => {
  const f = fakeProc(t, {});
  mkdirSync(join(f.proc, '77'));
  writeFileSync(join(f.proc, '77', 'cmdline'), validator(MY_LEDGER));
  const [v] = findScriptValidators({ procRoot: f.proc, ports: [8899, 9900] });
  assert.equal(v.mine, true);
  assert.equal(foreignValidator({ procRoot: f.proc, ports: [8899, 9900] }), null);
});
