# Devnet demo

Run from the repository root with Node 22+, pnpm, Solana CLI and cargo-build-sbf installed. Helius is the only remote RPC. Put HELIUS_API_KEY in the **main checkout's** .env; never copy it into a worktree. A human must fund a devnet-only .keys/devnet-payer.json in the main checkout (about 5 devnet SOL). Never use a mainnet wallet or key.

The scenario scripts export base58 private keys with mode 0600 into the worktree's gitignored .keys/devnet/. Import these files into Solflare **by hand**, switch Solflare and SignGuard options to devnet, and configure the extension's Helius key. Agents must never open wallet prompts or read private key exports.

## Story 1: Ops Portal

    pnpm --filter @kelvara/scenarios scenario:admin-devnet --reset

Open http://localhost:8781 and import .keys/devnet/member-a.solflare.txt into Solflare. Click **Approve Q4 fee update**. With SignGuard active, inspect the durable nonce and proposal's upgrade-authority transfer, then click **Block** in SignGuard. Solflare must not open after Block.

Setup deploys a small real executable from packages/scenarios/programs/devnet-demo, creates a real Squads v4 council (2 of 3, time lock 0), moves the deployed program's upgrade authority to its vault, and creates an outsider-funded nonce and malicious proposal. packages/scenarios/.devnet/admin/scenario.json records addresses and a real simulation. No tokens move in the approval; Member A pays its fee.

For the unprotected story, stop the server with Ctrl-C and execute the script's burner keys:

    pnpm --filter @kelvara/scenarios scenario:admin-devnet:attack

The script submits Member A's exact approval bytes, adds Member B's approval, executes through Member C, and verifies that the deployed program's authority is the attacker. Evidence is packages/scenarios/.devnet/admin/attack.json. The attacker is outside the council; Member C is the compromised executor.

## Story 2: $SHINY launch

    pnpm --filter @kelvara/scenarios scenario:trap-devnet --reset

Open http://localhost:8782 and import .keys/devnet/trap-user.solflare.txt into Solflare. Click **Buy SHINY**. The page gets a fresh seller-signed transaction for 1 devnet SOL / 50,000 SHINY on every click, so blockhash expiry does not break a take. With SignGuard active, inspect permanent delegate and freeze authority, then click **Block**.

For the unprotected scripted purchase and theft:

    pnpm --filter @kelvara/scenarios scenario:trap-devnet:attack

This verifies that the buyer receives 50,000 SHINY and that the creator removes all of it as permanent delegate and freezes the buyer account without the buyer's signature. Evidence is packages/scenarios/.devnet/trap/attack.json.

## L4 example: "Claim airdrop" wallet sweep

    pnpm --filter @kelvara/scenarios scenario:sweep-devnet

Setup tops the user up to 0.05 devnet SOL and mints two airdrop tokens to it (the two Token-2022 mints are created once). Open http://localhost:8783 and import .keys/devnet/sweep-user.solflare.txt into Solflare. Click **Claim airdrop**. The page rebuilds the request from the user's current balances on every click: one transaction, signed by the user only, that moves both token balances, both token accounts' rent and every lamport but the fee to a collector address that does not sign. SignGuard must reject it at L4 (wallet.sweep) at once: the wallet never opens and there is no Sign anyway. packages/scenarios/.devnet/sweep/scenario.json records the addresses and a real simulation that leaves the user at 0 SOL.

For the unprotected scripted sweep:

    pnpm --filter @kelvara/scenarios scenario:sweep-devnet:attack

This signs and submits the sweep, verifies the user is left with 0 lamports and no token accounts, stores the executed transaction as the `l4-sweep` e2e fixture under fixtures/tx/devnet/sweep/, then the collector burns the tokens, closes its accounts and returns every lamport to the payer. A run costs about 0.00002 devnet SOL in fees. Evidence is packages/scenarios/.devnet/sweep/attack.json. A new setup archives an executed one.

## Repeating and verification

--reset creates fresh proposals/nonces or a fresh mint. Member A and buyer keys stay stable so wallet imports survive resets. Admin resets deploy a fresh small program and archive its old program key under .keys/devnet/archive/; abandoned accounts retain devnet rent. Each actor is topped up from the payer only as needed. No faucet or non-Helius provider is used.

--serve-only serves the last setup without spending SOL; --no-serve sets up and exits; --attack sets up and immediately runs the scripted attack; --attack-only executes the existing setup. Do not reuse an executed setup for wallet inspection; reset it first. Pages ask for a Wallet Standard signature but do not submit it; the scripted attack signs with the devnet burner keys independently.

    pnpm --filter @kelvara/scenarios test
    cd packages/scenarios
    node --test e2e-devnet/demo-devnet.test.mjs e2e-devnet/sweep-devnet.test.mjs
    cd ../..
    pnpm selfcheck --fast

The live test spends devnet SOL and takes no wallet action. Outputs are real on-chain reads/simulations or executed transactions in the gitignored package .devnet directory. The localhost server exposes only its page and transaction endpoint; it never serves keys or the Helius URL.

Human verification remains: run both pages with Solflare and SignGuard, record screenshots/video, and conduct the separate Phantom scanner comparison without approving. No claim about wallet warning screens is established by script tests. If real Squads devnet is unavailable, PLAN.md permits Story 1 on cloned localnet with an explicit on-screen **localnet** label; that fallback does not satisfy devnet G8.
