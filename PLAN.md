Kelvara SignGuard — 48-Hour MVP Build Plan
Nov 6, 2026 · @Andrzej
This plan lets a coding agent build and verify the Kelvara SignGuard MVP in 48 hours: a paid Chrome extension that holds every Solana signing request until it has shown, with evidence, what that signature authorizes.
Goal and definition of done
In 48 agent-hours, ship a Chrome extension that catches every Solana signing request in the page, analyzes the exact bytes against Helius RPC, and stops the signatures that simulation-based scanners pass: ones that move no tokens now but hand over power for later. The 2-minute demo shows two of them, one for protocol admins and one for everyday users. Done means the self-check scoreboard is green and both demo stories run end to end on devnet.
The thesis
Blockaid-style scanners mostly simulate a transaction and show what moves right now: balances, approvals, known-bad addresses. SignGuard reads what a signature authorizes: who gains control of what, and when it can be used. Its findings are the cases where simulation says "0 tokens move" or "normal swap" and the transaction is still dangerous. Before the pitch claims that scanners miss a scenario, M6 checks it in a Blockaid-powered wallet (Phantom) and records what it showed. The pitch claims only what was observed.
Graded alerts
Every report lands on exactly one of five levels. Only the top level acts without asking; every other dangerous level asks the user, because a real admin may mean to do exactly this.
• L4 Blocked, obvious scam. Rejected at once with code 4001; the wallet never opens and there is no Sign anyway. The report explains why. Only Fact claims from a short scam-rule list can reach L4, never Derived, Conditional or Unknown ones: the user's own wallet assigned to another program (System Assign); the owner or close authority of the user's token accounts handed to a key outside the session (SetAuthority); a sweep that moves all of the signer's SOL and tokens to one address that did not sign; a transfer to a poisoned address (see address.poisoning below); any of these behind a durable nonce. To sign anyway the user pauses the extension; there is no in-page override.
• L3 Critical, approval required. Held; Block is the default button, and Sign anyway needs a second, deliberate step (hold to confirm). Examples: control of a program, multisig, mint or protocol admin passes to a key outside the session; a durable-nonce approval of a Squads proposal that does this.
• L2 Warning, approval required. Held with Block and Sign anyway side by side. Examples: Token-2022 trap extensions on a token the user receives, an unlimited token allowance, a fee payer outside the user's keys.
• L1 Notice. Passes; a small notice shows what was checked.
• L0 Clear. Passes silently.
The level is the highest one any claim reaches, and the rubric (alert-levels-v1) is part of the report contract. Precision matters most at L4: G3 requires that no benign fixture, from any program, ever reaches L4.
Capability preview: what the new authority can do
When a transaction hands an authority to someone, the report lists what that authority will be able to call, before the user signs.
• From a verified Anchor IDL. For the program the authority governs, list every instruction whose signer is tied to that authority, with its name, its 8-byte discriminator, what it changes, and a damage rank. The tie comes from the IDL itself: an account constraint (relations or has_one to the field that holds the authority, a fixed address, or a PDA seeded by it), read from the program's Codama root. "Verified" means the IDL is the program's own on-chain Anchor IDL account, its authority equals the program's upgrade authority, and its hash is pinned in packages/idls/manifest.json; everything else is labeled lower confidence.
• Upgrade authority is the extreme case. Whoever holds it can replace the code, so the preview says "can deploy any code" first, then lists the instructions already reachable today as examples.
• No IDL or no constraint data: assess the future state instead. (1) Simulate and diff, to find every account where the new key now appears as an authority. (2) Read the program's recent history over Helius and list the instructions that the old authority actually signed: an observed capability list, labeled Conditional. (3) Anything still unknown is shown as Unknown, never as harmless.
• Token-2022 uses the same view: a permanent delegate "can call Transfer and Burn on your account"; a freeze authority "can call FreezeAccount on your account".
The preview is a claim like any other, with evidence (IDL path, constraint, history signatures) behind every line.
What ships
• Chrome extension (Manifest V3). Hooks Wallet Standard wallets and the legacy Phantom, Solflare and Backpack providers. Holds signTransaction, signAllTransactions, signAndSendTransaction and sendTransaction until the user chooses Block or Sign anyway.
• Analysis engine. Decodes System, SPL Token, Token-2022 (including mint extensions), the upgradeable loader and Squads v4 (including the transaction inside a proposal). Applies durable-nonce, authority, Token-2022 and multi-transaction rules, ranks granted and revoked capabilities by risk, assigns one of five alert levels, previews what a newly granted authority can call, and emits claims labeled Fact, Derived, Conditional or Unknown, each tied to evidence.
• Report UI. Alert level, risk summary, ranked capability changes, the capability preview ("what the new authority can do"), a "what simulation shows" line next to "what you actually authorize", claims that open their evidence, and the message hash to match on a Ledger.
• License gate. An offline-verified signed license key unlocks the full report; without one, the user sees the risk level and top finding.
• Scenario kit. Two scenarios, each on localnet and devnet: the Squads upgrade hijack (admins) and the Token-2022 trap token (users). Plus a replay of Drift's two real attack transactions for the opening shot.
• Self-check. One command, pnpm selfcheck, runs ten gates and writes a scoreboard.
Definition of done
[ ] pnpm selfcheck passes all ten gates from a clean clone
[ ] Admin story: approving the "Q4 fee update" proposal is held at L3 Critical, with the inner SetAuthority on the program's upgrade authority, the durable nonce and its outsider funder, and "simulation: 0 tokens move"
[ ] User story: buying the trap token is held at L2 Warning, naming the permanent delegate and freeze authority, while simulation shows a normal purchase
[ ] Both stories: the extension stops the request before the wallet is ever called (Playwright), and the attack really works when the extension is off
[ ] Drift replay: both real attack transactions rated critical
[ ] Benign requests (SOL transfer, token transfer, swap of a plain SPL token) land on L0 or L1, no modal
[ ] Obvious-scam requests (a wallet sweep, a send to a poisoned lookalike address) are blocked at L4 without the wallet ever opening, and no benign fixture reaches L4
[ ] Capability preview: the Drift replay lists the admin-gated Drift instructions the attacker gained, from Drift's verified IDL; the admin story lists the demo program's admin instructions under "can deploy any code"
[ ] The report matches the example JSON contract: schema valid, every claim and evidence reference resolves
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
  packages/scenarios/programs/  prebuilt demo program (.so), the upgrade target; no Anchor
  test-dapp/           static page + fixture wallet for end-to-end tests
  fixtures/            real transaction bytes + golden reports
  tools/selfcheck/     gate runner + scoreboard
