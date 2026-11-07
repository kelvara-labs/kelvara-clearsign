#!/usr/bin/env node
/* global Buffer, setTimeout */
// Localnet for the M4 scenarios (PLAN.md M4, task S2).
//   pnpm --filter @kelvara/scenarios localnet:up [--refresh]   fresh validator (ledger reset), then deploy + IDL
//   pnpm --filter @kelvara/scenarios localnet:check            verify a running localnet, exit 1 on any mismatch
//   pnpm --filter @kelvara/scenarios localnet:down
//
// What `up` does:
//  1. Keys: creates localnet keys in <repo>/.keys/localnet/ (gitignored) if missing. Never a mainnet key.
//  2. Clone: reads Squads v4 (program + ProgramData) and its two config accounts (program config PDA and the
//     treasury it names) from mainnet over Helius, the Squads quickstart set. Cached in .localnet/clone/;
//     --refresh re-reads. The Helius key never reaches the validator's command line.
//  3. Validator: solana-test-validator on 127.0.0.1 with Squads (mainnet upgrade authority kept) and the demo
//     program (programs/marginfi_v2.so) at its mainnet address with OUR key as upgrade authority.
//  4. IDL: tries to publish programs/marginfi_v2.idl.json through the program's own Anchor IDL instructions
//     (create, resize, write; no Anchor CLI) and reads it back. If the program rejects them, the IDL is pinned
//     from programs/ and labelled unverified.
//  5. Writes .localnet/state.json (addresses, IDL status, clone provenance) for the scenario scripts.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { heliusMainnet, redact } from './lib/helius.mjs';
import {
  BPF_LOADER_UPGRADEABLE,
  SYSTEM_PROGRAM,
  b58encode,
  createWithSeed,
  findProgramAddress,
  localRpc,
  readKeypair
} from './lib/tx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const REPO = resolve(PKG, '../..');
const DIR = join(PKG, '.localnet');
const CLONE = join(DIR, 'clone');
const LEDGER = join(DIR, 'ledger');
const STATE = join(DIR, 'state.json');
const PIDFILE = join(DIR, 'validator.pid');
const LOG = join(DIR, 'validator.log');
const KEYS = join(REPO, '.keys', 'localnet');

const RPC_PORT = Number(process.env.KELVARA_LOCALNET_PORT ?? 8899);
const FAUCET_PORT = Number(process.env.KELVARA_LOCALNET_FAUCET_PORT ?? 9900);
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

export const SQUADS = {
  programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
  programConfigSeeds: ['multisig', 'program_config']
};
export const DEMO = {
  name: 'marginfi v2',
  programId: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
  so: join(PKG, 'programs', 'marginfi_v2.so'),
  idl: join(PKG, 'programs', 'marginfi_v2.idl.json')
};
const KEY_NAMES = ['payer', 'demo-upgrade-authority'];

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[localnet]', ...a);

// ---------- keys ----------
export function keyPath(name) {
  return join(KEYS, `${name}.json`);
}
function ensureKeys() {
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  for (const name of KEY_NAMES) {
    if (existsSync(keyPath(name))) continue;
    execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '--force', '-o', keyPath(name)], {
      stdio: ['ignore', 'ignore', 'inherit']
    });
    log(`created key ${name}`);
  }
  return Object.fromEntries(KEY_NAMES.map((n) => [n, readKeypair(keyPath(n))]));
}

// ---------- clone from mainnet ----------
function accountJson(pubkey, acc) {
  return {
    pubkey,
    account: {
      lamports: acc.lamports,
      data: [acc.data[0], 'base64'],
      owner: acc.owner,
      executable: acc.executable,
      rentEpoch: 0,
      space: Buffer.from(acc.data[0], 'base64').length
    }
  };
}

