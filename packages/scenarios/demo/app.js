/* global window, document, fetch, CustomEvent, atob */
const ORDER = ['good', 'trap', 'admin', 'fees', 'sweep'];
const LEVELS = ['Clear', 'Notice', 'Warning', 'Critical', 'Blocked'];
const wallets = [];
let selected = null, account = null, scenarios = [], busy = false;
const $ = s => document.querySelector(s);
const status = text => { $('#status').textContent = text; };
function renderWallets() {
  const list = $('#wallets');
  list.replaceChildren();
  if (!wallets.length) { const o = document.createElement('option'); o.textContent = 'No Wallet Standard wallets found'; list.append(o); }
  wallets.forEach((w,i) => { const o = document.createElement('option'); o.value = i; o.textContent = w.name; list.append(o); });
}
const api = Object.freeze({ register(...items) {
  for (const w of items) if (w.features?.['standard:connect'] && w.features?.['solana:signTransaction'] && !wallets.includes(w)) wallets.push(w);
  renderWallets();
  return () => { for (const w of items) { const i = wallets.indexOf(w); if(i >= 0) wallets.splice(i,1); } renderWallets(); };
} });
window.addEventListener('wallet-standard:register-wallet', e => e.detail(api));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
const slides = () => [...document.querySelectorAll('#track > .slide, #track > .cards > .card')];
const current = () => { const t = $('#track'); return Math.max(0, Math.round(t.scrollLeft / Math.max(1, t.clientWidth))); };
function goTo(i) { const t = $('#track'); const n = slides().length; t.scrollTo({ left: Math.min(n - 1, Math.max(0, i)) * t.clientWidth }); }
function syncDeck() {
  const n = slides().length, i = Math.min(current(), n - 1), dots = $('#dots');
  if (dots.children.length !== n) {
    dots.replaceChildren(...slides().map((s, k) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'dot-btn'; b.setAttribute('role', 'tab'); b.setAttribute('aria-label', 'Slide ' + (k + 1) + ': ' + s.getAttribute('aria-label')); b.onclick = () => goTo(k); return b; }));
  }
  [...dots.children].forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
  $('#count').textContent = (i + 1) + ' / ' + n;
  $('#prev').disabled = i === 0; $('#next').disabled = i >= n - 1;
}
$('#prev').onclick = () => goTo(current() - 1);
$('#next').onclick = () => goTo(current() + 1);
$('#track').addEventListener('scroll', syncDeck, { passive: true });
window.addEventListener('resize', syncDeck);
document.addEventListener('keydown', e => { if (e.target.closest?.('select, input')) return; if (e.key === 'ArrowRight') { goTo(current() + 1); e.preventDefault(); } else if (e.key === 'ArrowLeft') { goTo(current() - 1); e.preventDefault(); } });
function render() {
  $('#cards').replaceChildren();
  for (const c of [...scenarios].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id))) {
    const card = document.createElement('article'); card.className = 'card'; card.dataset.id = c.id; card.setAttribute('aria-roledescription', 'slide'); card.setAttribute('aria-label', c.title);
    const inner = document.createElement('div'); inner.className = 'card-inner';
    const head = document.createElement('div'); head.className = 'cardhead';
    const label = document.createElement('span'); label.textContent = c.label;
    const level = document.createElement('span'); level.className = 'level-badge'; const n = /^L([0-4])$/.exec(c.expected)?.[1]; if (n) { card.dataset.lv = n; level.dataset.lv = n; const icon = document.createElement('span'); icon.className = 'level-icon'; icon.setAttribute('aria-hidden', 'true'); level.append(icon); }
    level.append(c.id === 'fees' ? 'Proposed future effect' : c.expected + ' · ' + (LEVELS[n] ?? 'Expected')); head.append(label,level);
    const title = document.createElement('h2'); title.textContent = c.title;
    const desc = document.createElement('p'); desc.className = 'desc'; desc.textContent = c.description;
    const compatible = account && account.chains.includes('solana:devnet') && account.features.includes('solana:signTransaction') && (!c.account || account.address === c.account);
    const guidance = document.createElement('div'); guidance.className = 'guidance'; guidance.textContent = !account ? 'Connect a devnet wallet to begin.' : !compatible ? 'Connect the shared demo account shown above to enable all attack previews.' : 'Account matches. Ready for a fresh preview.';
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = c.id === 'fees' ? 'Preview fee proposal approval' : c.id === 'good' ? 'Preview harmless memo' : 'Preview ' + c.expected + ' scenario'; button.disabled = !compatible || busy;
    button.onclick = () => request(c);
    inner.append(head,title,desc,guidance,button); card.append(inner); $('#cards').append(card);
  }
  syncDeck();
}
$('#wallets').onchange = () => { account=null; selected=null; $('#address').textContent='Wallet changed — connect again'; render(); };
$('#connect').onclick = async () => {
  try {
    selected = wallets[Number($('#wallets').value)];
    if(!selected) throw Error('Unlock/install Phantom, Solflare, or Backpack with Wallet Standard support, then reload.');
    const result = await selected.features['standard:connect'].connect();
    account = result.accounts.find(a => a.chains.includes('solana:devnet') && a.features.includes('solana:signTransaction'));
    if(!account) throw Error('Switch the selected wallet to devnet manually and reconnect.');
    $('#address').textContent = account.address;
    status('Connected on devnet. Check each card’s required account before requesting.');
    if(selected.features['standard:events']) selected.features['standard:events'].on('change', () => { account=null; $('#address').textContent='Wallet changed — reconnect to confirm account'; render(); });
  } catch(e) { account=null; $('#address').textContent='No compatible devnet account'; status(e.message); }
  render();
};
async function request(c) {
  busy=true; render();
  try {
    status('Building fresh ' + c.title + ' bytes…');
    const response = await fetch('/api/transaction?kind='+encodeURIComponent(c.id)+'&account='+encodeURIComponent(account.address), { cache:'no-store' });
    const data = await response.json(); if(!response.ok) throw Error(data.error);
    if(data.chain !== 'solana:devnet' || data.account !== account.address) throw Error('Transaction account/network mismatch');
    status('Preview requested. Expected '+c.expected+'. Review ClearSign and choose Block for the attack test.');
    // A wallet or review left open must not lock every card: give up waiting after 120 s (nothing is submitted either way).
    const [result] = await Promise.race([selected.features['solana:signTransaction'].signTransaction({ account, chain:'solana:devnet', transaction:Uint8Array.from(atob(data.transaction), c=>c.charCodeAt(0)) }), new Promise((_, reject) => window.setTimeout(() => reject(Error('No answer from the wallet within 120 s')), 120000))]);
    status('Wallet returned '+result.signedTransaction.length+' signed bytes. Nothing was submitted. You can repeat this preview.');
  } catch(e) { status('Preview stopped: '+e.message+' · Nothing submitted by this page.'); }
  finally { busy=false; render(); }
}
try { const r=await fetch('/api/scenarios'); if(!r.ok) throw Error('Scenario catalog unavailable'); const data=await r.json(); scenarios=data.scenarios; $('#shared-address').textContent=data.shared.account; $('#shared-import').textContent=data.shared.importFile; render(); } catch(e) { status(e.message); }
syncDeck();
