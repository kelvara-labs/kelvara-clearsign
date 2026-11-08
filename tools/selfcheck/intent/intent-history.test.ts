// Independent V14 regression. Synthetic mutations of recorded history are unit tests, not live RPC proof.
import { it, expect } from 'vitest';
import type { Address } from '@solana/kit';
import { buildIntentContext, ReportBuilder } from '../../../packages/core/src/index.js';
import { decoder } from '../../../packages/core/test/rules-helpers.js';
import { requestCase, poisonManifest } from '../../../packages/core/test/address-helpers.js';

it('counts successful exact outgoing one-lamport payments while excluding incoming dust, failures and lookalikes', async () => {
  const fixture = poisonManifest.cases.find((c) => c.kind === 'poisoning' && c.network === 'devnet')!;
  const { session, state } = await requestCase(fixture);
  const history = structuredClone(state.history!);
  const payment = history.outgoing.find((t) => t.to === fixture.lookalikeOf)!;
  expect(payment).toBeDefined();
  const decoded = decoder.decodeSession(session);
  decoded.flat().find((ix) => ix.name === 'transferSol')!.accounts.find((a) => a.name === 'destination')!.address = payment.to as Address;
  const report = new ReportBuilder(session).build();
  const readCount = () => {
    const intent = buildIntentContext({ session, decoded, state: { ...state, history }, report, decoder });
    return Number(intent.candidates.find((c) => c.kind === 'transfer')!.reasons[0]!.text.match(/(\d+) successful outgoing/)![1]);
  };
  const before = readCount();
  expect(before).toBeGreaterThan(0);
  const add = (signature: string, fields: Partial<typeof payment>, failed = false) => {
    history.outgoing.push({ ...payment, signature, ...fields });
    history.read.push(signature);
    history.signatures.push({ ...history.signatures[0]!, signature, err: failed ? { InstructionError: [0, 'synthetic'] } : null });
  };
  add('verifier-unit-one-lamport', { amount: 1n });
  expect(readCount()).toBe(before + 1);
  add('verifier-unit-incoming-dust', { amount: 1n, from: payment.to, to: history.wallet });
  add('verifier-unit-failed-outgoing', { amount: 1n }, true);
  add('verifier-unit-lookalike', { amount: 1n, to: fixture.recipient });
  expect(readCount()).toBe(before + 1);
  // The same signature cannot inflate the transaction count, even if repeated in extraction.
  history.outgoing.push({ ...payment, signature: 'verifier-unit-one-lamport', amount: 1n });
  expect(readCount()).toBe(before + 1);
});
