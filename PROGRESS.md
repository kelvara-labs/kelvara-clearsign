# Progress

One line per merged task (coordinator only): `M<n> | role | task | gates | minutes | decisions`

M0 | coordinator | pnpm workspace, strict TS, eslint, esbuild (4 entries), package skeletons, selfcheck runner (10 gates, exit 78 = PENDING) | G1 PASS, G2–G10 PENDING | 25 | Node 26.8 on host (plan says 22; engines >=22). Agave 2.3.0, Playwright chromium-1243 present. Gate scripts delegate to owner packages: G2/G3/G4/G9 core, G5 idls, G6 scenarios, G7 test-dapp, G8/G10 tools/selfcheck (verifier composes).
M0 | coordinator | network check | — | 5 | Helius mainnet+devnet: getHealth ok, getSlot, getAccountInfo (Squads v4 executable on both), DAS getAsset ok, enhanced tx API 200. Localnet solana-test-validator healthy in 3s. Rate limits not measured yet (verifier to record on first 429). Browser launch.sh, SolSub check, demo-program pick and @sqds/multisig license moved to scenarios task M0-S.
