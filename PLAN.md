Kelvara SignGuard — 48-Hour MVP Build Plan
Nov 6, 2026 · @Andrzej
This plan lets a coding agent build and verify the Kelvara SignGuard MVP in 48 hours: a paid Chrome extension that holds every Solana signing request until it has shown, with evidence, what that signature authorizes.
Goal and definition of done
In 48 agent-hours, ship a Chrome extension that catches every Solana signing request in the page, analyzes the exact bytes against Helius RPC, and blocks a Drift-style admin takeover with an evidence-backed report. Done means the self-check scoreboard is green and the demo runs end to end on devnet.
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
1. Helius is the only network provider. Every mainnet and devnet call, in the extension, the CLI, scenarios, fixtures and tools, goes to Helius: its RPC (mainnet.helius-rpc.com, devnet.helius-rpc.com) and, where useful, its APIs (DAS, Parsed Events, Parsed Streams, enhanced history). Localnet is the only exception, because Helius cannot serve a local validator. No other RPC providers, scanning services, price feeds, analytics or remote AI.
1a. The Helius key. Tools and scenarios read HELIUS_API_KEY from .env. The extension reads the key the user enters in its options page (chrome.storage.local); the unpacked dev build may prefill it from .env, but the release zip never contains a key, and G10 checks that. The key never appears in commits, logs, fixtures or reports; redact it from every URL before logging.
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
• Helius RPC for everything: getMultipleAccounts, getAccountInfo, getSignaturesForAddress, getTransaction and simulateTransaction, plus Helius DAS for token and asset metadata and Helius history for questions like who funded a nonce account. Every Helius-specific call sits behind one adapter in packages/core/state, so tests run on cached fixtures and localnet runs on the same code with standard methods only. Unsigned transaction bytes are still decoded by the engine itself, since Parsed Events only covers confirmed transactions. Simulation runs one transaction at a time in the extension; dependencies between transactions are found statically. Chained simulation runs only on localnet.
• Squads decoding without bundling Squads code. The shipped engine decodes Squads from its IDL, plus a small decoder for the transaction message stored inside a proposal. @sqds/multisig is used only by the scenario scripts (see Risks for why).
Building blocks we reuse
Five existing pieces replace work this plan would otherwise do from scratch. Each one is used under the rules above: anything that breaks them is removed, not reused.
1. sol-sign-preview (our own, ISC; /home/andy/side_projects/sol-sign-preview, github andrzejsantocki/solana-sign-decoder). A working MV3 extension that already intercepts Wallet Standard and legacy providers (Phantom, Solflare, Backpack, OKX), holds the request, rejects with 4001, and passes the original bytes through on approval. It is the starting point for M5 capture, not a rewrite. Port src/inject.js and the capture half of src/content.js to TypeScript in packages/extension, then fix what this plan requires and it does not do:
   • Channel: it uses window.postMessage(…, '*') with fixed source tags, so a page can forge an "approved" decision. Replace with the random per-page channel and strict message shapes from Key design choices. G7 gets a test where the page forges an approval and the wallet call count stays 0.
   • Analysis runs in the content script; move it to the service worker and the core engine.
   • Timeout is 60 s; make it 90 s, still fail closed.
   • Report UI: mount it as an extension iframe inside a closed shadow root.
   • Keep its Helius RPC wiring (__HELIUS_RPC__), but read the key from options storage instead of baking it in, and drop its public-RPC fallbacks (api.mainnet-beta, api.devnet, api.testnet). Remove every non-Helius host: the CoinGecko price fetch (overlay.js; use Helius DAS prices if a USD value is needed), Solscan links, the local IDL backend (backend.js, server/) and its OpenAI-compatible LLM client. G10 enforces this.
   Its decode.js, cpi.js and semantic.js are reference only; the engine decodes through Codama per this plan. Its capture log and pass-through mode are worth keeping for hand tests.
