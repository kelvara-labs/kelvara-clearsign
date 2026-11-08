#!/usr/bin/env node
// Bundle via demo:verify-intent. Read-only proof against the real prepared proposals.
import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeSession, ingestSession, createRpcAccountReader, validateIntentContext, loadRegistry } from '../.devnet/fees/intent-engine.mjs';
import { heliusDevnet } from './lib/helius.mjs';
import { PKG, REPO } from './lib/devnet.mjs';
import { FEE_STATE, feeApproval } from './demo-prepare-fees.mjs';
const rpc = await heliusDevnet(REPO);
const registry = loadRegistry({ root: REPO });
const fees = JSON.parse(readFileSync(FEE_STATE));
const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
const inputs = [
  { role: 'fees', wire: feeApproval(fees, bh.blockhash).toString('base64'), kind: 'fees' },
  { role: 'admin', wire: readFileSync(join(PKG, '.devnet/admin/approval.unsigned.b64'), 'utf8').trim(), kind: 'authority' }
];
const proofs = [];
for (const input of inputs) {
  const session = await ingestSession([{ base64: input.wire, kind: 'auto' }], { reader: createRpcAccountReader(rpc) });
  const decoded = registry.decoder.decodeSession(session).flat();
  const memo = decoded.find(ix => ix.programAddress === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  assert(memo);
  assert.equal(new TextDecoder().decode(memo.data), 'Q4 fee update');
  const approval = decoded.find(ix => ix.name === 'proposalApprove');
  assert.equal(approval?.args?.args?.memo ?? approval?.args?.memo, 'Q4 fee update');
  assert.equal(session.transactions[0].signatures[0].signer, fees.member);
  assert.equal(session.transactions[0].signatures[0].signature, null);
  const result = await analyzeSession(session, { decoder: registry.decoder, squadsAccounts: registry.squadsAccounts, authorityMaps: registry.authorityMaps, rpc, wallet: fees.member });
  const hashes = result.report.session.transactions.map(t => t.messageHash);
  assert(validateIntentContext(result.intentContext, hashes));
  const selected = result.intentContext.candidates.find(c => c.id === result.intentContext.fallbackId);
  assert.equal(selected.kind, input.kind);
  assert.match(selected.question, /proposed future/);
  assert(selected.reasons.every(r => r.evidenceIds.every(id => result.report.evidence.some(e => e.id === id))));
  assert(selected.reasons.some(r => r.evidenceIds.length));
  writeFileSync(join(PKG, '.devnet/fees/' + input.role + '-analysis.json'), JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  if (input.role === 'fees') {
    assert(selected.reasons.some(r => r.text.includes(fees.mint) && r.text.includes('75 basis points') && r.text.includes('2000000 base units')));
    assert(selected.reasons.some(r => r.evidenceIds.some(id => result.report.evidence.some(e => e.id === id && e.type === 'account' && e.address === fees.transaction))));
  }
  proofs.push({ role: input.role, unsignedTransaction: input.wire, report: result.report, intentContext: result.intentContext, reads: result.reads });
  console.log(JSON.stringify({ role: input.role, level: result.report.alert.level, selected, hashes }));
}
writeFileSync(join(PKG, '.devnet/fees/intent-proof.json'), JSON.stringify({ network: 'devnet', proofs }, null, 2) + '\n');
