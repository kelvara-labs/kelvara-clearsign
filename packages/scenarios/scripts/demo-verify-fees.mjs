#!/usr/bin/env node
/* global Buffer */
// Reads public devnet state and simulates unsigned approval only. Never submits.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtime, PKG } from './lib/devnet.mjs';
import { FEE_STATE, feeApproval, readFeeConfig } from './demo-prepare-fees.mjs';
import { readProposal, SQUADS_PROGRAM } from './lib/squads.mjs';
import { MEMO } from './admin-local.mjs';
const { rpc } = await runtime('admin');
const state = JSON.parse(readFileSync(FEE_STATE));
const admin = JSON.parse(readFileSync(join(PKG, '.devnet/admin/scenario.json')));
const { value } = await rpc.call('getMultipleAccounts', [[state.mint, state.transaction, state.proposal, admin.proposal], { encoding: 'base64', commitment: 'confirmed' }]);
assert(value.every(Boolean));
const bytes = value.map(a => Buffer.from(a.data[0], 'base64'));
assert.equal(value[1].owner, SQUADS_PROGRAM);
assert(bytes[1].includes(Buffer.from(state.innerDataHex, 'hex')), 'real stored transaction contains fee instruction');
assert.equal(readProposal(bytes[2]).status, 'Active');
assert.equal(readProposal(bytes[3]).status, 'Active');
const config = readFeeConfig(bytes[0]);
assert.deepEqual(config, state.config);
assert.equal(config.authority, state.vault);
assert.equal(state.member, admin.members.A);
assert.equal(state.memo, MEMO);
const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
const wire = feeApproval(state, bh.blockhash);
assert(wire.includes(Buffer.from(MEMO)));
assert.equal(wire.subarray(1, 65).every(x => x === 0), true);
const simulation = await rpc.call('simulateTransaction', [wire.toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false }]);
assert.equal(simulation.value.err, null);
writeFileSync(join(PKG, '.devnet/fees/approval.unsigned.b64'), wire.toString('base64') + '\n');
console.log(JSON.stringify({ verified: true, mint: state.mint, proposal: state.proposal, config, proposed: state.proposed, simulation: simulation.value, unsignedFile: 'packages/scenarios/.devnet/fees/approval.unsigned.b64' }));