async function cloneSquads(refresh) {
  const manifestPath = join(CLONE, 'manifest.json');
  if (!refresh && existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if ((m.program.files ?? ['missing']).every((f) => existsSync(join(CLONE, f))) && m.accounts.every((a) => existsSync(join(CLONE, a.file)))) {
      log(`using cached Squads clone (mainnet slot ${m.slot}); --refresh to re-read`);
      return m;
    }
  }
  mkdirSync(CLONE, { recursive: true });
  const rpc = heliusMainnet(REPO);
  const [programConfig] = findProgramAddress(
    SQUADS.programConfigSeeds.map((s) => Buffer.from(s)),
    SQUADS.programId
  );
  const first = await rpc('getMultipleAccounts', [[SQUADS.programId, programConfig], { encoding: 'base64' }]);
  const [prog, cfg] = first.value;
  if (!prog?.executable || prog.owner !== BPF_LOADER_UPGRADEABLE) throw new Error('Squads v4 is not an upgradeable program on mainnet');
  if (!cfg || cfg.owner !== SQUADS.programId) throw new Error(`Squads program config ${programConfig} missing or not owned by Squads`);
  const progData = Buffer.from(prog.data[0], 'base64');
  const programDataAddr = b58encode(progData.subarray(4, 36));
  const cfgData = Buffer.from(cfg.data[0], 'base64');
  // ProgramConfig: disc(8) authority(32) multisig_creation_fee(u64) treasury(32) reserved(64)
  const treasury = b58encode(cfgData.subarray(48, 80));
  const second = await rpc('getMultipleAccounts', [[programDataAddr, treasury], { encoding: 'base64' }]);
  const [pd, tre] = second.value;
  if (!pd) throw new Error('Squads ProgramData missing');
  if (!tre) throw new Error(`Squads treasury ${treasury} missing on mainnet`);
  const pdBytes = Buffer.from(pd.data[0], 'base64');
  // ProgramData: tag u32 (3) | slot u64 | Option<Pubkey> upgrade authority | ELF
  if (pdBytes.readUInt32LE(0) !== 3) throw new Error('unexpected ProgramData layout');
  const deploySlot = Number(pdBytes.readBigUInt64LE(4));
  const upgradeAuthority = pdBytes[12] === 1 ? b58encode(pdBytes.subarray(13, 45)) : null;
  const elf = pdBytes.subarray(45);
  writeFileSync(join(CLONE, 'squads_v4.so'), elf); // for inspection; the validator loads the two accounts below
  // Load program + ProgramData as accounts (what --clone-upgradeable-program does) so the upgrade authority stays
  // exactly as on mainnet (None: Squads v4 is immutable). Deploy slot reset to 0 so the program is live at genesis.
  const pdLocal = Buffer.from(pdBytes);
  pdLocal.writeBigUInt64LE(0n, 4);
  writeFileSync(join(CLONE, `${SQUADS.programId}.json`), JSON.stringify(accountJson(SQUADS.programId, prog)));
  writeFileSync(
    join(CLONE, `${programDataAddr}.json`),
    JSON.stringify(accountJson(programDataAddr, { ...pd, data: [pdLocal.toString('base64'), 'base64'] }))
  );
  writeFileSync(join(CLONE, `${programConfig}.json`), JSON.stringify(accountJson(programConfig, cfg)));
  writeFileSync(join(CLONE, `${treasury}.json`), JSON.stringify(accountJson(treasury, tre)));
  const manifest = {
    source: 'Helius mainnet RPC (getMultipleAccounts)',
    fetchedAt: new Date().toISOString(),
    slot: second.context.slot,
    program: {
      programId: SQUADS.programId,
      programData: programDataAddr,
      deploySlot,
      upgradeAuthority,
      so: 'squads_v4.so',
      files: [`${SQUADS.programId}.json`, `${programDataAddr}.json`],
      bytes: elf.length,
      sha256: sha256hex(elf)
    },
    accounts: [
      { role: 'program_config', pubkey: programConfig, owner: cfg.owner, file: `${programConfig}.json`, sha256: sha256hex(cfgData) },
      { role: 'treasury', pubkey: treasury, owner: tre.owner, file: `${treasury}.json`, sha256: sha256hex(Buffer.from(tre.data[0], 'base64')) }
    ]
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`cloned Squads v4 (${elf.length} B, deployed slot ${deploySlot}), program config ${programConfig}, treasury ${treasury}`);
  return manifest;
}

