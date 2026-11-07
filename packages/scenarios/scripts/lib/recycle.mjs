// Devnet SOL recycling (task S11). Every devnet scenario hands what it moved back to the payer, so a live G8
// run costs fees plus the rent that cannot be reclaimed (mints without a close authority, Squads accounts).
//
// The plan is pure (state in, transactions out) so it is tested offline; `recycle` reads the state over RPC and
// sends the plan. The payer is the fee payer of every recycle transaction, so an actor needs no fee reserve and
// can be drained to exactly 0 lamports (a system account with no data may hold 0, but not 1..rent-exempt-1).
// Only keys the caller passes are touched; the devnet runners pass keys from .keys/devnet only.
/* global Buffer */
import { SYSTEM_PROGRAM, BPF_LOADER_UPGRADEABLE } from './tx.mjs';
import { TOKEN_2022, burnChecked, closeAccount, systemTransfer } from './token2022.mjs';

export const RENT_EXEMPT_EMPTY = 890_880; // getMinimumBalanceForRentExemption(0)
export const PAYER_FLOOR = 50_000_000; // never spend the devnet payer below 0.05 SOL
const RECENT_BLOCKHASHES = 'SysvarRecentB1ockHashes11111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// Token-2022 ThawAccount (11): [account w, mint, freeze authority s]
export const thawAccount = (account, mint, authority) => ({
  programId: TOKEN_2022,
  keys: [meta(account, false, true), meta(mint, false, false), meta(authority, true, false)],
  data: Buffer.from([11])
});
// System WithdrawNonceAccount (5): [nonce w, to w, recent blockhashes, rent, authority s]; all lamports closes it.
export const withdrawNonce = (nonce, to, authority, lamports) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(nonce, false, true), meta(to, false, true), meta(RECENT_BLOCKHASHES, false, false), meta(RENT_SYSVAR, false, false), meta(authority, true, false)],
  data: Buffer.concat([u32le(5), u64le(lamports)])
});
// BPF loader upgradeable Close (5) of a program: [programData w, recipient w, authority s, program w].
// Same as `solana program close <id> --recipient <payer>`, without putting the Helius URL in a CLI config.
export const loaderCloseProgram = (programData, recipient, authority, program) => ({
  programId: BPF_LOADER_UPGRADEABLE,
  keys: [meta(programData, false, true), meta(recipient, false, true), meta(authority, true, false), meta(program, false, true)],
  data: u32le(5)
});

/**
 * Pure plan. Inputs:
 *   payer: pubkey (receives everything, pays every fee)
 *   actors: [{ name, publicKey }]: keys we hold; drained to `reserve` (0 or >= rent-exempt minimum)
 *   tokenAccounts: [{ address, owner, mint, amount: bigint, decimals, frozen, freezeAuthority }] owned by actors
 *   balances: { pubkey: lamports } for every actor (system accounts with no data only)
 *   freezers: Set of pubkeys we hold that may thaw (a frozen account whose freeze authority is not ours is skipped)
 * Returns { txs: [{ label, instructions, signers: [pubkey] }], skipped: [{ address, reason }], lamportsToPayer }.
 */
export function planRecycle({ payer, actors, tokenAccounts = [], balances = {}, freezers = new Set(), reserve = 0, perTx = 3 }) {
  if (reserve !== 0 && reserve < RENT_EXEMPT_EMPTY) throw new Error(`reserve ${reserve} must be 0 or >= ${RENT_EXEMPT_EMPTY}`);
  const owners = new Set(actors.map((a) => a.publicKey));
  if (owners.has(payer)) throw new Error('the payer is not an actor');
  const txs = [];
  const skipped = [];
  let lamportsToPayer = 0;
  const tokenSteps = [];
  for (const t of tokenAccounts) {
    if (!owners.has(t.owner)) {
      skipped.push({ address: t.address, reason: 'owner is not one of our actors' });
      continue;
    }
    if (t.frozen && !freezers.has(t.freezeAuthority)) {
      skipped.push({ address: t.address, reason: `frozen, freeze authority ${t.freezeAuthority} is not ours` });
      continue;
    }
    const ix = [];
    const signers = [t.owner];
    if (t.frozen) {
      ix.push(thawAccount(t.address, t.mint, t.freezeAuthority));
      signers.push(t.freezeAuthority);
    }
    if (t.amount > 0n) ix.push(burnChecked(t.address, t.mint, t.owner, t.amount, t.decimals));
    ix.push(closeAccount(t.address, payer, t.owner));
    lamportsToPayer += t.lamports ?? 0;
    tokenSteps.push({ address: t.address, ix, signers });
  }
  for (let i = 0; i < tokenSteps.length; i += perTx) {
    const chunk = tokenSteps.slice(i, i + perTx);
    txs.push({ label: `close ${chunk.length} token account(s)`, instructions: chunk.flatMap((s) => s.ix), signers: [...new Set(chunk.flatMap((s) => s.signers))] });
  }
  const drains = actors
    .map((a) => ({ ...a, amount: (balances[a.publicKey] ?? 0) - reserve }))
    .filter((a) => a.amount > 0);
  for (let i = 0; i < drains.length; i += 4) {
    const chunk = drains.slice(i, i + 4);
    txs.push({ label: `return SOL from ${chunk.map((a) => a.name).join(', ')}`, instructions: chunk.map((a) => systemTransfer(a.publicKey, payer, a.amount)), signers: chunk.map((a) => a.publicKey) });
    lamportsToPayer += chunk.reduce((s, a) => s + a.amount, 0);
  }
  return { txs, skipped, lamportsToPayer };
}

