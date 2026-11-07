// Programs whose recent mainnet transactions become fixtures (PLAN.md section 3, P0 and P1).
// The demo program is marginfi v2 (packages/scenarios/programs/README.md), so its P1 fixtures cover it too.
export const PROGRAMS = [
  { slug: 'system', name: 'System', programId: '11111111111111111111111111111111', priority: 'P0' },
  { slug: 'spl-token', name: 'SPL Token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', priority: 'P0' },
  { slug: 'token-2022', name: 'Token-2022', programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', priority: 'P0', pages: 3, maxFetch: 60 },
  { slug: 'bpf-loader-upgradeable', name: 'Upgradeable loader', programId: 'BPFLoaderUpgradeab1e11111111111111111111111', priority: 'P0', maxFetch: 60,
    history: 'programdata',
    historyPrograms: [
      'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
      'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
      'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'
    ] },
  { slug: 'squads-v4', name: 'Squads v4', programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', priority: 'P0' },
  { slug: 'drift-v2', name: 'Drift v2', programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', priority: 'P0',
    // Drift has been almost idle since the April 2026 takeover: recent txs only name its ID as an account.
    // Its benign fixtures are the last real Drift calls before the attack (attack tx 1 below).
    before: '2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H',
    maxFetch: 40 },
  { slug: 'compute-budget', name: 'Compute Budget', programId: 'ComputeBudget111111111111111111111111111111', priority: 'P1' },
  { slug: 'address-lookup-table', name: 'Address Lookup Table', programId: 'AddressLookupTab1e1111111111111111111111111', priority: 'P1', history: 'lookup-tables', maxFetch: 60 },
  { slug: 'memo', name: 'Memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', priority: 'P1' },
  { slug: 'kamino-lending', name: 'Kamino Lending', programId: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', priority: 'P1' },
  { slug: 'marginfi-v2', name: 'marginfi v2 (demo program)', programId: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', priority: 'P1', pages: 3, maxFetch: 60 },
  { slug: 'jupiter-v6', name: 'Jupiter v6', programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', priority: 'P1' }
];

const SQUADS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const DRIFT = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
// PLAN.md "The real tests": signatures published by BlockSec; the third comes from Watchtower's
// scripts/check-drift-replay.mjs and is not part of G8.
export const DRIFT_REPLAY = [
  {
    role: 'create-and-approve',
    label: 'Drift attack 1/2: create and approve',
    signature: '2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H',
    slug: 'squads-v4', programId: SQUADS, programName: 'Squads v4',
    reference: 'BlockSec, Drift Protocol incident analysis'
  },
  {
    role: 'approve-and-execute',
    label: 'Drift attack 2/2: approve and execute (AdvanceNonceAccount, proposalApprove, vaultTransactionExecute, UpdateAdmin)',
    signature: '4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1',
    slug: 'squads-v4', programId: SQUADS, programName: 'Squads v4',
    reference: 'BlockSec, Drift Protocol incident analysis'
  },
  {
    role: 'post-takeover-admin-call',
    label: "Drift post-takeover: new admin's first admin call (initialize_spot_market)",
    signature: '4a5962Rdqd9pkXtk9DMQ9ZYhdGb2k9gPw71GvukJgELhxbCY5gm1c1hhKdwuGefyqJ3XMvihUTDNDn3qbXnst82X',
    slug: 'drift-v2', programId: DRIFT, programName: 'Drift v2',
    reference: 'helius-labs/watchtower scripts/check-drift-replay.mjs',
    optional: true
  }
];
