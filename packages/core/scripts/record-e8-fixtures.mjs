/* global Buffer */
// Localnet-only E8 evidence. Fresh throwaway keys stay in .keys; every case is actually executed.
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { localRpc, readKeypair, compileLegacy, signLegacy } from '../../scenarios/scripts/lib/tx.mjs';
import { createAccount, initializeMint2, initializePermanentDelegate, createAtaIdempotent, ataAddress, mintTo, transferChecked, systemTransfer, TOKEN_2022 } from '../../scenarios/scripts/lib/token2022.mjs';
const root = resolve('../..');
const dir = resolve(root, '.keys/localnet/e8');
mkdirSync(dir, { recursive: true, mode: 0o700 });
function key(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const p = resolve(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  return readKeypair(p);
}
const rpc = localRpc('http://localhost:8899');
const payer = key('payer'), user = key('user'), outsider = key('outsider');
await rpc.airdrop(payer.publicKey, 10e9); await rpc.airdrop(user.publicKey, 1e9);
const cases = [];
const meta = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const tokenIx = (data, keys) => ({ programId: TOKEN_2022, data: Buffer.from(data), keys });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
async function snapshot(addresses) { return (await rpc.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value; }
async function record(name, instructions, feePayer = payer, signers = [], extras = {}) {
  if (["owner-takeover","assign-takeover","sweep"].includes(name)) {
    const nonce = key(`nonce-${name}`);
    const { b58decode } = await import("../../scenarios/scripts/lib/tx.mjs");
    const system = "11111111111111111111111111111111";
    const recent = "SysvarRecentB1ockHashes11111111111111111111";
    const rent = "SysvarRent111111111111111111111111111111111";
    const amount = await rpc.call("getMinimumBalanceForRentExemption",[80]);
    await rpc.send([createAccount(payer.publicKey,nonce.publicKey,amount,80,system),{programId:system,keys:[meta(nonce.publicKey,false,true),meta(recent),meta(rent)],data:Buffer.concat([Buffer.from([6,0,0,0]),Buffer.from(b58decode(feePayer.publicKey))])}],payer,[nonce]);
    instructions=[{programId:system,keys:[meta(nonce.publicKey,false,true),meta(recent),meta(feePayer.publicKey,true)],data:Buffer.from([4,0,0,0])},...instructions];
  }
  const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  let blockhash = bh.blockhash;
  if (instructions[0]?.data[0] === 4 && instructions[0]?.programId === "11111111111111111111111111111111") {
    const [raw] = await snapshot([instructions[0].keys[0].pubkey]);
    const { b58encode } = await import("../../scenarios/scripts/lib/tx.mjs");
    blockhash = b58encode(Buffer.from(raw.data[0],"base64").subarray(40,72));
  }
  const compiled = compileLegacy({ feePayer: feePayer.publicKey, instructions, recentBlockhash: blockhash });
  const { wire, signature } = signLegacy(compiled, [feePayer, ...signers]);
  const addresses = [...new Set(instructions.flatMap(i => i.keys.map(k => k.pubkey)))];
  const pre = Object.fromEntries(addresses.map((a,i) => [a,i]));
  const accounts = await snapshot(addresses);
  const fee = (await rpc.call('getFeeForMessage', [Buffer.from(compiled.message).toString('base64'), { commitment: 'confirmed' }])).value;
  await rpc.call('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  await rpc.confirm(signature);
  cases.push({ name, signature, transaction: Buffer.from(wire).toString('base64'), wallet: user.publicKey, accounts: Object.fromEntries(Object.keys(pre).map((a,i) => [a,accounts[i]])), fee, ...extras });
  console.log(name, signature);
}
async function mint(name, extensions, length, freeze = null) {
  const m = key(name);
  const rent = await rpc.call('getMinimumBalanceForRentExemption', [length]);
  await rpc.send([createAccount(payer.publicKey, m.publicKey, rent, length, TOKEN_2022), ...extensions(m.publicKey), initializeMint2(m.publicKey, 6, payer.publicKey, freeze)], payer, [m]);
  return m.publicKey;
}
const plain = await mint('plain', () => [], 82);
await rpc.send([createAtaIdempotent(payer.publicKey, user.publicKey, plain), createAtaIdempotent(payer.publicKey, outsider.publicKey, plain), mintTo(plain, ataAddress(user.publicKey, plain), payer.publicKey, 1000n)], payer, []);
await record("receive-plain", [createAtaIdempotent(payer.publicKey,user.publicKey,plain)],payer);
const source = ataAddress(user.publicKey, plain), dest = ataAddress(outsider.publicKey, plain);
await record('approve-bounded', [tokenIx([4, ...u64(25n)], [meta(source,false,true),meta(outsider.publicKey),meta(user.publicKey,true)])], user);
await record('approve-unlimited', [tokenIx([13, ...u64(2n**64n-1n), 6], [meta(source,false,true),meta(plain),meta(outsider.publicKey),meta(user.publicKey,true)])], user);
await record('revoke', [tokenIx([5], [meta(source,false,true),meta(user.publicKey,true)])], user);
await record('benign-partial-send', [systemTransfer(user.publicKey, outsider.publicKey, 1_000_000)], user);
const inventory = [];
for (const programId of [TOKEN_2022, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]) inventory.push(...(await rpc.call("getTokenAccountsByOwner", [user.publicKey, { programId }, { encoding: "base64", commitment: "confirmed" }])).value);
const balance = (await snapshot([user.publicKey]))[0].lamports;
// Same instruction/signature shape on both sides: fee depends on signatures, not the transfer amount.
const { value: bh } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
const sweepIxs = [transferChecked(source, plain, dest, user.publicKey, 1000n,6), systemTransfer(user.publicKey,outsider.publicKey,1)];
const comp = compileLegacy({ feePayer:user.publicKey,instructions:sweepIxs,recentBlockhash:bh.blockhash });
const fee = (await rpc.call('getFeeForMessage',[Buffer.from(comp.message).toString('base64'),{commitment:'confirmed'}])).value;
sweepIxs[1] = systemTransfer(user.publicKey,outsider.publicKey,balance-fee);
await record('sweep', sweepIxs, user, [], { inventory, inventoryComplete: true });
await rpc.airdrop(user.publicKey, 1e9);
// AccountOwner and CloseAccount hand-offs, on distinct actual accounts.
await record('close-authority-takeover', [tokenIx([6,3,1,...Buffer.from((await import('../../scenarios/scripts/lib/tx.mjs')).b58decode(outsider.publicKey))], [meta(source,false,true),meta(user.publicKey,true)])],user);
const mutable = key('mutable-token-account');
const { b58decode } = await import('../../scenarios/scripts/lib/tx.mjs');
const accountRent = await rpc.call('getMinimumBalanceForRentExemption', [165]);
await rpc.send([createAccount(payer.publicKey,mutable.publicKey,accountRent,165,TOKEN_2022),tokenIx([18,...b58decode(user.publicKey)],[meta(mutable.publicKey,false,true),meta(plain)])],payer,[mutable]);
await record('owner-takeover', [tokenIx([6,2,1,...b58decode(outsider.publicKey)], [meta(mutable.publicKey,false,true),meta(user.publicKey,true)])],user);
const assigned = key('assigned'); await rpc.airdrop(assigned.publicKey,1e9);
await record('assign-takeover', [{programId:'11111111111111111111111111111111',keys:[meta(assigned.publicKey,true,true)],data:Buffer.concat([Buffer.from([1,0,0,0]),Buffer.from((await import('../../scenarios/scripts/lib/tx.mjs')).b58decode(TOKEN_2022))])}], assigned, [], {wallet:assigned.publicKey});
const traps = [
 ['permanent', m=>[initializePermanentDelegate(m,outsider.publicKey)],202,null],
 ['freeze', ()=>[],82,outsider.publicKey],
 ['hook', m=>[tokenIx([36,0,...Buffer.alloc(32),...Buffer.from((globalThis.hookBytes))], [meta(m,false,true)])],234,null],
 ['frozen', m=>[tokenIx([28,0,2],[meta(m,false,true)])],171,payer.publicKey],
 ['nontransferable', m=>[tokenIx([32],[meta(m,false,true)])],170,null]
];
globalThis.hookBytes = b58decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
for (const [name,ext,len,freeze] of traps) {
 const m = await mint(name,ext,len,freeze);
 await record(`receive-${name}`, [createAtaIdempotent(payer.publicKey,user.publicKey,m)],payer);
}
writeFileSync(resolve('test/fixtures/rules/e8-localnet.json'),JSON.stringify({network:'localnet',source:'Executed on solana-test-validator by record-e8-fixtures.mjs',cases},null,2)+'\n');
console.log(`Recorded ${cases.length} executed cases.`);
