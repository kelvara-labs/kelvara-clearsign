#!/usr/bin/env node
// Fetches real mainnet transactions over Helius and stores them as fixtures (PLAN.md M1, "The real tests").
//   pnpm --filter @kelvara/scenarios fixtures:fetch [--refresh] [--only <slug>[,<slug>]] [--count 5]
// Per program: getSignaturesForAddress -> getTransaction (base64, v0), successful txs only, preferring txs
// that invoke the program at top level and distinct instruction discriminators. Existing fixtures are kept
// unless --refresh, so reruns only top up. Drift's attack txs are fetched by signature.
// Helius only. The key comes from the main checkout's .env and is never logged or written.
/* global fetch, AbortSignal, Buffer, setTimeout */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAMS, DRIFT_REPLAY } from './fixture-programs.mjs';
import { parseWireTransaction } from './wire.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const FIXTURES = join(repoRoot, 'fixtures', 'tx');
const SCHEMA = 'kelvara.fixture.tx/v1';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const REFRESH = flag('--refresh');
const COUNT = Number(opt('--count') ?? 5);
const ONLY = opt('--only')?.split(',');
const REPLAY_SIGS = new Set(DRIFT_REPLAY.map((r) => r.signature)); // never reused as benign fixtures
const SIG_SCAN = 100; // signatures listed per program
const MAX_TX_FETCH = 25; // getTransaction calls per program before settling

const redact = (s) => String(s).replace(/api-key=[^&\s"]*/gi, 'api-key=REDACTED');

function loadKey() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim();
  const envPath = resolve(common, '..', '.env');
  if (!existsSync(envPath)) throw new Error('no .env in the main checkout; set HELIUS_API_KEY there');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*HELIUS_API_KEY\s*=\s*"?([^"\s#]+)"?/.exec(line);
    if (m) return m[1];
  }
  throw new Error('HELIUS_API_KEY missing from .env');
}

const RPC = `https://mainnet.helius-rpc.com/?api-key=${loadKey()}`;
if (new URL(RPC).hostname !== 'mainnet.helius-rpc.com') throw new Error('Helius only');

