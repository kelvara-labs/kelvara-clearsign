Kelvara SignGuard — 48-Hour MVP Build Plan
Nov 6, 2026 · @Andrzej
This plan lets a coding agent build and verify the Kelvara SignGuard MVP in 48 hours: a paid Chrome extension that holds every Solana signing request until it has shown, with evidence, what that signature authorizes.
Goal and definition of done
In 48 agent-hours, ship a Chrome extension that catches every Solana signing request in the page, analyzes the exact bytes against Solana RPC, and blocks a Drift-style admin takeover with an evidence-backed report. Done means the self-check scoreboard is green and the demo runs end to end on devnet.
What ships
• Chrome extension (Manifest V3). Hooks Wallet Standard wallets and the legacy Phantom, Solflare and Backpack providers. Holds signTransaction, signAllTransactions, signAndSendTransaction and sendTransaction until the user chooses Block or Sign anyway.
• Analysis engine. Decodes System, SPL Token, Token-2022, the upgradeable loader, Squads v4 (including the transaction inside a proposal) and the core protocol IDLs. Applies durable-nonce, authority and multi-transaction rules, ranks granted and revoked capabilities by risk, and emits claims labeled Fact, Derived, Conditional or Unknown, each tied to evidence.
• Report UI. Risk summary, ranked capability changes, claims that open their evidence, and the message hash to match on a Ledger.
• License gate. An offline-verified signed license key unlocks the full report; without one, the user sees the risk level and top finding.
• Scenario kit. Localnet scripts that recreate the Drift pattern with the real Squads v4 program, a devnet setup for the video, and a replay of Drift's two real attack transactions.
• Self-check. One command, pnpm selfcheck, runs ten gates and writes a scoreboard.
Definition of done
[ ] pnpm selfcheck passes all ten gates from a clean clone
[ ] Drift replay: both real attack transactions rated critical, with durable-nonce, Squads approve-and-execute and UpdateAdmin claims
[ ] Localnet reenactment: the extension stops the malicious pre-sign before the wallet is ever called (Playwright)
[ ] Benign requests (SOL transfer, token transfer, swap) pass with a low rating and a small notice, no modal
[ ] The localnet report matches the example JSON contract: schema valid, every claim and evidence reference resolves
[ ] The same input produces a byte-identical report
[ ] DEMO.md lets you rebuild the devnet video setup in under 15 minutes
Rules that cannot bend
1. No third-party APIs. The only network calls are standard Solana JSON-RPC to an endpoint the user sets. No scanning services, no provider-specific RPC methods, no analytics, no remote AI.
2. Open-source building blocks, with each license checked before it ships (see Risks).
3. Read-only. The extension never holds keys, signs or submits.
4. Deterministic first. Findings come from rules and evidence. AI text is optional, runs on-device, and is validated against the claims.
5. Fail closed. If analysis errors or times out, the request stays held until the user decides.
6. No fake demo data. Every transaction on screen is either real mainnet history or actually executed on localnet or devnet.
Architecture
One analysis engine, written once in TypeScript, runs inside the extension's service worker and in a Node CLI. The extension only captures requests and shows decisions; everything else is the engine.
The page only ever gets a normal wallet answer: a signature after Sign anyway, or a user-rejection error after Block.
Key design choices
• Capture in the page, decide outside it. A content script in the page's main world, injected at document_start, wraps the wallet methods. It forwards the exact transaction bytes over a per-page random channel to an isolated-world bridge, which hands them to the service worker. The page never sees the analysis.
• Hook both Wallet Standard paths. Wallets announce themselves with wallet-standard:register-wallet, and apps call for wallets with wallet-standard:app-ready. Kelvara listens first on both, wraps each wallet's solana:signTransaction and solana:signAndSendTransaction features, then passes the wrapped wallet on. Legacy window.solana, window.phantom.solana, window.solflare and window.backpack get the same wrapping, with traps for wallets injected late.
• Report UI in an extension iframe inside a closed shadow root, so the page can neither read nor click it. If the page removes it, or nobody answers within 90 seconds, the request is blocked. Nonce Kit, an open-source extension, uses the same fail-closed pattern (Nonce Kit).
• Block looks like a normal user rejection (error code 4001), so dApps handle it cleanly. Sign anyway forwards the original call with the original bytes.
• Standard RPC only: getMultipleAccounts, getAccountInfo, getSignaturesForAddress, getTransaction and simulateTransaction. Simulation runs one transaction at a time in the extension; dependencies between transactions are found statically. Chained simulation runs only on localnet.
• Squads decoding without bundling Squads code. The shipped engine decodes Squads from its IDL, plus a small decoder for the transaction message stored inside a proposal. @sqds/multisig is used only by the scenario scripts (see Risks for why).
Repo layout
kelvara-signguard/
  CLAUDE.md            harness rules (section 9)
  PLAN.md              this plan, exported as Markdown
  PROGRESS.md          agent log: task, gate results, time, decisions
  NEEDS_HUMAN.md       open asks for you
  packages/
    core/              engine, pure TypeScript, browser + Node
      ingest/          legacy + v0 parsing, lookup tables, sessions
      decode/          IDL registry, Codama parsing, Squads message decoder
      state/           RPC reads: multisig, proposal, nonce, program data
      simulate/        simulateTransaction, decoded state diffs
      rules/           one file per ruleId, each with tests
      graph/           authority graph, capability diff, risk ranking
      report/          claims, evidence ledger, zod schema, digest
      explain/         templates, optional on-device AI, validator
    idls/              vendored IDLs, Codama roots, capability maps, hashes
    extension/         MV3: hook, bridge, service worker, report UI, license
    cli/               kelvara analyze | replay
    scenarios/         localnet + devnet scripts (dev-only dependencies)
  programs/helix-perps/  small Anchor demo protocol with admin-only instructions
  test-dapp/           static page + fixture wallet for end-to-end tests
  fixtures/            real transaction bytes + golden reports
  tools/selfcheck/     gate runner + scoreboard
