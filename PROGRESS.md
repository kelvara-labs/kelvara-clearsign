# Progress

One line per merged task (coordinator only): `M<n> | role | task | gates | minutes | decisions`

M0 | coordinator | pnpm workspace, strict TS, eslint, esbuild (4 entries), package skeletons, selfcheck runner (10 gates, exit 78 = PENDING) | G1 PASS, G2–G10 PENDING | 25 | Node 26.8 on host (plan says 22; engines >=22). Agave 2.3.0, Playwright chromium-1243 present. Gate scripts delegate to owner packages: G2/G3/G4/G9 core, G5 idls, G6 scenarios, G7 test-dapp, G8/G10 tools/selfcheck (verifier composes).
M0 | coordinator | network check | — | 5 | Helius mainnet+devnet: getHealth ok, getSlot, getAccountInfo (Squads v4 executable on both), DAS getAsset ok, enhanced tx API 200. Localnet solana-test-validator healthy in 3s. Rate limits not measured yet (verifier to record on first 429). Browser launch.sh, SolSub check, demo-program pick and @sqds/multisig license moved to scenarios task M0-S.

## Orca run run_aa6bac067188 (started 2026-11-07 ~07:45Z)
Workers: engine ctx_ee4c1e75b027, scenarios ctx_d31e5a8e9570, extension ctx_d14deb2c0fbe, verifier ctx_7f7371fce5b1 (worktrees under ~/orca/workspaces/kelvara-signguard/<role>).