// Helius mainnet throttles near 10 rps and the key is shared with other tools: pace to ~6 rps, back off on 429.
const MIN_INTERVAL_MS = 170;
let rpcId = 0;
let lastCall = 0;
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (e) {
      if (attempt < 5) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${method}: ${redact(e?.message ?? e)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 7) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${redact(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${redact(JSON.stringify(body.error))}`);
    return body.result;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Asks for v0 first; if the node reports a newer version (v1 exists on mainnet), asks again allowing it.
async function getTx(signature) {
  const cfg = (v) => ({ encoding: 'base64', maxSupportedTransactionVersion: v, commitment: 'confirmed' });
  let result;
  try {
    result = await rpc('getTransaction', [signature, cfg(0)]);
  } catch (e) {
    if (!/version/i.test(String(e?.message))) throw e;
    result = await rpc('getTransaction', [signature, cfg(1)]);
  }
  if (result) Object.defineProperty(result, '__signature', { value: signature, enumerable: false });
  return result;
}

// Classifies how a tx touches programId and returns its discriminator there, if any.
// v1 messages are not parsed locally yet: their invocation is read from a jsonParsed copy of the same tx.
async function inspect(result, programId) {
  if (result.version !== undefined && result.version !== 'legacy' && result.version !== 0) {
    const bytes = Buffer.from(result.transaction[0], 'base64');
    const parsed = await rpc('getTransaction', [
      result.transaction.signature ?? result.__signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: result.version, commitment: 'confirmed' }
    ]);
    const msg = parsed.transaction.message;
    const top = msg.instructions.filter((ix) => ix.programId === programId);
    const inner = (parsed.meta?.innerInstructions ?? [])
      .flatMap((g) => g.instructions)
      .filter((ix) => ix.programId === programId);
    const tx = { signatures: parsed.transaction.signatures };
    return { bytes, tx, invocation: top.length ? 'top-level' : inner.length ? 'inner' : 'none', disc: null, v1: true };
  }
  const bytes = Buffer.from(result.transaction[0], 'base64');
  const tx = parseWireTransaction(bytes);
  const loaded = result.meta?.loadedAddresses ?? { writable: [], readonly: [] };
  const keys = [...tx.staticAccountKeys, ...loaded.writable, ...loaded.readonly];
  const top = tx.instructions.filter((ix) => keys[ix.programIdIndex] === programId);
  const inner = (result.meta?.innerInstructions ?? [])
    .flatMap((g) => g.instructions)
    .filter((ix) => keys[ix.programIdIndex] === programId);
  const first = top[0] ?? null;
  const data = first ? first.data : null;
  // Anchor programs use 8-byte discriminators; native programs mostly 1-4 bytes. 8 covers both for diversity.
  const disc = data ? Buffer.from(data.subarray(0, 8)).toString('hex') : null;
  return { bytes, tx, invocation: top.length ? 'top-level' : inner.length ? 'inner' : 'none', disc };
}

function fixtureRecord({ result, program, inv, label }) {
  const record = {
    schema: SCHEMA,
    network: 'mainnet',
    signature: result.transaction ? inv.tx.signatures[0] : undefined,
    slot: result.slot,
    blockTime: result.blockTime ?? null,
    fetchedAt: new Date().toISOString(),
    source: 'helius:getTransaction',
    program,
    encoding: 'base64',
    transaction: result.transaction[0],
    sha256: createHash('sha256').update(inv.bytes).digest('hex'),
    version: result.version ?? 'legacy',
    invocation: inv.invocation,
    meta: result.meta
  };
  if (label) record.label = label;
  return record;
}

function writeFixture(dir, record) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.signature}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return path;
}

const existing = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];

// Where to list candidate signatures for a program. Helius rejects getSignaturesForAddress on some native
// program IDs ("Address is not supported"), so those programs list the history of real accounts they own.
async function historySources(p) {
  if (p.history === 'programdata') {
    // Upgrades, authority changes and closes name the ProgramData account; ordinary calls do not.
    const out = [];
    for (const id of p.historyPrograms) {
      const info = await rpc('getAccountInfo', [id, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const pd = info?.value?.data?.parsed?.info?.programData;
      if (pd) out.push(pd);
    }
    return out;
  }
  if (p.history === 'lookup-tables') {
    // Lookup tables referenced by the v0 fixtures already fetched; their history holds create/extend txs.
    const tables = new Set();
    for (const f of walkFixtures()) {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      if (r.version !== 0) continue;
      for (const l of parseWireTransaction(Buffer.from(r.transaction, 'base64')).lookups) tables.add(l.account);
    }
    return [...tables].slice(0, 40);
  }
  return [p.programId];
}

async function listCandidates(p, skip) {
  const out = [];
  const seen = new Set(skip);
  const sources = await historySources(p);
  const pages = p.pages ?? 1;
  for (const address of sources) {
    let before = p.before;
    for (let page = 0; page < pages; page++) {
      const cfg = { limit: SIG_SCAN, commitment: 'confirmed' };
      if (before) cfg.before = before;
      const sigs = await rpc('getSignaturesForAddress', [address, cfg]);
      const mark = out.length;
      for (const s of sigs) {
        if (s.err === null && !seen.has(s.signature) && !REPLAY_SIGS.has(s.signature)) {
          seen.add(s.signature);
          out.push(s.signature);
        }
      }
      if (p.history === 'lookup-tables') {
        // Only tables whose whole history fits in one page: their oldest txs are the create/extend calls.
        const added = out.splice(mark);
        if (sigs.length < SIG_SCAN) out.push(...added.reverse());
        break;
      }
      if (sigs.length < SIG_SCAN) break;
      before = sigs[sigs.length - 1].signature;
    }
  }
  return { signatures: out, sources: sources.length };
}

async function fetchProgram(p) {
  const dir = join(FIXTURES, 'mainnet', p.slug);
  if (REFRESH) rmSync(dir, { recursive: true, force: true });
  const have = existing(dir).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const haveDiscs = new Set(have.map((r) => r.discriminator).filter(Boolean));
  let haveV1 = have.filter((r) => r.version === 1).length;
  if (have.length >= COUNT) {
    console.log(`${p.slug}: ${have.length} fixtures present, skipping`);
    return;
  }
  const { signatures, sources } = await listCandidates(p, have.map((r) => r.signature));
  const fresh = []; // top level, new discriminator (or the one v1 tx we keep per program)
  const spare = []; // everything else usable, best first
  let fetched = 0;
  const skipped = { none: 0, v1: 0, failed: 0 };
  const maxFetch = p.maxFetch ?? MAX_TX_FETCH;
  for (const sig of signatures) {
    if (have.length + fresh.length >= COUNT || fetched >= maxFetch) break;
    const result = await getTx(sig);
    fetched++;
    if (!result || result.meta?.err) {
      skipped.failed++;
      continue;
    }
    const inv = await inspect(result, p.programId);
    if (inv.invocation === 'none') {
      skipped.none++;
      if (process.env.DEBUG_FIXTURES) console.log(`  ${p.slug}: ${sig} v${result.version} does not invoke the program`);
      continue;
    }
    if (inv.tx.signatures[0] !== sig) throw new Error(`${p.slug}: signature mismatch for ${sig}`);
    const entry = { result, inv };
    if (inv.v1) {
      if (inv.invocation === 'top-level' && haveV1 === 0) {
        haveV1++;
        fresh.push(entry);
      } else skipped.v1++;
      continue; // at most one v1 tx per program; prefer v0 and legacy for coverage
    }
    if (inv.invocation === 'top-level' && !haveDiscs.has(inv.disc)) {
      haveDiscs.add(inv.disc);
      fresh.push(entry);
    } else spare.push(entry);
  }
  spare.sort((a, b) => (a.inv.invocation === 'top-level' ? 0 : 1) - (b.inv.invocation === 'top-level' ? 0 : 1));
  const chosen = [...fresh, ...spare].slice(0, COUNT - have.length);
  const program = { slug: p.slug, programId: p.programId, priority: p.priority, name: p.name };
  for (const { result, inv } of chosen) {
    const rec = fixtureRecord({ result, program, inv });
    rec.discriminator = inv.disc;
    writeFixture(dir, rec);
  }
  const total = have.length + chosen.length;
  const top = chosen.filter((c) => c.inv.invocation === 'top-level').length;
  const v1 = chosen.filter((c) => c.inv.v1).length;
  console.log(
    `${p.slug}: +${chosen.length} (top-level ${top}, v1 ${v1}) total ${total}; ${signatures.length} candidate sigs from ${sources} source(s), ${fetched} getTransaction; skipped ${JSON.stringify(skipped)}`
  );
  if (total < COUNT) console.log(`WARN ${p.slug}: only ${total}/${COUNT} usable txs found`);
}

async function fetchReplay() {
  const dir = join(FIXTURES, 'drift-replay');
  const drift = PROGRAMS.find((p) => p.slug === 'drift-v2');
  for (const r of DRIFT_REPLAY) {
    const path = join(dir, `${r.signature}.json`);
    if (existsSync(path) && !REFRESH) {
      console.log(`drift-replay ${r.label}: present`);
      continue;
    }
    const result = await getTx(r.signature);
    if (!result) {
      console.log(`FAIL drift-replay ${r.label}: getTransaction returned null (see PLAN.md Risks)`);
      process.exitCode = 1;
      continue;
    }
    const inv = await inspect(result, r.programId ?? drift.programId);
    if (inv.tx.signatures[0] !== r.signature) throw new Error(`drift-replay: signature mismatch for ${r.signature}`);
    const program = { slug: r.slug, programId: r.programId, priority: 'P0', name: r.programName };
    const rec = fixtureRecord({ result, program, inv, label: r.label });
    rec.role = r.role;
    rec.reference = r.reference;
    rec.attackStep = true;
    if (r.optional) rec.inG8 = false;
    writeFixture(dir, rec);
    console.log(`drift-replay ${r.label}: slot ${result.slot}, ${inv.invocation}, err ${JSON.stringify(result.meta?.err)}`);
  }
}

function walkFixtures() {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json') && e.name !== 'manifest.json') files.push(p);
    }
  };
  if (existsSync(FIXTURES)) walk(FIXTURES);
  return files;
}

function writeManifest() {
  const files = walkFixtures();
  const entries = files
    .map((f) => {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      return {
        path: relative(join(repoRoot, 'fixtures'), f),
        signature: r.signature,
        slot: r.slot,
        slug: r.program.slug,
        programId: r.program.programId,
        priority: r.program.priority,
        invocation: r.invocation,
        sha256: r.sha256,
        ...(r.label ? { label: r.label } : {})
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    join(FIXTURES, 'manifest.json'),
    JSON.stringify({ schema: 'kelvara.fixture.manifest/v1', count: entries.length, fixtures: entries }, null, 2) + '\n'
  );
  console.log(`manifest: ${entries.length} fixtures`);
}

// Lookup-table history is discovered from the other fixtures, so it runs last.
const targets = PROGRAMS.filter((p) => p.fetch !== false && (!ONLY || ONLY.includes(p.slug))).sort(
  (a, b) => (a.history === 'lookup-tables') - (b.history === 'lookup-tables')
);
for (const p of targets) {
  try {
    await fetchProgram(p);
  } catch (e) {
    console.log(`FAIL ${p.slug}: ${redact(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
if (!ONLY || ONLY.includes('drift-replay')) await fetchReplay();
writeManifest();
