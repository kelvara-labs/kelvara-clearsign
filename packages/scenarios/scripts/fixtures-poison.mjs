#!/usr/bin/env node
/* global Buffer */
// Address-poisoning fixtures for engine E9 / gate G3 (PLAN.md M2 3d, M6). Real chain data only.
//   pnpm --filter @kelvara/scenarios fixtures:poison [--refresh] [--only poisoning|first-send|devnet]
//
// Cases are pinned by signature in poison-cases.mjs (found with Helius history; see fixtures/README.md).
// Every case is re-checked here from the raw responses before it is written:
//  - poisoning: the victim sent a real transfer to R; afterwards L sent the victim dust; L looks like R
//    (lookalike(): >= 5 chars across start and end, >= 2 each side); the victim never sent to L in the window.
//  - first-send: a real wallet transfer whose recipient had no signature at all before it, so the sender can
//    never have sent to it before; it must stay below L4.
//  - devnet: the scenario:poison-devnet run whose user really sent 0.5 SOL to the lookalike (the request).
// Output: fixtures/poison/<kind>/<anchor signature>.json (schema kelvara.fixture.poison/v1), each with the raw
// RPC calls {method, params, result} made exactly as packages/core/src/rpc/methods.ts makes them, so a replaying
// reader answers by method + params. First-send request txs also go to fixtures/tx/mainnet/first-send/ as normal
// kelvara.fixture.tx/v1 fixtures (benign set). Helius only; the key is never written (checked before each write).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heliusDevnet, heliusMainnet, loadHeliusKey } from './lib/helius.mjs';
import { FIXTURES_ROOT, writeManifest } from './lib/manifest.mjs';
import { getJsonTx, isDust, lookalike, sigParams, transfersOf } from './lib/poison.mjs';
import { DEVNET_CASES, FIRST_SENDS, POISONINGS } from './poison-cases.mjs';
import { parseWireTransaction } from './wire.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const OUT = join(FIXTURES_ROOT, 'poison');
export const SCHEMA = 'kelvara.fixture.poison/v1';
const HISTORY_MAX = 50; // signatures listed before the anchor; txs fetched down to the real transfer
const FIRST_SEND_HISTORY = 10;

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const log = (...a) => console.log('[fixtures:poison]', ...a);

function guardKey(text) {
  const key = loadHeliusKey(REPO);
  if (text.includes(key) || /api-key=/i.test(text)) throw new Error('refusing to write a fixture containing an api key');
  return text;
}

function write(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, guardKey(JSON.stringify(obj, null, 2) + '\n'));
  log('wrote', relative(REPO, path));
}

// Recorder: the same call shape as the engine, keeping every {method, params, result}.
function recorder(rpcCall) {
  const calls = [];
  const call = async (method, params) => {
    const result = await rpcCall(method, params);
    calls.push({ method, params, result });
    return result;
  };
  const tx = async (signature) => {
    const { calls: c, result } = await getJsonTx(rpcCall, signature);
    calls.push(...c);
    if (!result) throw new Error(`getTransaction ${signature}: null`);
    return result;
  };
  return { calls, call, tx };
}

const sigInfo = (signature, tx) => ({ signature, slot: tx.slot, blockTime: tx.blockTime ?? null, err: tx.meta?.err ?? null });

// History of `user` before `anchor`: the signature page plus every tx down to and including `stopAt`.
async function historyBefore(r, user, anchor, stopAt, limit) {
  const page = await r.call('getSignaturesForAddress', sigParams(user, { limit, before: anchor }));
  const txs = [];
  for (const s of page) {
    txs.push(await r.tx(s.signature));
    if (s.signature === stopAt) return { page, txs, complete: true };
  }
  return { page, txs, complete: !stopAt };
}