Stack: Node 22, pnpm workspaces, TypeScript (strict), @solana/kit for transactions and RPC, Codama's dynamic parsers for IDL decoding, zod for the report schema, @noble/hashes and @noble/ed25519, esbuild with four entry points, vitest and Playwright. Localnet uses solana-test-validator; the demo program uses Anchor.
Core programs and IDLs
Seven P0 programs cover the demo and the most common admin takeover paths; P1 and P2 add breadth if time allows. Every program ID below is re-checked on-chain by gate G5 before anything ships. IDLs come from three places, none of them a third-party API: official Codama clients for native programs, Anchor IDL accounts read over standard RPC, and pinned commits of each protocol's open-source repo.
Priority
Program
Program ID
IDL source
Capability map
P0
System
11111111111111111111111111111111
@solana-program/system
Curated: durable nonce, assign, transfer
P0
SPL Token
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
@solana-program/token
Curated: authority types, delegates
P0
Token-2022
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
@solana-program/token-2022
Curated: adds permanent delegate and extension authorities
P0
Upgradeable loader
BPFLoaderUpgradeab1e11111111111111111111111
Hand-written decoder
Curated: upgrade, set authority, close
P0
Squads v4
SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
Anchor IDL, pinned
Curated: members, threshold, time lock, config authority, spending limits
P0
Drift v2
dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH
Anchor IDL, pinned
Curated: admin-only instructions
P0
Helix Perps (demo)
Set by the scenario deploy
Generated by anchor build
Derived from IDL account relations, then reviewed
P1
Compute Budget
ComputeBudget111111111111111111111111111111
@solana-program/compute-budget
None; filtered as noise
P1
Address Lookup Table
AddressLookupTab1e1111111111111111111111111
@solana-program/address-lookup-table
Curated: authority changes
P1
Memo
MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
Hand-written decoder
None; memo text is shown, since attackers use it as a label
P1
Kamino Lending
KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
Anchor IDL, pinned
Heuristic, low confidence
P1
marginfi v2
MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
Anchor IDL, pinned
Heuristic, low confidence
P1
Jupiter v6
JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
Anchor IDL, pinned
None; the benign baseline for swaps
P2
Orca Whirlpools, Raydium CLMM, Meteora DLMM, Metaplex Token Metadata
IDs come from each repo
Anchor or Shank IDL
Heuristic, low confidence
How each IDL is processed (pnpm idls:build)
1. Fetch the Anchor IDL account over RPC. Its address is derived from the program ID with the seed anchor:idl; the data is an 8-byte discriminator, a 32-byte authority, a 4-byte length, then zlib-compressed JSON. If there is none, take the repo file at a pinned commit.
2. Pin the JSON with its source, commit or slot, and sha256 in packages/idls/manifest.json.
3. Convert each Anchor or Shank IDL to a Codama root node at build time. Ship the root nodes, not raw IDLs.
4. Decode at runtime with Codama's parseInstruction(root, instruction), which returns the instruction, its arguments and its named accounts (@codama/dynamic-parsers).
5. Map capabilities: curated maps for P0, keyword rules for the rest (admin, authority, oracle, withdraw guard, pause, fee, weight, market). Every mapped capability carries its confidence.
Fallback: if a conversion fails, a small built-in Anchor decoder (8-byte discriminator plus Borsh arguments) handles that program. Anything still unknown is reported as Unknown, never as safe.
48-hour timeline
Nine milestones run back to back, each closed by its gate. The one hard checkpoint is hour 24: the engine must catch the Drift pattern on localnet before extension work starts.
Bars are drawn to scale in agent-hours. If a milestone runs 50% over, the agent cuts from the cut list instead of pushing the checkpoint.
Day 1: the engine (M0–M4)
Day 1 builds and proves the engine with no browser involved. By hour 24 the CLI must flag the Drift pattern on a live local validator.
M0 · Bootstrap and toolchain (hours 0–2)
Goal: an empty but green pipeline, so every later task lands in a checked repo.
• Create the pnpm monorepo and packages from the repo layout: TypeScript strict, vitest, esbuild, eslint.
• Install Playwright's bundled Chromium, the Agave CLI (solana-test-validator) and Anchor. Anchor gets 60 minutes; if it fails, switch to Plan B (Risks) and log it.
• Write CLAUDE.md from section 9, plus PROGRESS.md, NEEDS_HUMAN.md and LICENSES.md.
• Build tools/selfcheck with all ten gates registered. A gate with nothing built yet reports PENDING, never PASS.
• Check that localnet, devnet and the mainnet RPC endpoint respond; record which methods work on each.
• Record every dependency's license. Confirm @sqds/multisig's license and keep it inside scenarios only.
Gate: G1 passes, and pnpm selfcheck prints G1 PASS with G2–G10 PENDING.
M1 · Ingest and decode (hours 2–8)
Goal: any transaction or batch becomes named instructions with exact accounts.
• Parse legacy and v0 messages with @solana/kit. Resolve lookup tables with getMultipleAccounts. Keep the original message bytes and their sha256 hash in base58.
• Group one or several transactions into a session with stable indices.
• 30-minute spike: convert each P0 IDL to a Codama root and parse one real transaction per program. Keep what works; route failures to the fallback decoder.
• Squads: decode the transaction message inside vault_transaction_create, the stored message in vault transaction accounts, and multisig and proposal accounts.
• Hand-write the upgradeable loader and Memo decoders.
• Fixtures: for each P0 and P1 program, fetch 5 recent real transactions with getSignaturesForAddress and getTransaction, and store raw base64 plus metadata. Fetch Drift's two attack transactions (section 8) the same way.
Gate: G2. Every fixture decodes; at least 95% of fixture instructions resolve to a named instruction (programs without an IDL excepted); 1,000 random byte arrays produce errors, never crashes.
M2 · Rules, authority graph, claims (hours 8–16)
Goal: findings with evidence, in exactly the shape of the example API response.
• Evidence ledger and claim builder with the example's fields: id, kind, statement, evidenceIds, dependsOn, ruleId, assumptions, scope, transactionIndices.
• Rules, one file each, in order of demo value:
    1. lifetime.durable_nonce and nonce.staged_by_outsider (the nonce account's oldest transaction names its funder)
    2. squads.approve_and_execute, squads.threshold_met_in_session, squads.zero_timelock_execution, squads.unknown_proposal, Squads config changes
    3. authority.transfer (SPL SetAuthority, loader authority, protocol admin changes), token.delegate_granted, Token-2022 permanent delegate
    4. session.dependency, session.partial_execution, ordering outcomes
    5. tx.foreign_fee_payer, and intent.label_mismatch only when a label exists, such as a memo
• Capability diff: granted powers ranked by damage, revoked powers by defensive loss, recovery paths through the upgrade authority, using rubric capability-risk-v1 from the example.
• Risk rollup: the summary takes the highest severity among the claims.
• Report: zod schema, canonical JSON, sha256 digest.
Gates: G3, where every rule has passing positive and negative cases. G4, where the schema validates, every reference resolves, counts match, ranks follow the rubric, no Fact lacks evidence and no Derived claim lacks a ruleId.
M3 · Core IDLs and capability maps (hours 16–21)
Goal: every P0 program in section 3 is loaded and verified; P1 if time allows.
• pnpm idls:build: fetch, pin, convert, then write the registry (program ID to root, source and hash).
• Curated maps for System, SPL Token, Token-2022, the loader, Squads and Drift. Derive the Helix map from IDL relations, then review it.
• Keyword rules for the rest, labeled low confidence.
Gate: G5. Every program ID is an executable account, every IDL hash matches the manifest, every curated capability names an instruction that exists, and each P0 IDL decodes at least 3 real fixtures.
M4 · State, simulation, localnet scenario (hours 21–24)
Goal: end day 1 with the CLI flagging the Drift pattern on a live local validator.
• RPC layer with timeouts, retries with backoff, and a per-session cache.
• Reads: multisig, proposal, vault transaction, nonce, program data, and protocol state decoded with IDL account types.
• simulateTransaction with sigVerify: false, post-state for listed accounts and inner instructions. Diff decoded fields such as admin.
• Localnet: solana-test-validator cloning Squads v4 and its two config accounts from mainnet (Squads quickstart), plus Helix Perps.
• Scenario script: 5 members, threshold 2, time lock 0, the vault set as Helix admin, nonce accounts on two members' keys funded by an outsider, and the two pre-signed transactions.
Gate: G6. kelvara analyze on the pair returns critical with the durable-nonce, approve-and-execute, admin-change and capability claims. Executing the pair then really changes Helix's admin on-chain.
Day 2: the extension and the real test (M5–M8)
Day 2 wraps the engine in the paid extension and turns the Drift story into a demo you can record.
M5 · Extension: capture, hold, decide (hours 24–32)
Goal: a real signing request is held, analyzed, then blocked or passed, and on Block the wallet is never called.
• Manifest V3. Main-world hook and isolated bridge as document_start content scripts in all frames, a module service worker, and permissions limited to storage plus host access for the configured RPC endpoints.
• Hook. Catch wallet-standard:register-wallet and wallet-standard:app-ready before the app does. Wrap solana:signTransaction and solana:signAndSendTransaction; show a notice for solana:signMessage. Wrap legacy providers and trap late injection with property setters and a MutationObserver.
• Bridge. A random per-page channel id and strict message shapes. Nothing from the page is trusted beyond the transaction bytes and the wallet name.
• Service worker. Runs core on the session and picks the RPC endpoint from the wallet's chain (solana:mainnet, solana:devnet or localnet).
• Report UI. Risk header, ranked capabilities, claims that open their evidence, and the message hash. Block rejects with code 4001; Sign anyway forwards the original call and bytes; low risk passes with a small notice.
• Fail closed. A 90-second timeout, a removed iframe or an engine error all mean blocked.
• License. An Ed25519-signed key (email, plan, expiry) verified offline against a bundled public key. Without one, the user sees risk level and top finding only.
• Test dApp. A static page with a fixture wallet that implements both Wallet Standard paths and a legacy provider, signs with a throwaway key, and counts its calls.
Gate: G7, run in headless Chromium through Playwright's bundled chromium channel, which can load extensions headless (Playwright). A malicious batch shows Critical, and Block leaves the wallet's call count at 0. Sign anyway calls it once with identical bytes. A benign transfer shows no modal. Timeout and iframe removal both block. Both Wallet Standard paths and the legacy provider are caught.
M6 · Real-test assets (hours 32–38)
Goal: both demo stories run from scripts, and every transaction in them is real.
• Drift replay. kelvara replay <sig1> <sig2> fetches both transactions with getTransaction, stores raw bytes and sha256 as fixtures, and analyzes them as one session. The extension's Replay tab runs the same flow for the video. Historical account state can't be read over RPC, so replay relies on the transactions and their execution record. The first transaction creates the proposal, and execution in the same transaction as the second approval proves the time lock was zero.
• Localnet reenactment. pnpm scenario:drift-local builds the council, stages the nonces, has the fake "Helix Ops" page request the pre-sign, and runs the analyzer. Then it executes the pair and checks that the admin changed.
• Devnet video setup. pnpm scenario:drift-devnet deploys Helix, creates the multisig on the real Squads v4 devnet program, stages nonces, serves the attacker page on localhost, and writes the member keys you import into your wallet. It also checks whether Squads' open-source multisig-verifier can point at devnet, for an on-screen Squads approval.
Gate: G8. The replay session is critical with durable-nonce, approve-and-execute and UpdateAdmin claims, and the localnet scenario passes end to end.
M7 · Explanations, evidence UI, hardening (hours 38–44)
Goal: the report reads well, proves every sentence, and leaks nothing.
• Templates for every ruleId. These are the default explanation.
• Optional on-device AI. Chrome's Prompt API is available to extensions from Chrome 138 and accepts a JSON Schema through responseConstraint (Chrome Prompt API). Send only approved claims and require sentences with claim IDs. Reject unknown IDs, new numbers and any shift from "may" to "will"; fall back to templates.
• Evidence explorer. Each claim opens its instruction path, decoded arguments, IDL path and account snapshot.
• Performance budget. At p95, analysis takes under 1.5 seconds on localnet and under 3 seconds on public RPC.
Gates: G9, where three runs give identical digests, the validator rejects ten crafted bad AI outputs, and templates cover every ruleId. G10, where the bundle names no hosts beyond the RPC defaults, contains no remote code or eval, asks for minimal permissions, and checks licenses offline.
M8 · Demo and handoff (hours 44–48)
Goal: anyone can rebuild the demo from the repo.
• DEMO.md runbook for the shot list in section 8, tested once on devnet.
• README.md, a known-limitations list and dist/kelvara-signguard.zip.
• A final run from a clean clone, git clean -xfd && pnpm install && pnpm selfcheck, then commit SELFCHECK.md.
Gate: all ten gates PASS from the clean clone.
Cut list if behind schedule, top first: on-device AI; P2 IDLs; P1 IDLs except Jupiter; the devnet script (keep localnet); partial-execution scenarios; the license gate (keep a stub). Never cut G4, G6, G7 or G8.
Self-check system
One command, pnpm selfcheck, runs ten gates in order and writes SELFCHECK.md. The agent may not close a milestone until that milestone's gates pass.
Gate
What it proves
Command
Passes when
G1 Build
The code compiles cleanly
pnpm build && pnpm typecheck && pnpm lint
Zero errors
G2 Decode
Real transactions decode
pnpm test:decode
Every fixture decodes; at least 95% of instructions named; 1,000 fuzz inputs, no crash
G3 Rules
Each rule fires when it should, and only then
pnpm test:rules
Positive and negative cases pass for every ruleId
G4 Contract
Reports match the API contract
pnpm test:contract
Schema valid; references resolve; counts match; ranks follow the rubric; no Fact without evidence; no Derived claim without a ruleId
G5 Registry
IDLs and program IDs are real and pinned
pnpm test:registry
Program IDs executable; hashes match; curated maps name real instructions; each P0 IDL decodes 3 or more fixtures
G6 Localnet
The Drift pattern is caught, and the attack really works
pnpm test:localnet
Critical with the required claims, then execution changes the admin
G7 Extension
The browser path blocks before the wallet
pnpm test:e2e
Block, pass, timeout, tamper and hook-path cases pass headless
G8 Real test
Drift's real attack transactions are flagged
pnpm test:replay
Critical, with durable-nonce, approve-and-execute and UpdateAdmin claims
G9 Determinism
Same input, same report; AI can't add claims
pnpm test:determinism
Three identical digests; ten bad AI outputs rejected; a template for every ruleId
G10 Security
Nothing leaves the browser except RPC
pnpm test:security
No other hosts in the bundle; no eval or remote code; minimal permissions; offline license check
Scoreboard format (SELFCHECK.md, rewritten on every run)
Kelvara selfcheck  <UTC time>  commit <hash>
G1  build        PASS     <seconds>
G2  decode       PASS     <seconds>  <named %>, <fuzz passes>/1000
G6  localnet     FAIL     <seconds>  missing claim <ruleId>
G7  e2e          PENDING  (milestone M5)
How the agent uses it
• Run pnpm selfcheck --fast (G1–G4, under 2 minutes) after every task; run the full suite before closing a milestone.
• Any FAIL exits non-zero. PENDING is allowed only for gates that belong to later milestones.
• A flaky test is a bug: fix it, never rerun until green.
• Golden reports change only with a reason written in PROGRESS.md.
• G5 and G8 use cached real fixtures by default and live RPC with --live. Both modes must pass at M8.
The real test and the pitch video
The video rests on two real tests: Drift's actual attack transactions, and a live reenactment on devnet with the real Squads v4 program and a real wallet. Nothing on screen is mocked.
Test 1: Drift, replayed from mainnet history. BlockSec published both attack transactions (BlockSec):
• Create and approve: 2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H
• Approve and execute: 4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1. BlockSec lists its steps as AdvanceNonceAccount, proposalApprove, vaultTransactionExecute, then UpdateAdmin.
The agent fetches both with standard getTransaction, and G8 checks that the decoded steps match. If the public endpoint keeps no history back to April 2026, you supply any standard RPC endpoint that does; the raw bytes are then cached as fixtures, so tests never need it again. The extension gets a Replay tab that runs the same engine as kelvara replay.
Test 2: live reenactment on devnet. Squads v4 is already deployed on devnet (Squads quickstart). pnpm scenario:drift-devnet creates a council of five keys you control, with threshold 2 and time lock 0. It makes the vault the Helix Perps admin and has an outsider key stage nonce accounts on Members A and C. Finally it serves a fake "Helix Ops Portal" on localhost that asks a member to pre-sign a "Q4 fee update". If Squads' open-source multisig-verifier can point at devnet, a member also approves the malicious proposal there, so the video shows Kelvara inside a real Squads flow.
Shot list (about 2 minutes)
Time
Scene
On screen
0:00–0:10
Hook
"April 1, 2026: $285M left Drift. No bug. Two signatures."
0:10–0:35
Replay
Paste Drift's two real signatures into the Replay tab. Critical: durable nonce, approve and execute, UpdateAdmin to the attacker.
0:35–1:05
Live block
Member A clicks "Sign Q4 fee update". Kelvara holds it before the wallet opens: admin handover, nonce staged by an outsider, ranked capabilities. Block.
1:05–1:20
Proof
Open a claim: instruction, decoded arguments, IDL path, account state.
1:20–1:45
Without Kelvara
Extension off. Members A and C sign; the attacker executes; the devnet explorer shows Helix's admin changed.
1:45–2:00
Normal use
A plain transfer passes with a small notice. Close on "Know what you sign."
Recording notes
• Run pnpm scenario:drift-devnet --reset before each take for a fresh multisig and fresh nonces.
• Record with a wallet you have checked by hand against the hooks: Backpack or Solflare on devnet, or Phantom in its testnet mode.
• Label the replay as real mainnet transactions and the reenactment as devnet. Saying exactly what is real is part of the pitch.
Harness rules
Paste this into CLAUDE.md at the repo root. It turns the plan into a loop the agent can run unattended and audit as it goes.
# Kelvara SignGuard: agent operating rules

## Mission
Build the MVP in PLAN.md within 48 hours. Optimize for a green `pnpm selfcheck`
and a working Drift demo, not for feature count.

## Loop (repeat until M8 is closed)
1. Read PROGRESS.md and PLAN.md; take the first open task of the current milestone.
2. Write the test or gate check first when practical.
3. Implement the smallest change that makes it pass.
4. Run `pnpm selfcheck --fast` after every task; the full suite before closing a milestone.
5. Commit as `M<n>: <task>`; append one line to PROGRESS.md: task, gates, minutes, decisions.

## Hard rules
- Network: Solana JSON-RPC only (localnet, devnet, or the configured mainnet endpoint).
  No third-party APIs, analytics, telemetry or remote AI.
- Keys: localnet and devnet only, kept in `.keys/` (gitignored). Never a mainnet key.
- Tests: never skip, weaken or delete a failing test to go green. Fix the code, or
  write a waiver with the reason in PROGRESS.md.
- Golden files: change only with a written reason in PROGRESS.md.
- Data: fixtures come from real RPC responses or from transactions executed on
  localnet. Never invent transactions, addresses or results.
- Licenses: check each new dependency and record it in LICENSES.md. Nothing under
  AGPL, BUSL or MPL goes into packages/core or packages/extension.
- Extension: never sign, never submit, never store wallet secrets. Fail closed.

## Timeboxes
- One blocker: 45 minutes, then take the fallback in PLAN.md (Risks) and log it.
- A milestone 50% over budget: cut from the cut list in PLAN.md, top first.

## When you need the human
Write the exact ask in NEEDS_HUMAN.md, then keep working on unblocked tasks.

## Done
All ten gates PASS from a clean clone, SELFCHECK.md committed, DEMO.md tested,
dist/kelvara-signguard.zip built.
Kickoff prompt: with PLAN.md (this doc exported as Markdown) and CLAUDE.md in an empty repo, start the agent with: "Execute PLAN.md under the rules in CLAUDE.md, starting at M0. Report at each milestone gate."
Human checkpoints
The agent runs alone except at six points. Each takes you a few minutes, and the agent keeps working on unblocked tasks while it waits.
When
What you do
Why
Before hour 0
Provide a machine with Node 22 and internet access to npm, GitHub and Solana RPC; allow installing Rust, the Agave CLI and Anchor
Toolchain for M0
Before hour 0
Generate the license-signing keypair offline; give the agent only the public key
Paid license gate (M5); the private key never enters the repo
By hour 6
If the public mainnet endpoint lacks April 2026 history, provide a standard RPC URL that has it
Drift replay fixtures (M1, M6)
By hour 32
Fund a devnet keypair with about 5 SOL (estimate: program deploy plus accounts) and save it as .keys/devnet-payer.json
Deploying Helix and creating accounts on devnet (M6)
By hour 40
Install Chrome and a devnet-capable wallet; import the Member A and C keys the script writes
A hand check of the hooks with a real wallet before recording
Hours 44–48
Review SELFCHECK.md, then record with DEMO.md
The pitch
Risks and fallbacks
The biggest risk is a real wallet slipping past the hooks; every other risk has a cheap fallback.
Risk
Early signal
Fallback
A real wallet slips past the hooks
G7 passes with the fixture wallet, but a hand test with Backpack, Solflare or Phantom shows no modal
Hook both Wallet Standard paths and the legacy providers. If one wallet still slips, record with a verified wallet and list the gap. Nonce Kit documents the same limit: wallets that sign through unhooked methods bypass it silently (Nonce Kit).
Anchor fails in the harness
anchor build still failing after 60 minutes
Plan B demo, no custom program: the vault holds a token's mint authority and the Squads config, and the attack takes those instead of a protocol admin.
Codama can't convert an IDL
The M1 spike throws
The built-in Anchor decoder for that program; Unknown for anything left.
No RPC history for Drift's transactions
getTransaction returns null
You provide a standard RPC endpoint with history; the bytes are cached once fetched. Without it, the localnet and devnet reenactments carry the video.
Public RPC rate limits
429 responses
Backoff and per-session caching; all tests run on localnet or cached fixtures.
Licenses in a paid product
Squads' repo names AGPL-3.0 as its primary license (Squads v4); Nonce Kit is MPL-2.0
Keep @sqds/multisig in dev-only scenario scripts and decode Squads from its IDL. Reimplement hook patterns instead of copying MPL files. The Apache-2.0 multisig-verifier and multisig-cli (Solana Multisig Tools) are safe to learn from with attribution. This is a practical screen, not legal advice.
On-device AI missing on the demo machine
LanguageModel.availability() says unavailable; it needs at least 22 GB free disk and more than 4 GB of VRAM
Templates are the default, so nothing breaks.
No chained simulation in the extension
Transaction 2 can't be simulated on top of transaction 1
Static dependency analysis in the extension; chained execution on localnet only.
Chrome Web Store review of a paid, wallet-intercepting extension
Review takes longer than the hackathon
Demo from the unpacked build and zip; submit to the store afterwards.
Sources
• Product scope: Kelvara SignGuard build plan and the example API response (internal)
• BlockSec: Drift Protocol incident analysis
• Squads docs: developer quickstart
• Squads Protocol v4 repository
• Solana Multisig Tools: multisig-verifier, multisig-cli, multisig-monitor
• @codama/dynamic-parsers
• Playwright: Chrome extensions
• Chrome: the Prompt API
• Nonce Kit on Firefox Add-ons