export const balanceOf = async (rpc, pubkey) => (await rpc.call('getBalance', [pubkey, { commitment: 'confirmed' }])).value;
export const sol = (lamports) => (lamports / 1e9).toFixed(6);

/** Reads every Token-2022 account the actors own (with mint decimals and freeze authority) and their balances. */
export async function readRecycleState(rpc, actors) {
  const tokenAccounts = [];
  const balances = {};
  for (const a of actors) {
    const { value: info } = await rpc.call('getAccountInfo', [a.publicKey, { encoding: 'base64', commitment: 'confirmed' }]);
    if (info && (info.owner !== SYSTEM_PROGRAM || Buffer.from(info.data[0], 'base64').length)) throw new Error(`${a.name} ${a.publicKey} is not a plain system account`);
    balances[a.publicKey] = info?.lamports ?? 0;
    const { value } = await rpc.call('getTokenAccountsByOwner', [a.publicKey, { programId: TOKEN_2022 }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    for (const acc of value) {
      const i = acc.account.data.parsed.info;
      tokenAccounts.push({ address: acc.pubkey, owner: a.publicKey, mint: i.mint, amount: BigInt(i.tokenAmount.amount), decimals: i.tokenAmount.decimals, frozen: i.state === 'frozen', lamports: acc.account.lamports });
    }
  }
  const mints = [...new Set(tokenAccounts.map((t) => t.mint))];
  for (let i = 0; i < mints.length; i += 100) {
    const { value } = await rpc.call('getMultipleAccounts', [mints.slice(i, i + 100), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    value.forEach((m, j) => {
      const fa = m?.data?.parsed?.info?.freezeAuthority ?? null;
      for (const t of tokenAccounts) if (t.mint === mints[i + j]) t.freezeAuthority = fa;
    });
  }
  return { tokenAccounts, balances };
}

/**
 * Sends the recycle plan. `keypairs` are the Keypair objects for actors and freezers (by publicKey); `payer` is
 * the payer Keypair. Returns { signatures, lamportsToPayer, skipped }.
 */
export async function recycle({ rpc, payer, keypairs, actorNames, freezers = [], reserve = 0, log = () => {} }) {
  const byKey = new Map(keypairs.map((k) => [k.publicKey, k]));
  const actors = actorNames.map(([name, kp]) => ({ name, publicKey: kp.publicKey }));
  const state = await readRecycleState(rpc, actors);
  const plan = planRecycle({ payer: payer.publicKey, actors, ...state, freezers: new Set(freezers.map((k) => k.publicKey)), reserve });
  const signatures = [];
  for (const tx of plan.txs) {
    const sig = await rpc.send(tx.instructions, payer, tx.signers.map((p) => byKey.get(p)));
    signatures.push(sig);
    log(`recycle: ${tx.label}: ${sig}`);
  }
  for (const s of plan.skipped) log(`recycle: kept ${s.address} (${s.reason})`);
  return { signatures, lamportsToPayer: plan.lamportsToPayer, skipped: plan.skipped };
}

/** Closes upgradeable programs whose upgrade authority is one of `holders` (Keypairs). Rent -> payer. */
export async function closePrograms({ rpc, payer, programIds, holders, readUpgradeAuthority, log = () => {} }) {
  const byKey = new Map(holders.map((k) => [k.publicKey, k]));
  const closed = [];
  for (const programId of programIds) {
    let info;
    try {
      info = await readUpgradeAuthority(rpc, programId);
    } catch {
      continue; // already closed or never deployed
    }
    const holder = byKey.get(info.authority);
    if (!holder) {
      log(`recycle: program ${programId} kept (upgrade authority ${info.authority} is not ours)`);
      continue;
    }
    const lamports = await balanceOf(rpc, info.programData);
    const sig = await rpc.send([loaderCloseProgram(info.programData, payer.publicKey, holder.publicKey, programId)], payer, [holder]);
    log(`recycle: closed demo program ${programId} (${sol(lamports)} SOL rent back): ${sig}`);
    closed.push({ programId, lamports, signature: sig });
  }
  return closed;
}