async function recordPoisoning(c, network, rpcCall) {
  const r = recorder(rpcCall);
  const anchor = c.request ?? c.dust;
  const request = c.request ? await r.tx(c.request) : null;
  const dust = await r.tx(c.dust);
  const real = await r.tx(c.real);
  const { page, txs, complete } = await historyBefore(r, c.user, c.request ?? c.dust, c.real, HISTORY_MAX);
  if (!complete) throw new Error(`${anchor}: real transfer ${c.real} not within ${HISTORY_MAX} signatures before the anchor`);
  if (c.request && !page.some((s) => s.signature === c.dust)) throw new Error(`${anchor}: dust not in the history before the request`);

  // Checks, all from the recorded data.
  const realT = transfersOf(real).find((t) => t.from === c.user && t.to === c.lookalikeOf);
  if (!realT) throw new Error(`${anchor}: ${c.real} has no transfer ${c.user} -> ${c.lookalikeOf}`);
  const dustT = transfersOf(dust).find((t) => t.from === c.lookalike && t.to === c.user && isDust(t));
  if (!dustT) throw new Error(`${anchor}: ${c.dust} has no dust ${c.lookalike} -> ${c.user}`);
  if (!(real.slot <= dust.slot)) throw new Error(`${anchor}: dust before the real transfer`);
  const m = lookalike(c.lookalike, c.lookalikeOf);
  if (!m.match) throw new Error(`${anchor}: ${c.lookalike} does not look like ${c.lookalikeOf}`);
  const window = c.request ? txs : [dust, ...txs];
  if (window.some((t) => transfersOf(t).some((x) => x.from === c.user && x.to === c.lookalike))) throw new Error(`${anchor}: user sent to the lookalike before`);
  let requestT = null;
  if (request) {
    requestT = transfersOf(request).find((t) => t.from === c.user && t.to === c.lookalike);
    if (!requestT) throw new Error(`${anchor}: request is not a transfer to the lookalike`);
  }
  const history = c.request ? page : [sigInfo(c.dust, dust), ...page];
  return {
    schema: SCHEMA,
    kind: 'poisoning',
    network,
    id: `${network}-poisoning-${anchor.slice(0, 8)}`,
    ...(c.label ? { label: c.label } : {}),
    user: c.user,
    recipient: c.lookalike,
    lookalikeOf: c.lookalikeOf,
    match: { prefix: m.prefix, suffix: m.suffix },
    realTransfer: { signature: c.real, slot: real.slot, blockTime: real.blockTime ?? null, ...realT },
    dust: { signature: c.dust, slot: dust.slot, blockTime: dust.blockTime ?? null, ...dustT },
    request: request
      ? { signature: c.request, slot: request.slot, executed: true, ...requestT }
      : null,
    requestNote: request ? 'the user really sent to the lookalike (executed on chain)' : 'no send to the lookalike observed; analyze a transfer user -> recipient against this history',
    expect: { rule: 'address.poisoning', level: 'L4' },
    history: { user: c.user, asOf: anchor, includesAnchor: !c.request, signatures: history, txsFetchedDownTo: c.real },
    fetchedAt: new Date().toISOString(),
    source: network === 'devnet' ? 'helius-devnet' : 'helius-mainnet',
    calls: r.calls
  };
}

