import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayground, validateAccount } from '../scripts/demo-serve.mjs';
const account = '11111111111111111111111111111111';
test('wallet addresses must be canonical 32-byte base58', () => {
  assert.equal(validateAccount(account), account);
  for (const s of ['', '0'.repeat(32), '../.env', '1'.repeat(33)]) assert.throws(() => validateAccount(s));
});
test('hub allowlists routes, host, origin, methods and wallet matches', async () => {
  const calls = [];
  const server = createPlayground({ catalog: [{ id: 'trap', account }], transaction: async (kind, address) => { calls.push([kind,address]); return { transaction: 'fresh' }; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, ...options }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/api/scenarios', { headers: { Host: `localhost:${port}` } })).status, 200);
    for (const path of ['/.env', '/.keys/devnet-payer.json', '/api/transaction?kind=unknown&account='+account, '/app.js?x=1']) assert.equal((await request(path)).status, 404);
    assert.equal((await request('/', { headers: { Host: 'evil.test' } })).status, 403);
    assert.equal((await request('/api/scenarios', { headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request('/', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await request('/', { method: 'POST' })).status, 403);
    assert.equal((await request('/api/transaction?kind=trap&account=bad')).status, 400);
    assert.equal((await request('/api/transaction?kind=trap&account=So11111111111111111111111111111111111111112')).status, 409);
    assert.equal(calls.length, 0);
    for (let i=0;i<2;i++) assert.equal((await request(`/api/transaction?kind=trap&account=${account}`, { headers: { Origin: `http://localhost:${port}` } })).status, 200);
    assert.equal(calls.length, 2, 'builder invoked per request, no cached wire');
    assert.equal((await request(`/api/transaction?kind=trap&account=${account}&extra=1`)).status, 400);
  } finally { await new Promise(r => server.close(r)); }
});

test('shared account requires the actual Member A signer and approval payer', async () => {
  const { sharedAccount } = await import('../scripts/demo-prepare.mjs');
  const admin = { members: { A: account }, approval: { feePayer: account } };
  assert.equal(sharedAccount(admin, { publicKey: account }), account);
  assert.throws(() => sharedAccount(admin, { publicKey: 'different' }), /does not match/);
  assert.throws(() => sharedAccount({ ...admin, approval: { feePayer: 'different' } }, { publicKey: account }), /does not match/);
});
