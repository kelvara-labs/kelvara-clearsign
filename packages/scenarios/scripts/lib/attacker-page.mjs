import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBuy, partialSign } from '../trap-local.mjs';
import { readKeypair } from './tx.mjs';

// Wallet Standard transports actual wire bytes, preserving seller signatures;
// no CDN, browser dependency, RPC key, or wallet secret is served.
export function attackerHtml(kind, expected) {
  const title = { admin: 'Ops Portal', trap: '$SHINY launch', sweep: 'Claim airdrop' }[kind];
  const pitch = { admin: 'Council proposal: Q4 fee update', trap: 'Buy 50,000 SHINY for 1 devnet SOL', sweep: 'You are eligible for the season airdrop. Sign once to claim.' }[kind];
  const button = { admin: 'Approve Q4 fee update', trap: 'Buy SHINY', sweep: 'Claim airdrop' }[kind];
  return `<!doctype html><html><meta charset="utf-8"><title>${title}</title>
<style>body{font:18px system-ui;background:#101827;color:#edf5ff;max-width:700px;margin:12vh auto;padding:32px}button{font:inherit;padding:16px;background:#b4ff65;border:0;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>${title}</h1><p>Devnet demonstration</p><p>${pitch}</p>
<button id="sign">${button}</button><pre id="status">Connect the imported devnet account.</pre>
<script type="module">
const wallets = [];
const api = Object.freeze({register(...items){wallets.push(...items);return () => {};}});
window.addEventListener('wallet-standard:register-wallet', e => e.detail(api));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {detail:api}));
document.querySelector('#sign').onclick = async () => {
 const status = document.querySelector('#status');
 try {
  const wallet = wallets.find(w => /solflare/i.test(w.name));
  if (!wallet) throw Error('Solflare Wallet Standard unavailable; unlock the wallet by hand and reload.');
  const connected = await wallet.features['standard:connect'].connect();
  const account = connected.accounts.find(a => a.address === ${JSON.stringify(expected)});
  if (!account) throw Error('Import/select the scenario devnet account first: ' + ${JSON.stringify(expected)});
  if (!account.chains.includes('solana:devnet')) throw Error('Switch Solflare to devnet by hand.');
  const response = await fetch('/transaction', {cache:'no-store'});
  if (!response.ok) throw Error(await response.text());
  const {transaction} = await response.json();
  const bytes = Uint8Array.from(atob(transaction), c => c.charCodeAt(0));
  const [result] = await wallet.features['solana:signTransaction'].signTransaction({account,chain:'solana:devnet',transaction:bytes});
  status.textContent = 'Wallet signed ' + result.signedTransaction.length + ' bytes. This preview does not submit; use the script attack command for the unprotected story.';
 } catch(e) { status.textContent = e.message; }
};
</script></html>`;
}
export function serveAttacker(kind, ctx, scenario, { port = { admin: 8781, trap: 8782, sweep: 8783 }[kind] } = {}) {
  if (!['admin', 'trap', 'sweep'].includes(kind)) throw new Error('unknown attacker page');
  const expected = kind === 'admin' ? scenario.members.A : scenario.user;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Resist DNS rebinding and serve only these two public routes.
    const allowed = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    if (!allowed.includes(req.headers.host) || req.method !== 'GET') { res.writeHead(403); res.end('Forbidden'); return; }
    try {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(attackerHtml(kind, expected)); return; }
      if (req.url !== '/transaction') { res.writeHead(404); res.end('Not found'); return; }
      let wire;
      if (kind === 'admin') wire = readFileSync(join(ctx.out, 'approval.unsigned.b64'), 'utf8').trim();
      // The sweep is rebuilt from the user's current balances on a fresh blockhash per click.
      else if (kind === 'sweep') wire = ctx.sweepWire ? await ctx.sweepWire() : readFileSync(join(ctx.out, 'sweep.unsigned.b64'), 'utf8').trim();
      else {
        const { value: bh } = await ctx.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        const seller = readKeypair(join(ctx.keys, 'trap-seller.json'));
        wire = partialSign(buildBuy({user: scenario.user, seller: scenario.seller, mint: scenario.token.mint, recentBlockhash: bh.blockhash}).compiled, seller).toString('base64');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ chain: 'solana:devnet', transaction: wire }));
    } catch { res.writeHead(500); res.end('Transaction unavailable; check the scenario terminal.'); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`[${kind}-devnet] attacker page http://localhost:${server.address().port} (Ctrl-C stops)`));
  return server;
}
