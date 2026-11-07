// Minimal, dependency-free Solana helpers for localnet scenario scripts: base58, keypair files, PDAs,
// legacy transactions signed with node:crypto Ed25519, and a localnet JSON-RPC client.
// Localnet only; nothing here ever touches a mainnet key.
/* global fetch, AbortSignal, Buffer, setTimeout */
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  const b = Uint8Array.from(bytes);
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char in ${str}`);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export const pubkeyBytes = (k) => (typeof k === 'string' ? b58decode(k) : k);

// Solana CLI keypair file: JSON array of 64 bytes (32-byte seed || 32-byte public key).
export function readKeypair(path) {
  const raw = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  if (raw.length !== 64) throw new Error(`${path}: not a 64-byte keypair`);
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = b58encode(raw.subarray(32));
  return { publicKey, sign: (msg) => new Uint8Array(edSign(null, msg, key)) };
}

// --- Ed25519 on-curve check (for PDA derivation) ---
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modPow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a) {
  return modPow(a, P - 2n);
}
function isOnCurve(bytes) {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) + BigInt(b[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * modInv(v));
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n; // x^2 must be a quadratic residue
}

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

export function findProgramAddress(seeds, programId) {
  const pid = pubkeyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds, Uint8Array.of(bump), pid, Buffer.from('ProgramDerivedAddress'));
    if (!isOnCurve(h)) return [b58encode(h), bump];
  }
  throw new Error('no viable bump');
}

export const createWithSeed = (base, seed, owner) =>
  b58encode(sha256(pubkeyBytes(base), Buffer.from(seed), pubkeyBytes(owner)));

// --- legacy transaction ---
function shortvec(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

// ix: { programId, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array }
export function compileLegacy({ feePayer, instructions, recentBlockhash }) {
  const metas = new Map();
  const add = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey) ?? { pubkey, isSigner: false, isWritable: false };
    m.isSigner ||= isSigner;
    m.isWritable ||= isWritable;
    metas.set(pubkey, m);
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable);
    add(ix.programId, false, false);
  }
  const all = [...metas.values()];
  const rank = (m) => (m.isSigner ? (m.isWritable ? 0 : 1) : m.isWritable ? 2 : 3);
  const payer = all.shift();
  all.sort((a, b) => rank(a) - rank(b));
  const keys = [payer, ...all];
  const index = new Map(keys.map((k, i) => [k.pubkey, i]));
  const header = [
    keys.filter((k) => k.isSigner).length,
    keys.filter((k) => k.isSigner && !k.isWritable).length,
    keys.filter((k) => !k.isSigner && !k.isWritable).length
  ];
  const bytes = [...header, ...shortvec(keys.length)];
  for (const k of keys) bytes.push(...pubkeyBytes(k.pubkey));
  bytes.push(...b58decode(recentBlockhash));
  bytes.push(...shortvec(instructions.length));
  for (const ix of instructions) {
    bytes.push(index.get(ix.programId), ...shortvec(ix.keys.length));
    for (const k of ix.keys) bytes.push(index.get(k.pubkey));
    bytes.push(...shortvec(ix.data.length), ...ix.data);
  }
  return { message: Uint8Array.from(bytes), signers: keys.filter((k) => k.isSigner).map((k) => k.pubkey) };
}

export function signLegacy(compiled, keypairs) {
  const byKey = new Map(keypairs.map((k) => [k.publicKey, k]));
  const sigs = compiled.signers.map((pk) => {
    const kp = byKey.get(pk);
    if (!kp) throw new Error(`missing signer ${pk}`);
    return kp.sign(compiled.message);
  });
  const wire = Uint8Array.from([...shortvec(sigs.length), ...sigs.flatMap((s) => [...s]), ...compiled.message]);
  return { wire, signature: b58encode(sigs[0]) };
}

// --- localnet RPC ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function localRpc(url) {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('localRpc is localnet only');
  let id = 0;
  const call = async (method, params = []) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000)
    });
    const body = await res.json();
    if (body.error) {
      const err = new Error(`${method}: ${JSON.stringify(body.error)}`);
      err.rpcError = body.error;
      throw err;
    }
    return body.result;
  };

  async function confirm(signature, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const { value } = await call('getSignatureStatuses', [[signature]]);
      const st = value[0];
      if (st?.err) throw Object.assign(new Error(`tx ${signature} failed: ${JSON.stringify(st.err)}`), { txErr: st.err });
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
      await sleep(250);
    }
    throw new Error(`tx ${signature} not confirmed in ${timeoutMs} ms`);
  }

  async function send(instructions, feePayer, signers) {
    const { value } = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const compiled = compileLegacy({ feePayer: feePayer.publicKey, instructions, recentBlockhash: value.blockhash });
    const { wire, signature } = signLegacy(compiled, [feePayer, ...signers]);
    await call('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    await confirm(signature);
    return signature;
  }

  // Returns the simulation error (null on success). Signed for real, so sigVerify can stay on.
  async function simulate(instructions, feePayer, signers = []) {
    const { value } = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const compiled = compileLegacy({ feePayer: feePayer.publicKey, instructions, recentBlockhash: value.blockhash });
    const { wire } = signLegacy(compiled, [feePayer, ...signers]);
    const res = await call('simulateTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', commitment: 'confirmed' }]);
    return res.value.err;
  }

  async function airdrop(pubkey, lamports) {
    const sig = await call('requestAirdrop', [pubkey, lamports, { commitment: 'confirmed' }]);
    await confirm(sig);
    return sig;
  }

  return { url, call, send, simulate, confirm, airdrop };
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
