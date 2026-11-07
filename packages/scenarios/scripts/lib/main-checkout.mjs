// Resolve shared secrets in place: worktree common-dir first, then local clone origins.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function mainCheckout(repoRoot, resource) {
  const seen = new Set();
  let checkout = repoRoot;
  let first;
  while (!seen.has(checkout)) {
    seen.add(checkout);
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const main = resolve(common, '..');
    first ??= main;
    if (existsSync(resolve(main, resource))) return main;
    let origin;
    try {
      origin = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // Remote URLs (including scp syntax) are never fetched or contacted.
      const local = origin.startsWith('file://') ? fileURLToPath(origin) : origin;
      if (!isAbsolute(local) && !local.startsWith('.')) break;
      checkout = resolve(checkout, local);
      if (!existsSync(checkout)) break;
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: checkout, stdio: 'ignore' });
    } catch {
      break;
    }
  }
  return first;
}