// ---------- validator ----------
function portOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
  });
}
function ourPid() {
  if (!existsSync(PIDFILE)) return null;
  const pid = Number(readFileSync(PIDFILE, 'utf8'));
  try {
    process.kill(pid, 0);
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('solana-test-validator') && cmd.includes(LEDGER) ? pid : null;
  } catch {
    return null;
  }
}

export async function down() {
  const pid = ourPid();
  if (!pid) {
    log('no localnet of ours is running');
    rmSync(PIDFILE, { force: true });
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && ourPid(); i++) await sleep(250);
  if (ourPid()) process.kill(pid, 'SIGKILL');
  rmSync(PIDFILE, { force: true });
  log(`stopped validator pid ${pid}`);
}

async function startValidator(manifest, keys) {
  await down();
  for (const port of [RPC_PORT, FAUCET_PORT]) {
    // A just-stopped validator can hold its sockets for a few seconds after the pid is gone.
    for (let i = 0; i < 40 && (await portOpen(port)); i++) await sleep(250);
    if (await portOpen(port)) throw new Error(`127.0.0.1:${port} is held by another process; set KELVARA_LOCALNET_PORT / KELVARA_LOCALNET_FAUCET_PORT`);
  }
  mkdirSync(DIR, { recursive: true });
  const args = [
    '--ledger', LEDGER,
    '--reset',
    '--quiet',
    '--bind-address', '127.0.0.1',
    '--rpc-port', String(RPC_PORT),
    '--faucet-port', String(FAUCET_PORT),
    '--mint', keys.payer.publicKey,
    ...manifest.program.files.flatMap((f) => ['--account', f.replace(/\.json$/, ''), join(CLONE, f)]),
    ...manifest.accounts.flatMap((a) => ['--account', a.pubkey, join(CLONE, a.file)]),
    '--upgradeable-program', DEMO.programId, DEMO.so, keyPath('demo-upgrade-authority')
  ];
  const out = openSync(LOG, 'w');
  const child = spawn('solana-test-validator', args, { detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.unref();
  writeFileSync(PIDFILE, String(child.pid));
  const rpc = localRpc(RPC_URL);
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    if (!ourPid()) throw new Error(`validator exited; see ${LOG}`);
    try {
      if ((await rpc.call('getHealth')) === 'ok' && (await rpc.call('getSlot')) > 1) {
        log(`validator up at ${RPC_URL} (pid ${child.pid})`);
        return rpc;
      }
    } catch {
      // not ready yet
    }
  }
  throw new Error(`validator did not become healthy; see ${LOG}`);
}

// ---------- reads ----------
async function getAccount(rpc, pubkey) {
  const { value } = await rpc.call('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
  return value ? { ...value, bytes: Buffer.from(value.data[0], 'base64') } : null;
}

async function readUpgradeable(rpc, programId) {
  const prog = await getAccount(rpc, programId);
  if (!prog?.executable || prog.owner !== BPF_LOADER_UPGRADEABLE) return null;
  const programData = b58encode(prog.bytes.subarray(4, 36));
  const pd = await getAccount(rpc, programData);
  const authority = pd.bytes[12] === 1 ? b58encode(pd.bytes.subarray(13, 45)) : null;
  return { programData, authority, elf: pd.bytes.subarray(45) };
}

// ---------- Anchor IDL (no Anchor CLI) ----------
// anchor-lang: IDL_IX_TAG = 0x0a69e9a778bcf440 (LE), then the IdlInstruction enum variant.
const IDL_TAG = Buffer.from('40f4bc78a7e9690a', 'hex');
const IDL_SEED = 'anchor:idl';
const IDL_ACCOUNT_DISC = createHash('sha256').update('account:IdlAccount').digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

function idlAddresses(programId) {
  const [base] = findProgramAddress([], programId);
  return { base, idl: createWithSeed(base, IDL_SEED, programId) };
}

// The JSON as published: compact, so the stored bytes are canonical for our pinned file.
function idlPayload() {
  const json = JSON.stringify(JSON.parse(readFileSync(DEMO.idl, 'utf8')));
  return { json, compressed: deflateSync(Buffer.from(json)) };
}

async function readIdlAccount(rpc, address) {
  const acc = await getAccount(rpc, address);
  if (!acc) return null;
  if (!acc.bytes.subarray(0, 8).equals(IDL_ACCOUNT_DISC)) throw new Error('IDL account has a foreign discriminator');
  const authority = b58encode(acc.bytes.subarray(8, 40));
  const len = acc.bytes.readUInt32LE(40);
  const data = acc.bytes.subarray(44, 44 + len);
  return { owner: acc.owner, authority, size: acc.bytes.length, json: inflateSync(data).toString('utf8') };
}

async function publishIdl(rpc, authority) {
  const { base, idl } = idlAddresses(DEMO.programId);
  const { json, compressed } = idlPayload();
  const need = 8 + 32 + 4 + compressed.length;
  const steps = [];
  const ix = (variant, rest, keys) => ({
    programId: DEMO.programId,
    keys,
    data: Buffer.concat([IDL_TAG, Buffer.from([variant]), rest])
  });
  const idlKeys = [
    { pubkey: idl, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true }
  ];

  let acc = await getAccount(rpc, idl);
  if (!acc) {
    // Create { data_len }: IdlCreateAccounts = from (signer, payer), to, base, system_program, program
    const sig = await rpc.send(
      [
        ix(0, u64(compressed.length), [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: idl, isSigner: false, isWritable: true },
          { pubkey: base, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: DEMO.programId, isSigner: false, isWritable: false }
        ])
      ],
      authority,
      []
    );
    steps.push(`create ${sig}`);
    acc = await getAccount(rpc, idl);
  }
  // Resize { data_len }: grows by at most 10 KiB per call.
  for (let i = 0; acc.bytes.length < need && i < 64; i++) {
    const sig = await rpc.send(
      [ix(6, u64(need), [...idlKeys, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }])],
      authority,
      []
    );
    steps.push(`resize ${sig}`);
    acc = await getAccount(rpc, idl);
  }
  if (acc.bytes.length < need) throw new Error(`IDL account stuck at ${acc.bytes.length} of ${need} bytes`);
  if (acc.bytes.readUInt32LE(40) !== 0) throw new Error('IDL account already holds data; reset the localnet');
  // Write { data: Vec<u8> }: appends to the stored IDL.
  const CHUNK = 900;
  for (let off = 0; off < compressed.length; off += CHUNK) {
    const part = compressed.subarray(off, off + CHUNK);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(part.length);
    await rpc.send([ix(2, Buffer.concat([len, part]), idlKeys.map((k) => ({ ...k, isWritable: k.pubkey === idl })))], authority, []);
  }
  steps.push(`write ${Math.ceil(compressed.length / CHUNK)} chunks`);
  const back = await readIdlAccount(rpc, idl);
  const ok = back && back.json === json && back.authority === authority.publicKey && back.owner === DEMO.programId;
  if (!ok) throw new Error('IDL read back does not match the pinned file');
  return { idl, steps };
}

