// Address-poisoning helpers shared by fixtures-poison.mjs (mainnet) and poison-devnet.mjs (devnet).
// The lookalike rule mirrors PLAN.md M2 3d (address.poisoning): two different addresses share at least 5
// characters across the start and the end, at least 2 on each side.

/** Common prefix and suffix lengths of two base58 addresses, and whether they count as a lookalike. */
export function lookalike(a, b) {
  if (a === b) return { prefix: a.length, suffix: a.length, match: false };
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix, match: prefix >= 2 && suffix >= 2 && prefix + suffix >= 5 };
}

/** PLAN.md M2 3d dust threshold for SOL. */
export const DUST_MAX_LAMPORTS = 1_000_000; // 0.001 SOL

// Calls exactly as the engine's rpc/methods.ts makes them (getSignaturesForAddress with limit + commitment
// confirmed; getTransaction encoding json, maxSupportedTransactionVersion 0), so a replaying reader can answer
// by exact method + params. v1 transactions need maxSupportedTransactionVersion 1; that call is recorded too.
export const sigParams = (address, { limit, before } = {}) => [
  address,
  { limit, commitment: 'confirmed', ...(before ? { before } : {}) }
];
export const txParams = (signature, v = 0) => [signature, { encoding: 'json', maxSupportedTransactionVersion: v, commitment: 'confirmed' }];

/** Fetch a json-encoded tx, falling back to v1. Returns { calls, result }. */
export async function getJsonTx(call, signature) {
  const calls = [];
  try {
    const result = await call('getTransaction', txParams(signature, 0));
    calls.push({ method: 'getTransaction', params: txParams(signature, 0), result });
    return { calls, result };
  } catch (e) {
    if (!/version/i.test(String(e?.message))) throw e;
    const result = await call('getTransaction', txParams(signature, 1));
    calls.push({ method: 'getTransaction', params: txParams(signature, 1), result });
    return { calls, result };
  }
}

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Minimal base58 decode for instruction data in json-encoded txs.
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHA.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
const u64 = (d, o) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
};

/**
 * Value transfers in a json-encoded getTransaction result (top-level and inner):
 * [{ kind: 'sol'|'token', from, to, amount (string), mint? }]. For tokens, from/to are the owners
 * (authority and the destination's owner from token balances).
 */
export function transfersOf(tx) {
  const msg = tx.transaction.message;
  const keys = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const balances = [...(tx.meta?.postTokenBalances ?? []), ...(tx.meta?.preTokenBalances ?? [])];
  const ownerOf = (i) => balances.find((b) => b.accountIndex === i)?.owner;
  const mintOf = (i) => balances.find((b) => b.accountIndex === i)?.mint;
  const ixs = [...msg.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
  const out = [];
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex];
    const acc = ix.accounts;
    let d;
    try {
      d = b58(ix.data);
    } catch {
      continue;
    }
    if (program === SYSTEM && d.length >= 12 && d[0] === 2 && d[1] === 0 && d[2] === 0 && d[3] === 0) {
      out.push({ kind: 'sol', from: keys[acc[0]], to: keys[acc[1]], amount: u64(d, 4).toString() });
    } else if ((program === TOKEN || program === TOKEN_2022) && (d[0] === 3 || d[0] === 12)) {
      // Transfer: [source, destination, authority]; TransferChecked: [source, mint, destination, authority]
      const [src, dst, auth, mint] = d[0] === 3 ? [acc[0], acc[1], acc[2], null] : [acc[0], acc[2], acc[3], acc[1]];
      out.push({
        kind: 'token',
        from: keys[auth] ?? ownerOf(src),
        to: ownerOf(dst) ?? null,
        toTokenAccount: keys[dst],
        mint: mint != null ? keys[mint] : (mintOf(dst) ?? mintOf(src) ?? null),
        amount: u64(d, 1).toString()
      });
    }
  }
  return out;
}

// Stablecoins whose $0.01 dust bound needs no price lookup (6 decimals): USDC, USDT.
export const STABLECOINS = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
export const STABLE_DUST_MAX = 10_000n; // $0.01

/** Dust per PLAN.md M2 3d, without the DAS price lookup: SOL <= 0.001, a zero-amount token transfer, or a
 * USDC/USDT transfer worth <= $0.01. Other tokens are not called dust here (the engine prices them via DAS). */
export const isDust = (t) => {
  const a = BigInt(t.amount);
  if (t.kind === 'sol') return a > 0n && a <= BigInt(DUST_MAX_LAMPORTS);
  return a === 0n || (STABLECOINS.has(t.mint) && a <= STABLE_DUST_MAX);
};