async function recordFirstSend(c, rpcCall) {
  const r = recorder(rpcCall);
  const tx = await r.tx(c.signature);
  if (tx.meta?.err) throw new Error(`${c.signature}: failed on chain`);
  const ts = transfersOf(tx).filter((t) => t.from === c.user && !isDust(t));
  const t = ts.find((x) => x.to === c.recipient);
  if (!t) throw new Error(`${c.signature}: no transfer ${c.user} -> ${c.recipient}`);
  const prior = await r.call('getSignaturesForAddress', sigParams(c.recipient, { limit: 1, before: c.signature }));
  if (prior.length) throw new Error(`${c.signature}: recipient had history before (${prior[0].signature})`);
  const { page, txs } = await historyBefore(r, c.user, c.signature, null, FIRST_SEND_HISTORY);
  if (txs.some((h) => transfersOf(h).some((x) => x.from === c.user && x.to === c.recipient))) throw new Error(`${c.signature}: sent before`);
  // Base64 copy of the same tx for fixtures/tx (wire bytes).
  const b64 = await rpcCall('getTransaction', [c.signature, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  const bytes = Buffer.from(b64.transaction[0], 'base64');
  const wire = parseWireTransaction(bytes);
  if (wire.signatures[0] !== c.signature) throw new Error(`${c.signature}: wire signature mismatch`);
  const programId = t.kind === 'sol' ? '11111111111111111111111111111111' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const txFixture = {
    schema: 'kelvara.fixture.tx/v1',
    network: 'mainnet',
    signature: c.signature,
    slot: b64.slot,
    blockTime: b64.blockTime ?? null,
    fetchedAt: new Date().toISOString(),
    source: 'helius:getTransaction',
    program: t.kind === 'sol' ? { slug: 'system', programId, priority: 'P0', name: 'System' } : { slug: 'spl-token', programId, priority: 'P0', name: 'SPL Token' },
    encoding: 'base64',
    transaction: b64.transaction[0],
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: b64.version ?? 'legacy',
    invocation: 'top-level',
    meta: b64.meta,
    label: `first-time ${t.kind === 'sol' ? 'SOL' : 'stablecoin'} transfer to a new address`,
    tags: ['first-send', 'benign']
  };
  const context = {
    schema: SCHEMA,
    kind: 'first-send',
    network: 'mainnet',
    id: `mainnet-first-send-${c.signature.slice(0, 8)}`,
    user: c.user,
    recipient: c.recipient,
    transfer: { signature: c.signature, slot: tx.slot, blockTime: tx.blockTime ?? null, ...t },
    request: { signature: c.signature, executed: true, txFixture: `tx/mainnet/first-send/${c.signature}.json` },
    proof: 'getSignaturesForAddress(recipient, before: request, limit 1) is empty: the recipient had no transaction before this one',
    expect: { rule: 'address.first_send', level: 'L1', notL4: true, notRules: ['address.poisoning', 'address.dust_sender'] },
    history: { user: c.user, asOf: c.signature, includesAnchor: false, signatures: page },
    fetchedAt: new Date().toISOString(),
    source: 'helius-mainnet',
    calls: r.calls
  };
  return { txFixture, context };
}

const want = (k) => !ONLY || ONLY.includes(k);
let failed = 0;
const tryCase = async (path, fn) => {
  if (existsSync(path) && !REFRESH) return;
  try {
    await fn();
  } catch (e) {
    failed++;
    log(`FAIL ${relative(REPO, path)}: ${e?.message ?? e}`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mainnet = (want('poisoning') || want('first-send')) && heliusMainnet(REPO);
  if (want('poisoning')) {
    for (const c of POISONINGS) {
      const p = join(OUT, 'mainnet', `${c.dust}.json`);
      await tryCase(p, async () => write(p, await recordPoisoning(c, 'mainnet', mainnet)));
    }
  }
  if (want('devnet') && DEVNET_CASES.length) {
    const dev = await heliusDevnet(REPO);
    for (const c of DEVNET_CASES) {
      const p = join(OUT, 'devnet', `${c.request}.json`);
      await tryCase(p, async () => write(p, await recordPoisoning(c, 'devnet', dev.call)));
    }
  }
  if (want('first-send')) {
    for (const c of FIRST_SENDS) {
      const p = join(OUT, 'first-send', `${c.signature}.json`);
      await tryCase(p, async () => {
        const { txFixture, context } = await recordFirstSend(c, mainnet);
        write(join(FIXTURES_ROOT, 'tx', 'mainnet', 'first-send', `${c.signature}.json`), txFixture);
        write(p, context);
      });
    }
    writeManifest();
  }
  writePoisonManifest();
  if (failed) {
    log(`${failed} case(s) failed`);
    process.exitCode = 1;
  }
}

export function writePoisonManifest() {
  const cases = [];
  for (const kind of ['mainnet', 'devnet', 'first-send']) {
    const dir = join(OUT, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSafe(dir)) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      cases.push({
        path: `poison/${kind}/${f}`,
        id: r.id,
        kind: r.kind,
        network: r.network,
        user: r.user,
        recipient: r.recipient,
        ...(r.lookalikeOf ? { lookalikeOf: r.lookalikeOf, match: r.match } : {}),
        request: r.request?.signature ?? null,
        ...(r.request?.txFixture ? { txFixture: r.request.txFixture } : {}),
        expect: r.expect,
        sha256: createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
      });
    }
  }
  cases.sort((a, b) => a.path.localeCompare(b.path));
  const m = { schema: 'kelvara.fixture.poison-manifest/v1', engineTask: 'E9', gate: 'G3', count: cases.length, cases };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  log(`poison manifest: ${cases.filter((c) => c.kind === 'poisoning').length} poisoning, ${cases.filter((c) => c.kind === 'first-send').length} first-send`);
}

function readdirSafe(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}