function pinnedIdl(reason) {
  const raw = readFileSync(DEMO.idl);
  return {
    status: 'unverified',
    source: 'pinned',
    path: 'packages/scenarios/programs/marginfi_v2.idl.json',
    sha256: sha256hex(raw),
    reason
  };
}

// ---------- check ----------
export async function check({ quiet = false } = {}) {
  if (!existsSync(STATE)) throw new Error('no .localnet/state.json; run localnet:up');
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  const rpc = localRpc(state.rpcUrl);
  const fails = [];
  const ok = (cond, msg) => {
    if (!cond) fails.push(msg);
    else if (!quiet) log(`ok  ${msg}`);
  };
  ok((await rpc.call('getHealth')) === 'ok', 'validator healthy');
  const squads = await readUpgradeable(rpc, SQUADS.programId);
  ok(squads && sha256hex(squads.elf) === state.squads.program.sha256, 'Squads v4 executable, ELF matches the mainnet clone');
  ok(squads && squads.authority === state.squads.program.upgradeAuthority, `Squads upgrade authority as on mainnet (${state.squads.program.upgradeAuthority ?? 'none, immutable'})`);
  for (const a of state.squads.accounts) {
    const acc = await getAccount(rpc, a.pubkey);
    ok(acc && acc.owner === a.owner && sha256hex(acc.bytes) === a.sha256, `Squads ${a.role} ${a.pubkey} as on mainnet`);
  }
  const demo = await readUpgradeable(rpc, DEMO.programId);
  ok(demo && demo.elf.equals(readFileSync(DEMO.so)), `demo program ${DEMO.programId} executable, ELF = programs/marginfi_v2.so`);
  ok(demo?.authority === state.keys['demo-upgrade-authority'], 'demo program upgrade authority is our key');
  if (state.idl.status === 'published') {
    const back = await readIdlAccount(rpc, state.idl.address);
    ok(back && back.json === idlPayload().json, `demo IDL on chain at ${state.idl.address} matches the pinned file`);
  } else {
    ok(sha256hex(readFileSync(DEMO.idl)) === state.idl.sha256, `demo IDL pinned (unverified): ${state.idl.reason}`);
  }
  // Invoke both programs with an unknown 8-byte discriminator: Anchor answering Custom 101
  // (InstructionFallbackNotFound) proves the loaded ELF really runs.
  const payer = readKeypair(join(REPO, state.keyFiles.payer));
  for (const programId of [SQUADS.programId, DEMO.programId]) {
    const err = await rpc.simulate([{ programId, keys: [], data: new Uint8Array(8).fill(0xff) }], payer);
    ok(JSON.stringify(err) === '{"InstructionError":[0,{"Custom":101}]}', `${programId} runs (Anchor answers 101 to an unknown instruction)`);
  }
  const bal = await rpc.call('getBalance', [state.keys.payer, { commitment: 'confirmed' }]);
  ok(bal.value > 1e9, 'payer funded');
  if (fails.length) {
    for (const f of fails) console.error('[localnet] FAIL', f);
    throw new Error(`${fails.length} localnet check(s) failed`);
  }
  return state;
}

