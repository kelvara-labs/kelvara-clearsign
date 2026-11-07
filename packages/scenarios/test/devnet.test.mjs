/* global Buffer, fetch */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportSolflare } from '../scripts/lib/devnet.mjs';
import { serveAttacker, attackerHtml } from '../scripts/lib/attacker-page.mjs';
import { b58decode } from '../scripts/lib/tx.mjs';

test('Solflare export preserves all 64 bytes in base58, private permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devnet-export-'));
  try {
    const raw = Array.from({ length: 64 }, (_, i) => i);
    const input = join(dir, 'key.json'), output = join(dir, 'key.solflare.txt');
    writeFileSync(input, JSON.stringify(raw));
    exportSolflare(input, output);
    assert.deepEqual([...b58decode(readFileSync(output, 'utf8').trim())], raw);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(statSync(input).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true }); }
});

test('attacker server serves exact approval bytes, denies secrets, traversal and foreign Host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devnet-page-'));
  const wire = Buffer.alloc(100, 42).toString('base64');
  writeFileSync(join(dir, 'approval.unsigned.b64'), wire);
  const server = serveAttacker('admin', { out: dir }, { members: { A: 'MemberA' } }, { port: 0 });
  await once(server, 'listening');
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const tx = await (await fetch(url + '/transaction')).json();
    assert.equal(tx.transaction, wire);
    assert.equal(tx.chain, 'solana:devnet');
    for (const path of ['/.keys/devnet/member-a.json', '/scenario.json', '/%2e%2e/.env']) assert.equal((await fetch(url + path)).status, 404);
    const foreignStatus = await new Promise((resolve, reject) => {
      const req = request(url, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignStatus, 403);
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    const html = await (await fetch(url)).text();
    assert.ok(html.includes('solana:signTransaction'));
    assert.ok(html.includes('solana:devnet'));
    assert.ok(!html.includes('signAndSendTransaction'));
    assert.ok(!html.includes('api-key='));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true }); }
});

test('both wallet pages name the scenario and require the imported account', () => {
  assert.match(attackerHtml('admin', 'test-account'), /Ops Portal/);
  assert.match(attackerHtml('trap', 'test-account'), /\$SHINY launch/);
  assert.match(attackerHtml('trap', 'test-account'), /test-account/);
});