2. Helius Watchtower (MIT; github helius-labs/watchtower). A program monitor whose detectors cover the same attack: durable-nonce approvals, Squads v4 proposal decoding (including transaction buffers), multisig changes, authority and delegate hand-offs, nonce accounts set up for privileged keys, and an attack-chain linker. It already speaks Helius, so we use it two ways. (a) Run it as is, with your Helius key, as dev tooling under tools/watchtower: its replay of the Drift window (2026-03-20 to 2026-04-02) and its own check-drift-replay script are an independent cross-check of our G8 result, and its report on the Drift and Squads programs feeds the demo. It is mainnet only, so it does not watch the devnet scenario. (b) Port its detection logic into the engine, with attribution in LICENSES.md. Its detectors read Parsed Events transactions, which exist only after confirmation, and the extension sees unsigned bytes, so each detector becomes a rule in packages/core/rules reading our own decoded session. Its Helius adapters (src/helius/) can be reused inside our Helius adapter for history and DAS. Its Squads notes (buffer instructions missing from the IDL, snake_case args, u64 as BigInt, Map-based rule tables) go straight into M1 and M2. Its scripts/check-drift-replay.mjs names a third real Drift transaction, the new admin's first admin call (see Test 1).
3. SolSub (solsub.sol.site, the allowances view). A live dApp built on Solana's Subscriptions program that grants and revokes token allowances. It is the real-world test for delegation: token.delegate_granted must name the exact delegate and amount and flag unlimited allowances, and a revoke must read as a revoked power. Which networks it supports and its program ID are unverified; check them in the browser session in M0 and add the program to the registry if it is not plain SPL Approve.
4. OPEN DevTool (MIT; github OpenSubmissionn/Open_DevTool). A standalone transaction profiler with a CLI (opendev tx <sig>) that decodes, builds the CPI tree and simulates base64 transactions. Dev-only: a second opinion on our decoding of fixtures and a debugging aid for agents. Never bundled, never a gate, and its AI insights stay off (no key configured).
5. Kelvara wallet browser (/home/andy/KELVARA/local-browser-session). An isolated Brave profile with a Solflare burner wallet (7sXHKv8RJG4ENmiDSpBEgiEnktJXPaVEmq2a8QBsvEgJ), switchable to devnet, with Chrome DevTools Protocol on 127.0.0.1:28538 only. It is the real-wallet test bench: the hand check against the hooks, the SolSub delegation test and the video recording. tools/browser/launch.sh starts the same profile with Solflare plus our unpacked build. Its SKILL.md rules apply in full: agents may drive pages and click Block in our report over CDP, but never Sign anyway, never anything inside Solflare, and never read the profile or .env. Every wallet approval is done by you, by hand. Do not run it while the Kelvara session uses the same profile.
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
Seven P0 programs cover the demo and the most common admin takeover paths; P1 and P2 add breadth if time allows. Every program ID below is re-checked on-chain by gate G5 before anything ships. IDLs come from three places: official Codama clients for native programs, Anchor IDL accounts read over Helius RPC, and pinned commits of each protocol's open-source repo.
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
• Check that localnet, Helius devnet and Helius mainnet respond with the key from .env; record which methods and Helius APIs work on each, and the plan's rate limits.
• Record every dependency's license. Confirm @sqds/multisig's license and keep it inside scenarios only.
• Write tools/browser/launch.sh (Kelvara wallet browser plus our unpacked build) and check that CDP answers on loopback. Open SolSub's allowances view and record in PROGRESS.md which networks it supports and which program its approvals call. Stop before any wallet prompt.
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
• Port the matching Watchtower detectors as the starting logic for these rules (nonce.ts, multisigProposal.ts, upgradeProposal.ts, multisigChange.ts, keyAuthority.ts, nonceAuthority.ts, attackChain.ts), rewritten to read our decoded session. Port their test cases as rule fixtures where they come from real transactions.
• Rules, one file each, in order of demo value:
    1. lifetime.durable_nonce and nonce.staged_by_outsider (the nonce account's oldest transaction names its funder)
    2. squads.approve_and_execute, squads.threshold_met_in_session, squads.zero_timelock_execution, squads.unknown_proposal, Squads config changes
    3. authority.transfer (SPL SetAuthority, loader authority, protocol admin changes), token.delegate_granted (exact delegate and amount; unlimited or near-max allowance ranks high), token.delegate_revoked, Token-2022 permanent delegate
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
• Start from sol-sign-preview (Building blocks, item 1): port its hook and capture code to TypeScript and apply the listed fixes. Extension work on capture, hold and decide can start right after M0 against a stub of the engine API; only wiring the real engine waits for the hour-24 checkpoint.
• Manifest V3. Main-world hook and isolated bridge as document_start content scripts in all frames, a module service worker, and permissions limited to storage plus host access for mainnet.helius-rpc.com, devnet.helius-rpc.com, the Helius API host and localhost:8899. Options page: Helius API key, network, and a test button.
• Hook. Catch wallet-standard:register-wallet and wallet-standard:app-ready before the app does. Wrap solana:signTransaction and solana:signAndSendTransaction; show a notice for solana:signMessage. Wrap legacy providers and trap late injection with property setters and a MutationObserver.
• Bridge. A random per-page channel id and strict message shapes. Nothing from the page is trusted beyond the transaction bytes and the wallet name.
• Service worker. Runs core on the session and picks the endpoint from the wallet's chain: Helius mainnet for solana:mainnet, Helius devnet for solana:devnet, localhost:8899 for localnet. No key set means the request is held and the report says so: fail closed.
• Report UI. Risk header, ranked capabilities, claims that open their evidence, and the message hash. Block rejects with code 4001; Sign anyway forwards the original call and bytes; low risk passes with a small notice.
• Fail closed. A 90-second timeout, a removed iframe or an engine error all mean blocked.
• License. An Ed25519-signed key (email, plan, expiry) verified offline against a bundled public key. Without one, the user sees risk level and top finding only.
• Test dApp. A static page with a fixture wallet that implements both Wallet Standard paths and a legacy provider, signs with a throwaway key, and counts its calls.
Gate: G7, run in headless Chromium through Playwright's bundled chromium channel, which can load extensions headless (Playwright). A malicious batch shows Critical, and Block leaves the wallet's call count at 0. Sign anyway calls it once with identical bytes. A benign transfer shows no modal. Timeout and iframe removal both block. Both Wallet Standard paths and the legacy provider are caught. A page that forges an approval message gets a rejection and the wallet is never called.
Real-wallet check (not a gate, logged in PROGRESS.md): in the Kelvara wallet browser on devnet, a request from Solflare shows our report before Solflare opens, and Block means Solflare never opens. You do the Solflare side.
M6 · Real-test assets (hours 32–38)
Goal: both demo stories run from scripts, and every transaction in them is real.
• Drift replay. kelvara replay <sig1> <sig2> fetches both transactions with getTransaction, stores raw bytes and sha256 as fixtures, and analyzes them as one session. The extension's Replay tab runs the same flow for the video. Historical account state can't be read over RPC, so replay relies on the transactions and their execution record. The first transaction creates the proposal, and execution in the same transaction as the second approval proves the time lock was zero.
• Localnet reenactment. pnpm scenario:drift-local builds the council, stages the nonces, has the fake "Helix Ops" page request the pre-sign, and runs the analyzer. Then it executes the pair and checks that the admin changed.
• Delegation test. On SolSub's allowances view in the Kelvara wallet browser, grant and then revoke an allowance. The report must name the delegate, the token and the amount, and the revoke must show as a revoked power. Store both transactions as fixtures once you have signed them; if SolSub has no devnet, this runs on mainnet with a tiny amount only after you approve it in NEEDS_HUMAN.md.
• Devnet video setup. pnpm scenario:drift-devnet deploys Helix, creates the multisig on the real Squads v4 devnet program, stages nonces, serves the attacker page on localhost, and writes the member keys you import into your wallet. It also checks whether Squads' open-source multisig-verifier can point at devnet, for an on-screen Squads approval.
Gate: G8. The replay session is critical with durable-nonce, approve-and-execute and UpdateAdmin claims, and the localnet scenario passes end to end.
M7 · Explanations, evidence UI, hardening (hours 38–44)
Goal: the report reads well, proves every sentence, and leaks nothing.
• Templates for every ruleId. These are the default explanation.
• Optional on-device AI. Chrome's Prompt API is available to extensions from Chrome 138 and accepts a JSON Schema through responseConstraint (Chrome Prompt API). Send only approved claims and require sentences with claim IDs. Reject unknown IDs, new numbers and any shift from "may" to "will"; fall back to templates.
• Evidence explorer. Each claim opens its instruction path, decoded arguments, IDL path and account snapshot.
• Performance budget. At p95, analysis takes under 1.5 seconds on localnet and under 3 seconds on Helius.
Gates: G9, where three runs give identical digests, the validator rejects ten crafted bad AI outputs, and templates cover every ruleId. G10, where the bundle names no hosts beyond Helius and localhost, the release zip contains no API key, contains no remote code or eval, asks for minimal permissions, and checks licenses offline.
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
Nothing leaves the browser except Helius RPC and APIs
pnpm test:security
No hosts but Helius and localhost; no API key in the release zip; no eval or remote code; minimal permissions; offline license check
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
• After the takeover (optional third fixture, from Watchtower's Drift replay check): the new admin's first admin call, initialize_spot_market, 4a5962Rdqd9pkXtk9DMQ9ZYhdGb2k9gPw71GvukJgELhxbCY5gm1c1hhKdwuGefyqJ3XMvihUTDNDn3qbXnst82X. It shows what the stolen admin was used for; it is not part of G8.
The agent fetches both with getTransaction over Helius RPC, and G8 checks that the decoded steps match. Helius keeps full history; the raw bytes are then cached as fixtures, so tests run offline. The extension gets a Replay tab, using the user's Helius key, that runs the same engine as kelvara replay.
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
• Record in the Kelvara wallet browser (tools/browser/launch.sh) with Solflare on devnet, after the real-wallet check in M5 has passed.
• Label the replay as real mainnet transactions and the reenactment as devnet. Saying exactly what is real is part of the pitch.
Harness rules
Superseded: the live rules are in CLAUDE.md (Orca team version). The single-agent text below is kept for reference.
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
- Network: Helius only (RPC and APIs) for mainnet and devnet; localnet for local tests.
  No other providers, analytics, telemetry or remote AI.
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
Provide a machine with Node 22 and internet access to npm, GitHub and Helius; allow installing Rust, the Agave CLI and Anchor
Toolchain for M0
Before hour 0
Generate the license-signing keypair offline; give the agent only the public key
Paid license gate (M5); the private key never enters the repo
By hour 6
Put your Helius API key in .env as HELIUS_API_KEY (never in chat or a commit)
Drift replay fixtures (M1, M6)
By hour 32
Fund a devnet keypair with about 5 SOL (estimate: program deploy plus accounts) and save it as .keys/devnet-payer.json
Deploying Helix and creating accounts on devnet (M6)
By hour 40
In the Kelvara wallet browser, unlock Solflare, switch it to devnet and import the Member A and C keys the script writes; approve the SolSub grant and revoke by hand
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
sol-sign-preview already catches Solflare, Phantom, Backpack and OKX on real dApps, so start from it and keep its diagnostics popup to see which path a wallet used. If one wallet still slips, record with a verified wallet and list the gap. Nonce Kit documents the same limit: wallets that sign through unhooked methods bypass it silently (Nonce Kit).
Anchor fails in the harness
anchor build still failing after 60 minutes
Plan B demo, no custom program: the vault holds a token's mint authority and the Squads config, and the attack takes those instead of a protocol admin.
Codama can't convert an IDL
The M1 spike throws
The built-in Anchor decoder for that program; Unknown for anything left.
No RPC history for Drift's transactions
getTransaction returns null
Check the key and the Helius plan's history limit; the bytes are cached once fetched. Without them, the localnet and devnet reenactments carry the video.
Helius rate limits or credits run out
429 responses
Backoff and per-session caching; all tests run on localnet or cached fixtures; Watchtower scans only the Drift window, since Parsed Events scans cost credits.
Licenses in a paid product
Squads' repo names AGPL-3.0 as its primary license (Squads v4); Nonce Kit is MPL-2.0
Keep @sqds/multisig in dev-only scenario scripts and decode Squads from its IDL. Reimplement hook patterns instead of copying MPL files. The Apache-2.0 multisig-verifier and multisig-cli (Solana Multisig Tools) are safe to learn from with attribution. This is a practical screen, not legal advice.
Reused code brings in a forbidden host or a weak channel
sol-sign-preview calls CoinGecko, Solscan, public RPC and an LLM backend; a Helius key ends up in the bundle; G10 or the forged-approval test fails
Strip the non-Helius calls during the port, keep the key in options storage only, never reuse the sol-sign-preview server, and keep the forged-approval test in G7.
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
• sol-sign-preview (own): github.com/andrzejsantocki/solana-sign-decoder
• Helius Watchtower: github.com/helius-labs/watchtower
• OPEN DevTool: github.com/OpenSubmissionn/Open_DevTool
• SolSub: solsub.sol.site
• Product scope: Kelvara SignGuard build plan and the example API response (internal)
• BlockSec: Drift Protocol incident analysis
• Squads docs: developer quickstart
• Squads Protocol v4 repository
• Solana Multisig Tools: multisig-verifier, multisig-cli, multisig-monitor
• @codama/dynamic-parsers
• Playwright: Chrome extensions
• Chrome: the Prompt API
• Nonce Kit on Firefox Add-ons