| Key | Task id | Role | Title |
|---|---|---|---|
| E1 | task_e118a7bd28ca | engine | Ingest: parse legacy and v0 messages, resolve lookup tables, session grouping |
| E2 | task_4c2fc74a7337 | engine | Codama spike: P0 IDLs to Codama roots, parseInstruction, fallback Anchor decoder |
| E3 | task_47f72aac7f73 | engine | Squads v4 decoding: vault_transaction_create inner message, vault tx, multisig and proposal accounts |
| E4 | task_c9976233c05c | engine | Hand-written upgradeable loader and Memo decoders |
| E5 | task_50c2384ca73f | engine | G2 gate: test:decode over all fixtures, >=95% named, 1000-input fuzz |
| E6 | task_414ad766af03 | engine | Report contract: evidence ledger, claim builder, zod schema, canonical JSON, sha256 digest |
| E7 | task_7b9cc5e0827f | engine | Rules: durable nonce, nonce.staged_by_outsider, Squads approve/execute/threshold/timelock/config |
| E8 | task_d429a2fefff1 | engine | Rules: authority.transfer, token delegate granted/revoked, Token-2022 trap rules, L4 scam rules |
| E9 | task_b9d05ec29c34 | engine | Rules: address.poisoning (L4), address.dust_sender (L3), address.first_send (L1) |
| E10 | task_9d8d473fa0bb | engine | Rules: sim.power_without_value, session.dependency/partial_execution, tx.foreign_fee_payer, intent.label_mismatch |
| E11 | task_d1784c80fb5f | engine | Capability diff, alert levels (alert-levels-v1), capability preview |
| E12 | task_d1974e11e416 | engine | idls:build, registry, manifest hashes, curated and keyword capability maps, authority maps |
| E13 | task_cca00d03b65a | engine | State and simulation: Helius adapter, RPC with timeouts/backoff/cache, reads, simulateTransaction |
| E14 | task_246096d946a3 | engine | CLI: kelvara analyze and kelvara replay |
| E15 | task_88990a0de6e3 | engine | Explain: templates for every ruleId, optional on-device AI validator, test:determinism |
| S0 | task_e516ff0fc11e | scenarios | M0 tail: tools/browser/launch.sh + CDP check, SolSub check, pick demo program, @sqds/multisig license |
| S1 | task_f8fa3fb4cd8b | scenarios | Fixtures: 5 recent real txs per P0/P1 program + Drift's two attack txs over Helius |
| S2 | task_56acb932fb46 | scenarios | Localnet: validator cloning Squads v4 + config accounts, demo program deploy, IDL publish |
| S3 | task_ee08bb973d6e | scenarios | pnpm scenario:admin-local: Squads council 2-of-3, timelock 0, nonce funded by outsider, Q4 fee update proposal |
| S4 | task_acff22f7af37 | scenarios | pnpm scenario:trap-local: Token-2022 $SHINY with permanent delegate + freeze authority, partially signed buy |
| S5 | task_044f992a53ed | scenarios | G6 gate: test:localnet runs both scenarios and kelvara analyze, asserts required claims, then runs the attacks |
| S6 | task_5f6128cc7cc8 | scenarios | Devnet: scenario:admin-devnet and scenario:trap-devnet with attacker pages and Solflare key export |
| S7 | task_f0a4030765c4 | scenarios | Poisoning + sweep: real mainnet poisoning fixtures, scenario:poison-devnet, scenario:sweep-devnet |
| S8 | task_f7732d7514d0 | scenarios | DEMO.md runbook for the shot list, tested once on devnet; demo assets |
| X1 | task_6fee8418ef86 | extension | Port sol-sign-preview hook to TS: Wallet Standard + legacy wrapping, MV3 manifest, random per-page channel |
| X2 | task_c1fefdfa7b53 | extension | Service worker, engine stub, endpoint per chain, options page (Helius key, network, test button) |
| X3 | task_565d88947b40 | extension | Report UI in extension iframe inside closed shadow root; per-level behavior; 90 s fail-closed |
| X4 | task_a69f70c99f95 | extension | License gate: Ed25519 key (email, plan, expiry) verified offline against config/license-public-key.txt |
| X5 | task_10fdf780073e | extension | Test dApp: static page + fixture wallet (both Wallet Standard paths + legacy), throwaway key, call counter |
| X6 | task_2a77492c8a78 | extension | Wire the real engine into the service worker (after hour-24 checkpoint) |
| X7 | task_e92f34822ce9 | extension | Replay tab: run kelvara replay flow for Drift's two txs in the extension |
| X8 | task_fb483df6a55c | extension | Evidence explorer, template text in UI, performance budget (p95 <1.5 s localnet, <3 s Helius) |
| V1 | task_aa593e812844 | verifier | Harden selfcheck runner; record Helius rate limits; scaffold G8 test:replay and G10 test:security composites |
| V2 | task_3f6444e60aaf | verifier | G10 security check: hosts allowlist, no key in zip, no eval/remote code, minimal permissions, offline license |
| V3 | task_e9de25fbeec0 | verifier | G7 Playwright e2e specs in test-dapp/e2e (headless chromium with the extension) |
| V4 | task_fa879236ceeb | verifier | G8 test:replay: Drift replay critical with required claims; both devnet scripts pass |
M1 | engine | E1 ingest: legacy/v0/v1 parse, ALT resolution, sessions (merged ee332e7) | G1 PASS, 30 core tests | ~20 | @solana/kit 8.5.0 (MIT); v1 messages already on mainnet, supported; 2,000 fuzz/mutated inputs -> IngestError, no crash
M0 | scenarios | S0 tools/browser/launch.sh + cdp-check, demo program pick, @sqds/multisig license (merged d42033e) | G1 PASS | ~25 | Demo program = marginfi v2 (Apache-2.0, on-chain Anchor IDL, 38 admin-signer ix), .so + IDL pinned in packages/scenarios/programs. SolSub UNVERIFIED: CDP port 28538 held by a Docker container (NEEDS_HUMAN); moved to M6. @sqds/multisig treated as AGPL-tainted, scenarios only.
M0 | verifier | V1 selfcheck hardening: process-group spawn, timeouts, redacted per-gate logs, --write refuses dirty tree; G8 + G10 composites with 16 self-tests (merged 27d3c1f) | G1 PASS, G2–G10 PENDING | ~25 | Helius mainnet RPC ~10 rps (429, retry-after 1, ~33 burst); devnet no limit seen at 40 rps; DAS ok at 10 rps; getPriorityFeeEstimate missing on devnet. G8 cached mode skips devnet scripts, so M8 needs a --live run.
M5 | extension | X1 hook + bridge + random per-page channel + MV3 manifest, ported from sol-sign-preview (merged c3f14ae) | G1 PASS, 26 ext tests | ~35 | Unpacked root = packages/extension/dist (manifest copied there). DOM-event handshake at document_start, exact-key validators, 90 s hold -> block, unserializable tx rejected. Stub engine in SW until hour 24. navigator.wallets (deprecated) not hooked.
M5 | verifier | V2 G10 security check over unpacked dist + release zip (merged 6545cec) | G10 FAIL (license key not bundled yet) | ~20 | content_scripts matches exempt (https://*/*, localhost, 127.0.0.1 only); Helius API hosts api.helius.xyz + api-mainnet.helius-rpc.com; key-in-zip check incl. encodings; CSP connect-src checked. Follow-up sent: report PENDING for checks whose feature has not landed.
M5 | verifier | G10 follow-up: unbuilt features PENDING, real violations FAIL (merged dc880ce) | full selfcheck exit 0, G1 PASS, G2–G10 PENDING | ~10 | License-key check activates when packages/extension/src has a file named *license*; Helius key anywhere under dist/ FAILs.
M1 | scenarios | S1 fixtures: 63 real mainnet txs (5 per P0/P1 program) + Drift attack txs 1/2, 2/2 + optional 3rd (merged 053b79d) | fixtures:verify PASS, G1 PASS | ~30 | Helius rejects getSignaturesForAddress on loader and ALT program IDs: loader fixtures from ProgramData history, ALT from oldest txs of quiet tables. Drift idle since hack: benign Drift fixtures are the last calls before attack tx 1. At most one v1 tx per program (6 total). Root aliases fixtures:fetch / fixtures:verify added.
M5 | extension | X5 test dApp: static page, fixture wallet on ws-register / ws-app-ready / legacy, throwaway Ed25519 key, call counter, forged-approval mode, serve.mjs (merged 4519010) | G1 PASS, 6 tests | ~25 | Headless smoke: without extension 3 paths sign; with current dist all rejected 4001, count 0, forgery learns no channel.
M1 | engine | E2 Codama decode: 5 P0 IDLs pinned (System/Token/Token-2022 official idl.json; Squads v4 + Drift v2 on-chain anchor:idl), Codama roots, createDecoder with Anchor fallback (merged a7623cc) | G1 PASS, 46 core tests | ~30 | All fixtures decode except Drift's 21-byte non-Anchor ix (ff ff ff ff prefix, Unknown): P0 named 94.6%, G2 risk for E5. Squads IDL lacks transactionBuffer*. Decision: shipping the Squads Codama root is OK (on-chain interface data, no Squads code; PLAN.md Risks).
M4 | scenarios | S2 localnet:up/check/down: Squads v4 clone (immutable) + program config + treasury over Helius, marginfi v2 under our upgrade key (merged 921e235) | localnet:check 11/11, G1 PASS | ~35 | marginfi build has no IDL instructions (Custom 101), so the demo IDL is pinned from packages/scenarios/programs and labelled unverified, per PLAN. Fresh up 18 s; first run 26 min under host load ~139. worker_done rejected by Orca (worker_identity_changed); coordinator settled the task after review.
M5 | verifier | V3 G7 Playwright specs + runner (merged) ; root test:e2e -> @kelvara/selfcheck | G7 PENDING: 9 PASS, 12 PENDING (UI 5, engine 7) | ~30 | @playwright/test 1.63.0 in tools/selfcheck. UI contract for extension in test-dapp/e2e/README.md. Scenarios must tag fixtures e2e: l4-sweep, l3-batch, l2-trap.

## Hermes coordinator resume
- Existing run `run_aa6bac067188` rebound with run-use to live coordinator `term_114a6f4d-05d3-4638-bcbd-39b6c21b65ab`; no replacement run/tasks/worktrees. Main remains edd7b9d. User KICKOFF.md preserved (sha256 da61e3196ddbf70d3b588cc98232fd5c317b6127ecb6a302eac6cf2aa5223de2).
- With explicit additional user approval, closed five older settled Claude worker terminals (E1/E2/X1/S0/V1); all close receipts ptyKilled=true and all five Claude PIDs absent afterward. Did not resend the previously approved coordinator/E4/S2 stops. Released stopped E4/S2 resource records without process action; historical attempts retained.
- Candidate review checks: b7e3e65 core tests 56/56; df03559 extension tests 40/40; both fast checks build succeeds, G2/G3/G4 remain PENDING. Not milestone closure. E4 merge held for reproduced Memo UTF-8 BOM loss; owner assigned regression/fix. X2 async storage-error, raw-key redaction and 429-copy concerns sent to extension owner. Neither candidate merged yet.
- Launched four exact existing-worktree Hermes CLI processes with `--provider custom -m openai-5.6_sol --reasoning low`; argv and cwd verified. Coordinator reasoning high per latest user instruction. Orca tui-idle and worker-start readiness do not recognize these prompts: agent_readiness timeout, before assignee binding. Preserved failed attempts; used version-matched low-level `orchestration dispatch --inject` on same tasks/terminals after reopening tasks. Injection accepted for E4 `ctx_1fc84ee3e3b4`, X3 `ctx_647fd174c46e`, S2 validation `ctx_d7356ecf7209`, V3 verification follow-up `ctx_35a128eb46a2`. Submission observation unsupported; input acceptance alone is not execution proof. Self-contained safety/follow-up scope sent by Dispatch mailbox. Verifier validates S2/E4 before coordinator settles stopped tasks; E3/S3/S4 remain next, real-engine wiring held until G6.
