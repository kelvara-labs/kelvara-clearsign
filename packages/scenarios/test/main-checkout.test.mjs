import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mainCheckout } from '../scripts/lib/main-checkout.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
test('shared resources resolve through common-dir and local clone origins without copying', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'scenario-checkout-'));
  try {
    const main = join(tmp, 'main');
    mkdirSync(main);
    git(main, 'init');
    git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    mkdirSync(join(main, '.keys'));
    // Only marker files: this test never reads a real key or keypair.
    writeFileSync(join(main, '.env'), 'marker');
    writeFileSync(join(main, '.keys/devnet-payer.json'), 'marker');
    const worktree = join(tmp, 'worktree');
    git(main, 'worktree', 'add', '-b', 'worker', worktree);
    const clone = join(tmp, 'clone');
    git(tmp, 'clone', worktree, clone);
    for (const resource of ['.env', '.keys/devnet-payer.json']) {
      assert.equal(mainCheckout(main, resource), main);
      assert.equal(mainCheckout(worktree, resource), main);
      assert.equal(mainCheckout(clone, resource), main);
      assert.equal(existsSync(join(clone, resource)), false);
    }
    git(clone, 'remote', 'set-url', 'origin', pathToFileURL(worktree).href);
    assert.equal(mainCheckout(clone, '.keys/devnet-payer.json'), main);
    git(clone, 'remote', 'set-url', 'origin', '../worktree');
    assert.equal(mainCheckout(clone, '.env'), main);
    writeFileSync(join(clone, '.env'), 'local marker');
    assert.equal(mainCheckout(clone, '.env'), clone);
    git(clone, 'remote', 'set-url', 'origin', clone);
    assert.equal(mainCheckout(clone, 'missing'), clone); // cycle terminates
    git(clone, 'remote', 'set-url', 'origin', 'https://example.invalid/repo.git');
    assert.equal(mainCheckout(clone, '.keys/devnet-payer.json'), clone);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
