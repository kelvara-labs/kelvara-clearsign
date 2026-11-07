// fixtures/tx/manifest.json: one entry per fixture file, rebuilt from the files themselves, so any field a
// consumer relies on (e2e role, tags, network) lives in the fixture record and survives a rebuild.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
export const TX_FIXTURES = join(FIXTURES_ROOT, 'tx');

export function walkFixtures(dir = TX_FIXTURES) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json') && e.name !== 'manifest.json') files.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

export function writeManifest() {
  const entries = walkFixtures()
    .map((f) => {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      return {
        path: relative(FIXTURES_ROOT, f),
        signature: r.signature,
        slot: r.slot,
        slug: r.program.slug,
        programId: r.program.programId,
        priority: r.program.priority,
        invocation: r.invocation,
        sha256: r.sha256,
        ...(r.network && r.network !== 'mainnet' ? { network: r.network } : {}),
        ...(r.label ? { label: r.label } : {}),
        ...(r.tags ? { tags: r.tags } : {}),
        ...(r.e2e ? { e2e: r.e2e } : {})
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    join(TX_FIXTURES, 'manifest.json'),
    JSON.stringify({ schema: 'kelvara.fixture.manifest/v1', count: entries.length, fixtures: entries }, null, 2) + '\n'
  );
  console.log(`manifest: ${entries.length} fixtures`);
  return entries;
}
