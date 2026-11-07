// Offline check of fixtures/poison (no network): manifest matches files, no api key, and every claim in a case
// is re-derived from its own recorded RPC results (transfers, lookalike match, dust, no prior send, empty
// recipient history for first sends). Returns a list of failure strings.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT } from './manifest.mjs';
import { isDust, lookalike, transfersOf } from './poison.mjs';

const SCHEMA = 'kelvara.fixture.poison/v1';

function txFrom(calls, signature) {
  return calls.find((c) => c.method === 'getTransaction' && c.params[0] === signature)?.result ?? null;
}

export function verifyPoisonFixtures({ minPoisoning = 5, minFirstSend = 20 } = {}) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const mpath = join(FIXTURES_ROOT, 'poison', 'manifest.json');
  if (!existsSync(mpath)) return ['poison/manifest.json missing'];
  const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
  if (manifest.count !== manifest.cases.length) fail('poison manifest count mismatch');
  for (const e of manifest.cases) {
    const path = join(FIXTURES_ROOT, e.path);
    if (!existsSync(path)) {
      fail(`${e.path}: missing`);
      continue;
    }
    const raw = readFileSync(path);
    if (/api-key|helius-rpc\.com/i.test(raw.toString('utf8'))) fail(`${e.path}: contains an RPC URL or api key`);
    if (createHash('sha256').update(raw).digest('hex') !== e.sha256) fail(`${e.path}: sha256 differs from manifest`);
    const r = JSON.parse(raw);
    if (r.schema !== SCHEMA) fail(`${e.path}: schema ${r.schema}`);
    const calls = r.calls ?? [];
    const histSigs = new Set((r.history?.signatures ?? []).map((s) => s.signature));
    const historyTxs = calls.filter((c) => c.method === 'getTransaction' && histSigs.has(c.params[0])).map((c) => c.result);
    const sentBefore = historyTxs.some((t) => transfersOf(t).some((x) => x.from === r.user && x.to === r.recipient));
    if (r.kind === 'poisoning') {
      const real = txFrom(calls, r.realTransfer.signature);
      const dust = txFrom(calls, r.dust.signature);
      if (!real || !dust) {
        fail(`${e.path}: real or dust tx not recorded`);
        continue;
      }
      if (!transfersOf(real).some((t) => t.from === r.user && t.to === r.lookalikeOf)) fail(`${e.path}: real transfer not user -> lookalikeOf`);
      if (!transfersOf(dust).some((t) => t.from === r.recipient && t.to === r.user && isDust(t))) fail(`${e.path}: no dust recipient -> user`);
      const m = lookalike(r.recipient, r.lookalikeOf);
      if (!m.match || m.prefix !== r.match.prefix || m.suffix !== r.match.suffix) fail(`${e.path}: lookalike match differs`);
      if (!histSigs.has(r.dust.signature) || !histSigs.has(r.realTransfer.signature)) fail(`${e.path}: history lacks dust or real transfer`);
      if (sentBefore) fail(`${e.path}: user sent to the recipient before`);
      if (r.request) {
        const req = txFrom(calls, r.request.signature);
        if (!req || !transfersOf(req).some((t) => t.from === r.user && t.to === r.recipient)) fail(`${e.path}: request is not user -> recipient`);
      }
      if (r.expect?.level !== 'L4' || r.expect?.rule !== 'address.poisoning') fail(`${e.path}: expect`);
    } else if (r.kind === 'first-send') {
      const tx = txFrom(calls, r.transfer.signature);
      if (!tx || !transfersOf(tx).some((t) => t.from === r.user && t.to === r.recipient)) fail(`${e.path}: transfer not user -> recipient`);
      const prior = calls.find((c) => c.method === 'getSignaturesForAddress' && c.params[0] === r.recipient);
      if (!prior || prior.params[1]?.before !== r.transfer.signature || prior.result.length !== 0) fail(`${e.path}: recipient history before the transfer not proven empty`);
      if (sentBefore) fail(`${e.path}: user sent to the recipient before`);
      if (!r.expect?.notL4) fail(`${e.path}: expect.notL4 missing`);
      const txf = join(FIXTURES_ROOT, r.request.txFixture);
      if (!existsSync(txf) || JSON.parse(readFileSync(txf, 'utf8')).signature !== r.transfer.signature) fail(`${e.path}: tx fixture ${r.request.txFixture} missing`);
    } else fail(`${e.path}: unknown kind ${r.kind}`);
  }
  const nP = manifest.cases.filter((c) => c.kind === 'poisoning' && c.network === 'mainnet').length;
  const nF = manifest.cases.filter((c) => c.kind === 'first-send').length;
  if (nP < minPoisoning) fail(`mainnet poisoning cases: ${nP}/${minPoisoning}`);
  if (nF < minFirstSend) fail(`first-send cases: ${nF}/${minFirstSend}`);
  return failures;
}
