# Kelvara SignGuard

A Chrome extension that holds every Solana signing request a page makes until it has shown, with evidence, what that signature authorizes. Simulation-based scanners show what moves now. SignGuard reads who gains control of what, and when it can be used: an upgrade authority handed over through a multisig vote on a durable nonce, a token whose creator can take it back, a request that empties the wallet.

The extension never signs, submits or stores wallet secrets, and it fails closed: any engine error, timeout, invalid report or hash mismatch blocks the request.

## Alert levels

| Level | Meaning | What the user sees |
|---|---|---|
| L4 Blocked | Obvious scam (Fact claims from a short list: wallet sweep, address poisoning, owner/assign takeover) | Rejected at once with code 4001; the wallet never opens; no Sign anyway |
| L3 Critical | Control of a program, multisig, mint or protocol admin passes to someone outside the session | Held; Block is the default; Sign anyway needs hold-to-confirm |
| L2 Warning | Token-2022 trap extensions, unlimited allowance, foreign fee payer | Held; Block and Sign anyway side by side |
| L1 Notice | Something worth knowing (first send to an address) | Passes with a small notice |
| L0 Clear | Nothing found | Passes silently |

## Repository

| Path | What it is |
|---|---|
| `packages/core` | The engine: ingest and decode, Helius reads, simulation, rules, capability graph, the `kelvara-report-v1` report, explanations |
| `packages/idls` | Pinned IDL registry, compact roots, curated capability and authority maps |
| `packages/cli` | `kelvara analyze` and `kelvara replay` (built to `packages/cli/dist/kelvara.mjs`) |
| `packages/extension` | The MV3 extension: page hook, bridge, service worker running the engine, report UI in a closed shadow root, options, offline license check |
| `packages/scenarios` | Localnet and devnet demo scenarios (Squads upgrade hijack, Token-2022 trap, wallet sweep, address poisoning) |
| `test-dapp` | Test page and test wallet used by the Playwright e2e specs |
| `tools/selfcheck` | The ten gates (`pnpm selfcheck`) |
| `fixtures` | Real transactions from Helius mainnet/devnet or executed on localnet, with a manifest |

## Build and check

Needs Node 22+, pnpm 10, the Solana CLI and `cargo-build-sbf` (for the devnet demo program). Put `HELIUS_API_KEY=...` in `.env` at the repository root; tools and scenarios read it from there. Helius is the only remote RPC.

    pnpm install --frozen-lockfile
    pnpm build
    pnpm selfcheck            # all ten gates; --fast runs G1-G4
    pnpm release              # dist/kelvara-signguard.zip (reproducible, no key)

Click the shield icon in Chrome’s toolbar to open the SignGuard popup: connection setup, recent request counts and the latest checks are stored locally. The settings page and signing report use the same dark interface.

The unpacked extension is `packages/extension/dist`: load it with Developer mode, then set the Helius key and network on its options page. The MVP enables full reports for everyone; no license is required.

Analyze a transaction from the command line:

    node packages/cli/dist/kelvara.mjs analyze --network devnet --wallet <your pubkey> --json <tx.b64>
    node packages/cli/dist/kelvara.mjs replay <signature> [<signature> ...]

Gates: G1 build, G2 decode, G3 rules, G4 report contract, G5 registry, G6 localnet scenarios, G7 browser e2e, G8 replay, G9 determinism, G10 security. Results and evidence are in SELFCHECK.md; the demo runbook is DEMO.md; dependency licenses are in LICENSES.md.

## Known limitations

- **Chrome versions.** The offline license check needs WebCrypto Ed25519 (Chrome 137+). Older Chrome shows the limited view.
- **Address history cap.** History reads stop at 1,000 signatures per address (30 days). A poisoner address with more history reads as a Conditional L3 instead of a Fact L4.
- **Unverified IDLs.** No Anchor IDL in the registry meets the "IDL authority equals upgrade authority" rule (Drift's IDL authority differs from its upgrade authority; Squads v4 is immutable). Previews built from these IDLs are labelled lower confidence.
- **Offline replay.** Without `--live`, replay can't read nonce creators or multisig state, so those claims are Unknown and some sessions read lower than live.
- **Executed transactions.** Re-analyzing a transaction that already executed uses today's chain state; for example, an executed sweep's wallet is already empty. Fixtures that need the pre-execution state carry a request block with the original bytes and simulation.
- **Partial execution.** The mixed-simulation branch of `session.partial_execution` has no real multi-transaction fixture yet.
- **Address poisoning demo.** The poisoning story is shown as CLI output; there is no wallet page for it, and the "real address passes with a notice" half is unscripted.
- **Cut from the MVP.** The optional on-device AI explanation (and its validator) and the extension's Replay tab. Templates are the explanation; replay is the CLI.
- **Speed.** p95 analysis is about 235 ms on localnet and about 1.7 s on Helius (budget 3 s). Helius time is sequential RPC round trips.
- **Bundle size.** The service worker is about 1.6 MB minified (211 KB gzip). It still bundles the raw Anchor IDLs with docs (about 940 KB) for Drift, marginfi and Squads.
- **Read-only, Helius only.** The extension never signs or submits, uses no scanner, price feed, analytics or remote AI, and needs a Helius key to analyze. With no key it blocks the request and says why.

## Test playground

Open http://localhost:8780 while the demo server is running. It has a benign memo (L0), a Token-2022 trap (L2), a Squads authority hijack (L3), and a wallet sweep (L4), all on devnet. Every action requests a signature preview; the page never submits it.

Connect a devnet wallet. The page shows one shared funded demo account and its local import-file path. Import/select it once and connect to enable all four scenarios, then preview and choose Block. A benign memo can use any funded devnet account. No license is needed. See DEMO.md for setup, `pnpm demo:prepare` to prepare the shared account, and `pnpm demo:serve` startup; run it from the checkout containing the prepared scenario state. The current server runs from the scenarios worktree.
