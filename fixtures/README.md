# Fixtures

Real mainnet transactions fetched over Helius (getSignaturesForAddress + getTransaction). Nothing here is
hand-made. Owner: scenarios. Golden files change only with a written reason (CLAUDE.md).

- `tx/mainnet/<slug>/<signature>.json`: 5 recent successful txs per P0/P1 program (PLAN.md section 3).
- `tx/drift-replay/<signature>.json`: Drift attack txs 1/2 and 2/2 (BlockSec) plus the optional
  post-takeover `initialize_spot_market` call (Watchtower; `inG8: false`).
- `tx/manifest.json`: every fixture with path, signature, slot, slug, programId, priority, invocation, sha256.

Each file (`schema: kelvara.fixture.tx/v1`): `network`, `signature`, `slot`, `blockTime`, `fetchedAt`,
`source`, `program {slug, programId, priority, name}`, `encoding: base64`, `transaction` (signed wire
bytes as returned), `sha256` (of those bytes), `version` (`legacy` | 0 | 1), `invocation`
(`top-level` | `inner`), `discriminator` (first 8 data bytes of the first top-level call, hex),
and the raw RPC `meta` (incl. `loadedAddresses`, `innerInstructions`, `logMessages`).

Selection notes:
- At most one v1 tx per program; legacy/v0 preferred, then distinct top-level discriminators.
- Drift has been nearly idle since the April 2026 takeover, so its benign fixtures are the last Drift
  calls before attack tx 1.
- Helius rejects history queries on the loader and ALT program IDs. Loader fixtures come from the
  ProgramData history of marginfi, Kamino, Jupiter, Drift and Squads (mostly upgrades via CPI, so `inner`).
  ALT fixtures come from the oldest txs of lookup tables used by the other fixtures.

Commands (from repo root):
- `pnpm --filter @kelvara/scenarios fixtures:fetch [--refresh] [--only slug,...]` tops up missing fixtures.
- `pnpm --filter @kelvara/scenarios fixtures:verify` offline check (hashes, signatures, wire parse, no key).

## Address poisoning (S7, engine E9, gate G3)

`poison/` holds real poisoning cases and real first-time transfers, each with the raw Helius responses
(`calls: [{method, params, result}]`, made exactly as `packages/core/src/rpc/methods.ts` makes them:
`getSignaturesForAddress [addr, {limit, commitment: confirmed, before}]`, `getTransaction [sig, {encoding: json,
maxSupportedTransactionVersion: 0, commitment: confirmed}]`), so a replaying reader answers by method + params.
Index: `poison/manifest.json` (schema `kelvara.fixture.poison-manifest/v1`).

- `poison/mainnet/<dust sig>.json` (6): `kind: poisoning`. The user sent a real transfer to `lookalikeOf`; 57 to 644
  slots later `recipient` (sharing 3-4 start and 3-4 end characters) sent the user dust (0.000001-0.00001 SOL,
  0.0001 USDC, 0.001111 USDT). `request: null`: no send to the lookalike was observed, so the test analyzes a
  transfer user -> recipient against `history` (dust first, then the user's 50 earlier signatures; txs recorded
  down to the real transfer). Expect `address.poisoning`, L4.
- `poison/devnet/<send sig>.json` (1): the `scenario:poison-devnet` run whose user then really sent 0.5 SOL to the
  ground lookalike; `request` is that executed send, `history` the signatures before it.
- `poison/first-send/<sig>.json` (23): `kind: first-send`, a real wallet transfer (16 SOL, 7 USDC/USDT) whose
  recipient had no earlier signature at all (the recorded `getSignaturesForAddress(recipient, before, limit 1)` is
  empty), so the sender never sent to it. Expect at most `address.first_send` (L1), never L4. The same txs are in
  `tx/mainnet/first-send/` (tags `first-send`, `benign`) and so join the benign set.

Cases are pinned in `packages/scenarios/scripts/poison-cases.mjs`; `fixtures:poison` re-checks each from the
recorded data before writing, and `fixtures:verify` re-derives every claim offline. Dust here = SOL <= 0.001,
a zero-amount token transfer, or USDC/USDT <= $0.01 (other tokens need the engine's DAS price).

## E2E roles (G7, test-dapp/e2e/README.md)

`"e2e": "<role>"` lives in the fixture record and is copied into `tx/manifest.json`. `fixtures:e2e` stores the
executed bytes of the last localnet attacks:
- `l3-batch`: `tx/localnet/admin/<sig>.json`, Member A's durable-nonce approval of "Q4 fee update".
- `l2-trap`: `tx/localnet/trap/<sig>.json`, the $SHINY buy.
Both are `network: localnet` and need the validator they ran on (its mint, multisig and nonce). After a fresh
`localnet:up`, rerun `scenario:admin-local --attack`, `scenario:trap-local --attack`, then `fixtures:e2e`.
`l4-sweep` is untagged until `scenario:sweep-devnet` exists; `benign` uses the spec's default System transfer.

Commands (from repo root):
- `pnpm --filter @kelvara/scenarios fixtures:poison [--refresh] [--only poisoning,devnet,first-send]`
- `pnpm --filter @kelvara/scenarios fixtures:e2e` (needs the running localnet)
