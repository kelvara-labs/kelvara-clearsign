# Progress: engine

One line per task: `M<n> | task | gates | minutes | decisions`

M1 | E1 ingest: legacy/v0/v1 parse (wire or bare message), ALT resolution via injectable AccountReader (fixture reader in tests), sha256 base58 message hash, sessions with stable indices + deterministic id; 30 vitest tests incl. 1,000 random + 1,000 mutated inputs | G1 PASS, G2 PENDING until E5 | 45 | kit pinned 8.5.0 (8.6.0 < 2 weeks old); v1 txs already on mainnet so v1 supported; ALT resolution checked against RPC meta.loadedAddresses; pure-TS sync sha256 for SW portability; unresolved lookups give address null + complete=false (fail closed downstream); program id from a lookup table is an IngestError |
