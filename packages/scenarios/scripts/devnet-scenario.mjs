import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtime, prepareAdmin, exportSolflare, KEYS } from './lib/devnet.mjs';
import { serveAttacker } from './lib/attacker-page.mjs';
import * as admin from './admin-local.mjs';
import * as trap from './trap-local.mjs';

export async function run(kind, args = process.argv.slice(2)) {
  const unknown = args.filter(a => !['--reset', '--attack', '--attack-only', '--no-serve', '--serve-only'].includes(a));
  if (unknown.length) throw new Error('unknown options: ' + unknown.join(' '));
  if (args.includes('--reset') && (args.includes('--attack-only') || args.includes('--serve-only'))) throw new Error('--reset requires setup');
  const ctx = await runtime(kind);
  const impl = kind === 'admin' ? admin : trap;
  const statePath = join(ctx.out, 'scenario.json');
  let scenario;
  if (args.includes('--attack-only')) return impl.attack(ctx);
  if (args.includes('--serve-only')) scenario = JSON.parse(readFileSync(statePath, 'utf8'));
  else {
    if (existsSync(statePath) && !args.includes('--reset')) throw new Error('scenario already exists; use --serve-only, --attack-only, or --reset for fresh accounts');
    if (args.includes('--reset') && existsSync(ctx.out)) {
      renameSync(ctx.out, ctx.out + '-archive-' + Date.now());
    }
    if (kind === 'admin') {
      if (args.includes('--reset') && existsSync(join(KEYS, 'demo-program.json'))) {
        const archive = join(KEYS, 'archive', String(Date.now()));
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        renameSync(join(KEYS, 'demo-program.json'), join(archive, 'demo-program.json'));
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
    console.log(`[${kind}-devnet] Solflare private-key import file: ${exportPath} (devnet only; contents never logged)`);
  }
  if (args.includes('--attack')) return impl.attack(ctx);
  if (!args.includes('--no-serve')) return serveAttacker(kind, ctx, scenario);
  return scenario;
}