Stack: Node 22, pnpm workspaces, TypeScript (strict), @solana/kit for transactions and RPC, Codama's dynamic parsers for IDL decoding, zod for the report schema, @noble/hashes and @noble/ed25519, esbuild with four entry points, vitest and Playwright. Localnet uses solana-test-validator; there is no Anchor program.
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
Demo program (upgrade target)
Set by the scenario deploy (a prebuilt program, no Anchor)
None; only its upgrade authority matters
Loader-level: upgrade, set authority, close
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
6. Build the authority map for the capability preview: for each instruction, which stored authority field its signer is tied to (relations or has_one, fixed address, PDA seeds), plus the discriminator. Mark the IDL verified only if it is the on-chain IDL account, its authority equals the upgrade authority, and its hash is pinned.
Fallback: if a conversion fails, a small built-in Anchor decoder (8-byte discriminator plus Borsh arguments) handles that program. Anything still unknown is reported as Unknown, never as safe.
48-hour timeline
Nine milestones run back to back, each closed by its gate. The one hard checkpoint is hour 24: the engine must catch both demo scenarios on localnet before the extension wires in the real engine.
Bars are drawn to scale in agent-hours. If a milestone runs 50% over, the agent cuts from the cut list instead of pushing the checkpoint.
Day 1: the engine (M0–M4)
Day 1 builds and proves the engine with no browser involved. By hour 24 the CLI must flag the upgrade hijack and the trap token on a live local validator.
M0 · Bootstrap and toolchain (hours 0–2)
Goal: an empty but green pipeline, so every later task lands in a checked repo.
• Create the pnpm monorepo and packages from the repo layout: TypeScript strict, vitest, esbuild, eslint.
• Install Playwright's bundled Chromium and the Agave CLI (solana-test-validator, solana program dump and deploy). No Anchor.
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
    3b. Token-2022 trap rules on any mint the user receives or buys: token2022.permanent_delegate (the creator can move or burn the user's balance), token.freeze_authority (the creator can freeze it), token2022.transfer_hook (a program runs on every transfer), token2022.default_frozen and token2022.non_transferable. Read the mint and its extensions with getAccountInfo; never trust the dApp's label.
    3d. Address poisoning (farmed lookalike addresses). For every SOL or token transfer, resolve the real recipient (the owner of a token account) and read the user's recent history over Helius (the last 30 days, at most 1,000 signatures, cached per session). Dust means: SOL of 0.001 or less, a zero-amount token transfer, a token worth $0.01 or less by Helius DAS price, or a token that copies the name or symbol of one the user holds but has a different mint.
        • address.poisoning (L4): the recipient sent the user dust, the user has never sent to the recipient, and the recipient looks like an address the user really has sent to: they share at least 5 characters across the start and the end, at least 2 on each side. The report shows both addresses one above the other with the matching characters marked, and the dust transaction as evidence.
        • address.dust_sender (L3): the recipient sent the user dust and the user has never sent to it, with no lookalike found.
        • address.first_send (L1): a first transfer to a new address, as a notice only.
    3c. sim.power_without_value: when simulation shows no balance change (or only the expected purchase) but the session grants a capability, say so in plain words. This is the line the demo points at.
    4. session.dependency, session.partial_execution, ordering outcomes
    5. tx.foreign_fee_payer, and intent.label_mismatch only when a label exists, such as a memo
• Capability diff: granted powers ranked by damage, revoked powers by defensive loss, recovery paths through the upgrade authority, using rubric capability-risk-v1 from the example.
• Alert level: the report takes the highest level any claim reaches, under rubric alert-levels-v1 (Graded alerts). L4 only from Fact claims of the scam-rule list: system.assign_takeover, token.owner_takeover, wallet.sweep, address.poisoning, and each of them behind a durable nonce.
• Capability preview (graph/preview): for each authority the session grants, list the instructions it unlocks from the authority map, ranked by damage; fall back to simulate-and-diff and to the old authority's Helius history, labeled Conditional; Unknown for the rest.
• Report: zod schema, canonical JSON, sha256 digest.
Gates: G3, where every rule has passing positive and negative cases, and no benign fixture from any program reaches L4. G4, where the schema validates, every reference resolves, counts match, ranks follow the rubric, no Fact lacks evidence and no Derived claim lacks a ruleId.
M3 · Core IDLs and capability maps (hours 16–21)
Goal: every P0 program in section 3 is loaded and verified; P1 if time allows.
• pnpm idls:build: fetch, pin, convert, then write the registry (program ID to root, source and hash).
• Curated maps for System, SPL Token, Token-2022 (with its extensions), the loader, Squads, and Drift (only for the replay).
• Keyword rules for the rest, labeled low confidence.
• Authority maps for Drift (for the replay preview) and the demo program, built from their IDLs and reviewed by hand once.
Gate: G5. Every program ID is an executable account, every IDL hash matches the manifest, every curated capability names an instruction that exists, each P0 IDL decodes at least 3 real fixtures, and every authority-map entry names a real instruction and a real account constraint.
M4 · State, simulation, localnet scenarios (hours 21–24)
Goal: end day 1 with the CLI flagging both demo scenarios on a live local validator.
• RPC layer with timeouts, retries with backoff, and a per-session cache.
• Reads: multisig, proposal, vault transaction, nonce, program data, and mints with their Token-2022 extensions.
• simulateTransaction with sigVerify: false, post-state for listed accounts and inner instructions. Keep the simulated balance changes so the report can show "what simulation shows".
• Localnet: solana-test-validator cloning Squads v4 and its two config accounts from mainnet (Squads quickstart), plus the demo program from packages/scenarios/programs.
• Demo program: a real open-source Anchor program with admin-gated instructions and an on-chain IDL, dumped from mainnet with solana program dump and deployed under our keys, with its IDL published from the script (no Anchor CLI). Pick it in M0 and record why; if publishing the IDL fails, pin the IDL from its repo and label it unverified.
• Admin scenario (pnpm scenario:admin-local): deploy the demo program; a council of 3 members, threshold 2, time lock 0; the Squads vault set as the program's upgrade authority; an outsider-funded nonce account on Member A's key; and a proposal whose memo says "Q4 fee update" while its vault transaction calls the loader's SetAuthority to give the upgrade authority to the attacker.
• User scenario (pnpm scenario:trap-local): a Token-2022 mint "$SHINY" with a permanent delegate and a freeze authority held by the creator, and a partially signed "buy" transaction in which the user pays 1 SOL and the seller sends 50,000 $SHINY.
Gate: G6. kelvara analyze returns critical for the admin approval (inner SetAuthority, durable nonce, outsider funder, zero time lock) and L2 Warning for the trap purchase (permanent delegate, freeze authority), each with the "simulation shows" line. Then the attacks really run: executing the proposal changes the program's upgrade authority, and the creator pulls the bought $SHINY back with the permanent delegate.
Day 2: the extension and the real test (M5–M8)
Day 2 wraps the engine in the paid extension and turns both stories into a demo you can record.
M5 · Extension: capture, hold, decide (hours 24–32)
Goal: a real signing request is held, analyzed, then blocked or passed, and on Block the wallet is never called.
• Start from sol-sign-preview (Building blocks, item 1): port its hook and capture code to TypeScript and apply the listed fixes. Extension work on capture, hold and decide can start right after M0 against a stub of the engine API; only wiring the real engine waits for the hour-24 checkpoint.
• Manifest V3. Main-world hook and isolated bridge as document_start content scripts in all frames, a module service worker, and permissions limited to storage plus host access for mainnet.helius-rpc.com, devnet.helius-rpc.com, the Helius API host and localhost:8899. Options page: Helius API key, network, and a test button.
• Hook. Catch wallet-standard:register-wallet and wallet-standard:app-ready before the app does. Wrap solana:signTransaction and solana:signAndSendTransaction. Message signing (solana:signMessage, solana:signIn, legacy signMessage/signIn) is held for a message review before the wallet is called (user decision 2026-11-08, X17); any other signing-capable or unknown feature is blocked fail-closed. No wallet prompt may open before the user finishes SignGuard's review. Wrap legacy providers and trap late injection with property setters and a MutationObserver.
• Bridge. A random per-page channel id and strict message shapes. Nothing from the page is trusted beyond the transaction bytes and the wallet name.
• Service worker. Runs core on the session and picks the endpoint from the wallet's chain: Helius mainnet for solana:mainnet, Helius devnet for solana:devnet, localhost:8899 for localnet. No key set means the request is held and the report says so: fail closed.
• Report UI. Alert level, risk header, the capability preview, ranked capabilities, claims that open their evidence, and the message hash. Behavior per level: L4 rejects with code 4001 without opening the wallet and shows the report with no Sign anyway; L3 holds with Block as default and hold-to-confirm Sign anyway; L2 holds with both buttons; L1 passes with a small notice; L0 passes silently. Block rejects with 4001; Sign anyway forwards the original call and bytes.
• Fail closed. A 90-second timeout, a removed iframe or an engine error all mean blocked.
• License. An Ed25519-signed key (email, plan, expiry) verified offline against a bundled public key. Without one, the user sees risk level and top finding only.
• Test dApp. A static page with a fixture wallet that implements both Wallet Standard paths and a legacy provider, signs with a throwaway key, and counts its calls.
Gate: G7, run in headless Chromium through Playwright's bundled chromium channel, which can load extensions headless (Playwright). An L4 sweep is rejected with no Sign anyway and a wallet call count of 0. An L3 batch is held, and Block leaves the call count at 0. Sign anyway calls it once with identical bytes. A benign transfer shows no modal. Timeout and iframe removal both block. Both Wallet Standard paths and the legacy provider are caught. A page that forges an approval message gets a rejection and the wallet is never called.
Real-wallet check (not a gate, logged in PROGRESS.md): in the Kelvara wallet browser on devnet, a request from Solflare shows our report before Solflare opens, and Block means Solflare never opens. You do the Solflare side.
M6 · Real-test assets (hours 32–38)
Goal: both demo stories run from scripts on devnet, every transaction in them is real, and the scanner comparison is recorded.
• Devnet scenarios. pnpm scenario:admin-devnet and pnpm scenario:trap-devnet do the same as the localnet versions on devnet, using the real Squads v4 devnet program. Each serves its attacker page on localhost (the "Ops Portal" and the "$SHINY launch" page) and writes the keys you import into Solflare.
• Poisoning scenario (pnpm scenario:poison-devnet): the user's wallet first pays a "friend" address; the script grinds a lookalike (solana-keygen grind, 3 characters at the start and 2 at the end) and sends the user 0.0001 SOL from it; a page then asks the user to send 0.5 SOL to the lookalike. It is the L4 example for the closing shot. Real fixtures: find at least 5 real poisoning transactions on mainnet through Helius history (dust from a lookalike right after a real transfer) and use them in G3, along with 20 real first-time transfers that must not reach L4.
• Sweep scenario (pnpm scenario:sweep-devnet): a "claim airdrop" page that asks the wallet to sign a transaction moving all of its devnet SOL and tokens to one address. It is the L4 example for G7.
• Scanner comparison. In a separate browser profile with Phantom (Blockaid-powered) in testnet mode on devnet, run both scenarios up to Phantom's confirmation screen and screenshot what it shows. Record it in PROGRESS.md; DEMO.md and the pitch use only what was observed. Never approve in Phantom.
• Drift replay. kelvara replay <sig1> <sig2> fetches both transactions over Helius, stores raw bytes and sha256 as fixtures, and analyzes them as one session. The extension's Replay tab runs the same flow for the 10-second opening shot.
• Delegation test. On SolSub's allowances view in the Kelvara wallet browser, grant and then revoke an allowance. The report must name the delegate, the token and the amount, and the revoke must show as a revoked power. Store both transactions as fixtures once you have signed them; if SolSub has no devnet, this runs on mainnet with a tiny amount only after you approve it in NEEDS_HUMAN.md.
Gate: G8. The Drift replay session is critical with durable-nonce, approve-and-execute and UpdateAdmin claims, and both devnet scenarios pass end to end from their scripts.
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
Cut list if behind schedule, top first: on-device AI; P1 and P2 IDLs; the SolSub delegation test; the devnet poisoning scenario (keep the rule and its mainnet fixtures); the Replay tab (keep the CLI replay and G8); trap rules beyond permanent delegate and freeze authority; partial-execution scenarios; the license gate (keep a stub). Never cut G4, G6, G7 or G8, or either demo scenario.
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
Positive and negative cases pass for every ruleId; no benign fixture reaches L4
G4 Contract
Reports match the API contract
pnpm test:contract
Schema valid; references resolve; counts match; ranks follow the rubric; no Fact without evidence; no Derived claim without a ruleId
G5 Registry
IDLs and program IDs are real and pinned
pnpm test:registry
Program IDs executable; hashes match; curated maps name real instructions; each P0 IDL decodes 3 or more fixtures
G6 Localnet
Both demo scenarios are caught, and both attacks really work
pnpm test:localnet
Admin approval critical and trap purchase high, with the required claims; then the upgrade authority changes and the creator pulls the tokens back
G7 Extension
The browser path blocks before the wallet
pnpm test:e2e
L4 auto-block, L3/L2 hold, L1/L0 pass, timeout, tamper and hook-path cases pass headless
G8 Real test
Drift's real attack transactions are flagged, and both devnet scenarios run
pnpm test:replay
Drift replay critical with durable-nonce, approve-and-execute and UpdateAdmin claims; both devnet scripts pass
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
The real tests and the pitch video
The video shows two live stories on devnet with a real wallet, opened by one real mainnet replay. Nothing on screen is mocked.
Opening: Drift, replayed from mainnet history. BlockSec published both attack transactions (BlockSec):
• Create and approve: 2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H
• Approve and execute: 4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1. BlockSec lists its steps as AdvanceNonceAccount, proposalApprove, vaultTransactionExecute, then UpdateAdmin.
• After the takeover (optional third fixture, from Watchtower's Drift replay check): the new admin's first admin call, initialize_spot_market, 4a5962Rdqd9pkXtk9DMQ9ZYhdGb2k9gPw71GvukJgELhxbCY5gm1c1hhKdwuGefyqJ3XMvihUTDNDn3qbXnst82X. Not part of G8.
The agent fetches them with getTransaction over Helius; the raw bytes are cached as fixtures, so tests run offline.
Story 1, protocol admins: the Squads upgrade hijack. A council of three on the real Squads v4 devnet program, threshold 2, time lock 0, controls the upgrade authority of a deployed program. A fake "Ops Portal" asks Member A to approve the "Q4 fee update" proposal, using a durable nonce an outsider funded. Inside the proposal, the vault transaction hands the program's upgrade authority to the attacker. Simulating the approval moves nothing, which is why it looks safe.
Story 2, everyday users: the Token-2022 trap token. A "$SHINY launch" page sells 50,000 $SHINY for 1 SOL. Simulation shows exactly that: a normal purchase. The mint has a permanent delegate and a freeze authority held by the creator, so after the sale the creator can take the tokens back or freeze them.
Shot list (2 minutes)
Time
Scene
On screen
0:00–0:10
Hook
Drift's two real transactions in the Replay tab: "April 2026: $285M left Drift. No exploit, and no tokens moved when they signed." The preview lists what the new admin could call, from Drift's verified IDL.
0:10–0:45
Admin: blocked
Member A clicks Approve on "Q4 fee update" in the Ops Portal. Kelvara holds it before Solflare opens. L3 Critical: "Hands control of program 7Xk… to an unknown key", durable nonce funded by an outsider, "Simulation: 0 tokens move". The preview: "can deploy any code", then the program's admin instructions by name. Open one claim to show the decoded inner instruction. Block.
0:45–1:00
Admin: without Kelvara
Extension off. Members A and B approve, the attacker executes, and the devnet explorer shows the new upgrade authority.
1:00–1:35
User: blocked
On the $SHINY page, Buy. Simulation line: "you pay 1 SOL, you get 50,000 $SHINY". Kelvara: L2 Warning, "the creator can take these tokens back anytime, and can freeze them". Block.
1:35–1:50
User: without Kelvara
Extension off. The purchase goes through; the creator runs one command and the 50,000 $SHINY leave the buyer's wallet.
1:50–2:00
Close
The user pastes an address from their history to send 0.5 SOL. It is the farmed lookalike that dusted them yesterday: blocked at L4, the two addresses shown one above the other with the matching characters marked. The same send to the real address passes with a small notice. "Simulation shows what moves. Kelvara shows what you give away."
Recording notes
• Run pnpm scenario:admin-devnet --reset and pnpm scenario:trap-devnet --reset before each take for fresh accounts and nonces.
• Record in the Kelvara wallet browser (tools/browser/launch.sh) with Solflare on devnet, after the real-wallet check in M5 has passed.
• Label the Drift replay as real mainnet transactions and both stories as devnet. Name a scanner only if the M6 comparison showed it passing that scenario.
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
Provide a machine with Node 22 and internet access to npm, GitHub and Helius; allow installing Rust and the Agave CLI
Toolchain for M0
Before hour 0
Generate the license-signing keypair offline; give the agent only the public key
Paid license gate (M5); the private key never enters the repo
By hour 6
Put your Helius API key in .env as HELIUS_API_KEY (never in chat or a commit)
All mainnet and devnet calls, including the Drift replay fixtures (M1, M6)
By hour 32
Fund a devnet keypair with about 5 SOL (estimate: program deploy, multisig, mint and accounts) and save it as .keys/devnet-payer.json
Deploying the demo program, the Squads council and the $SHINY mint on devnet (M6)
By hour 40
In the Kelvara wallet browser, unlock Solflare, switch it to devnet and import Member A's key and the buyer key the scripts write; approve the SolSub grant and revoke by hand. Separately, install Phantom in a fresh profile for the scanner comparison
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
Squads devnet setup fails
scenario:admin-devnet errors on the Squads v4 devnet program
Record Story 1 on localnet with cloned Squads v4 instead, and say so on screen.
Codama can't convert an IDL
The M1 spike throws
The built-in Anchor decoder for that program; Unknown for anything left.
No RPC history for Drift's transactions
getTransaction returns null
Check the key and the Helius plan's history limit; the bytes are cached once fetched. Without them, the video opens on Story 1 instead.
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


## User scope update — evidence-bound intent review (2026-11-08)
This user request supersedes the earlier remote-AI prohibition and AI cut only for optional intent-question selection. Chain RPC remains Helius-only. Every transaction still gets the existing report. Put one contextual question in that report; keep existing Cancel/Continue decisions (no extra mandatory checkbox for routine transfers). Offer correction choices without typing by default; a correction cannot modify the transaction, downgrade a rule, or override L4. Changed message bytes require a fresh review.

Settings: API URL, API key and model are all inside an initially collapsed AI-provider section. Support OpenAI-compatible endpoints (HTTPS, and HTTP loopback for local models), an explicit enable choice and a clear disclosure that public engine facts go to the selected provider. Request only the configured host at the user's Save click via optional host permissions; no wildcard runtime permission grant. Keep keys in extension storage only, never in reports/logs/pages/release. Disable redirects for authenticated requests. AI failures/unsupported providers/timeouts/refusals/malformed output use the deterministic question and retain the deterministic report.

AI receives bounded engine-authored candidate questions/reasons and transaction binding, not arbitrary page prompts or raw signed bytes. Its structured output selects a candidate and reason IDs. Validate all selections/references and exact hashes; no invented prose/facts may enter the report, no lower-priority candidate may hide a higher-consequence effect. Label AI-selected versus deterministic output accurately. Routine transfer/memo uses deterministic templates (no AI call). Amounts, exact recipient counts, comparison addresses, completeness and unknown effects come from engine state; successful outgoing transactions to the exact recipient only count, never incoming dust, failed transactions or lookalikes. Partial history is explicit; familiarity is never called safety.

Additive core contract (do not change kelvara-report-v1 schema/digest):
- AnalyzeResult.intentContext: IntentContext; export buildIntentContext and validateIntentContext plus types from core.
- IntentContext = {version:"kelvara-intent-v1", messageHashes:string[], complex:boolean, fallbackId:string, historyNote:string, candidates:IntentCandidate[]}.
- IntentCandidate = {id:string, kind:"transfer"|"authority"|"fees"|"token-risk"|"poisoning"|"memo"|"unknown", priority:0|1|2|3|4, question:string, reasons:IntentReason[], comparison:null|{proposed:string,previous:string,prefix:number,suffix:number}}.
- IntentReason = {id:string,text:string,claimIds:string[],evidenceIds:string[]}.
- Caps: <=8 candidates, <=6 reasons/candidate, <=64 tx hashes, IDs <=80 chars, question <=300, reason <=600, historyNote <=600. Fields must have exact keys; unique candidate IDs and reason IDs, hashes match the report. Unknown must remain unknown. Context uses actual decoded instructions/RuleState.history; incomplete read is not new-recipient proof.
- validateIntentContext(value, expectedHashes) returns IntentContext|null. buildIntentContext/report analysis remains deterministic and browser-safe.
- Extension ReportView optional intent = {context:IntentContext, selectedId:string, reasonIds:string[], source:"engine"|"ai", status:"template"|"not-configured"|"selected"|"unavailable"|"invalid"}; validate exact shape and refs plus report hashes. Defaults absent for old fixtures; real engine attaches context. AI returned schema selection = {binding:string,candidateId:string,reasonIds:string[]}; binding = messageHashes.join(":"). Selection cannot lower priority below context fallback and cannot omit the chosen candidate's primary reason. No response grants authorization.

Hackathon proof: two real devnet Squads proposals share the exact signed memo "Q4 fee update"; one has a real verified fee-config change, one transfers upgrade authority. Same existing shared test account can approve either. Label the effects precisely as proposed future effects (approval is not execution). Do not fake a fee change with a memo/no-op or invent an instruction ABI; unknown semantics must be shown unknown. Preserve existing playground and provide a reproducible prepare command. Agent never approves wallet prompts or uses Sign anyway.

## User scope update — two-step report (2026-11-08)
Every report opens on step 1 "Confirm intent": the level presentation (calm at L0, coloured banner from L2), an Assessment card with a plain-language explanation (from the user's AI provider when enabled and valid, cited to claim ids and validated; otherwise SignGuard's own text) and one intent question with "Yes, this is what I intended" and "No, reject". Professional captions only ("Assessment by your AI provider" / "Assessment by SignGuard"). Step 2 "Review details" appears only after Yes: simulation, IDL-named instructions per transaction, the resulting new states, the Ledger hash line, and the existing decision controls. Block and the 90 s fail-closed timer apply from step 1; L4 never offers Sign anyway; AI never changes facts, levels or controls.

## User scope update — trusted sites and aggregators (2026-11-08)
The service worker keeps a reviewed list of trusted sites (exact HTTPS origins, no wildcards), starting with https://jup.ag (role aggregator) and https://app.velocity.exchange (role perp DEX), each with a reason. Every trusted site gets the green site pill; only aggregators get the routing rule below. Aggregators route trades through third-party programs by design, so for a request from a trusted aggregator origin an instruction ClearSign cannot decode is not treated as a risk on its own: the report shows "Routed by <site> through <program>" instead of "Can't fully verify", and no unknown-effects intent question is asked. The trust never lowers the engine level, never hides or downgrades any risk claim (authority, delegate, freeze, sweep, poisoning, durable nonce, Squads), never applies to look-alike or http origins or iframes of other origins, and every report still names the unreadable programs. The list lives in code with a test and is shown on the Options page.


## User scope update — AI on every request (2026-11-08)
When the user's AI provider is enabled it explains and selects the intent question for every report, routine memos and transfers included (supersedes "Routine transfer/memo uses deterministic templates (no AI call)"). Disabled or failing providers still fall back to ClearSign's own text; AI never changes facts, levels or controls.