// ---------- up ----------
export async function up({ refresh = false } = {}) {
  const keys = ensureKeys();
  const manifest = await cloneSquads(refresh);
  const rpc = await startValidator(manifest, keys);
  const authority = keys['demo-upgrade-authority'];
  await rpc.airdrop(authority.publicKey, 100e9);

  let idl;
  try {
    const res = await publishIdl(rpc, authority);
    idl = { status: 'published', address: res.idl, authority: authority.publicKey, steps: res.steps };
    log(`IDL published at ${res.idl} and read back identical`);
  } catch (e) {
    const msg = redact(e?.message ?? e);
    // Custom 101 = Anchor InstructionFallbackNotFound: the binary has no IDL instructions.
    const reason = /"Custom":101\b/.test(msg)
      ? 'the deployed binary has no Anchor IDL instructions (InstructionFallbackNotFound, 101); IDL pinned from programs/'
      : `IDL publish failed: ${msg.slice(0, 300)}`;
    idl = { ...pinnedIdl(reason), address: idlAddresses(DEMO.programId).idl, attempted: true };
    log(`IDL NOT published: ${reason}`);
  }

  const state = {
    rpcUrl: RPC_URL,
    startedAt: new Date().toISOString(),
    keys: Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, k.publicKey])),
    keyFiles: Object.fromEntries(KEY_NAMES.map((n) => [n, `.keys/localnet/${n}.json`])),
    squads: { ...manifest, programConfig: manifest.accounts.find((a) => a.role === 'program_config').pubkey },
    demo: {
      name: DEMO.name,
      programId: DEMO.programId,
      so: 'packages/scenarios/programs/marginfi_v2.so',
      sha256: sha256hex(readFileSync(DEMO.so)),
      upgradeAuthority: authority.publicKey,
      deploy: 'genesis load (solana-test-validator --upgradeable-program) at the mainnet program id, upgrade authority = our key'
    },
    idl
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  await check();
  log(`state written to ${STATE}`);
  return state;
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd = 'up', ...rest] = process.argv.slice(2);
  const run = { up: () => up({ refresh: rest.includes('--refresh') }), down, check }[cmd];
  if (!run) {
    console.error('usage: localnet.mjs up [--refresh] | check | down');
    process.exit(2);
  }
  run().then(
    () => process.exit(0),
    (e) => {
      console.error('[localnet]', redact(e?.message ?? e));
      process.exit(1);
    }
  );
}
