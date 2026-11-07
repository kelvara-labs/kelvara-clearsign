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
