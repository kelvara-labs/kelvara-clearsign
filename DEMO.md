# Kelvara SignGuard demo runbook

This runbook covers the 2-minute shot list in PLAN.md (section 8). Run every command from the repository root of the main checkout. The scripted parts (setups, attack pages, scripted attacks, engine output) were last tested on Helius devnet on 2026-11-07; see "Test record" at the end. The human does every wallet step: an agent never opens Solflare, never signs and never reads a key export.

All quoted engine text below comes from real `kelvara analyze` / `kelvara replay` runs on 2026-11-07. Addresses change with every `--reset`, so on screen they will differ from the examples. The wording, levels and rule ids stay the same.

## 0. Prerequisites (once)

| What | How | Check |
|---|---|---|
| Node 22+, pnpm 10, Solana CLI (`solana`, `solana-keygen`) | system install | `node -v`, `pnpm -v`, `solana --version` |
| Dependencies and build | `pnpm install && pnpm build` | `packages/extension/dist/manifest.json` and `packages/cli/dist/kelvara.mjs` exist |
| Helius key | `HELIUS_API_KEY=...` in the main checkout's `.env` (never in a worktree, never printed) | scenario scripts start without "HELIUS_API_KEY missing" |
| Devnet payer | `.keys/devnet-payer.json` in the main checkout, devnet only, about 5 SOL (4.92 SOL on 2026-11-07) | the scripts print `payer … before: X SOL` |
| License (human only) | `node packages/extension/scripts/issue-license.mjs --key <your private key, outside the repo> --email <you> --plan pro --days 365` | prints a `KSG1.…` string. Without it the report shows only the level and the top finding |
| Wallet browser | `tools/browser/launch.sh` (loads Solflare plus `packages/extension/dist`; see tools/browser/README.md). Port 127.0.0.1:28538 must be free, so stop the `kelvara-wallet-exposure-preview` container first (NEEDS_HUMAN.md) | `node tools/browser/cdp-check.mjs` |
| Extension options | Open the SignGuard options page and set: Helius API key, network **devnet**, then paste the `KSG1.…` license and click Save license | the options page shows the license as valid and Test connection succeeds |
| Solflare | switch to **devnet**; import keys as each shot says (Settings, Add wallet, Private key; paste the file contents by hand) | the right address shows in Solflare |

Wallet import files are written by the setups, with mode 0600, to the worktree's gitignored `.keys/devnet/`: `member-a.solflare.txt`, `trap-user.solflare.txt`, `sweep-user.solflare.txt`. They keep the same key across `--reset`, so you import each one only once. Never use a mainnet wallet.

Before each take (fresh nonce, proposal and mint; also recycles the previous run's SOL):

    pnpm scenario:admin-devnet --reset --no-serve
    pnpm scenario:trap-devnet --reset --no-serve
    pnpm scenario:sweep-devnet --no-serve

Then serve the page for the shot you are recording with `--serve-only` (shown per shot). One server per terminal; Ctrl-C stops it. The pages listen on 127.0.0.1 only, answer GET only (POST returns 403), serve only `/` and `/transaction`, and ask Solflare for `signTransaction` (never sign-and-send), so nothing a page asks for gets submitted.

## Shot 1 (0:00–0:10): Hook, Drift's real transactions

The Replay tab was cut (PLAN cut list, X7). Show the CLI replay instead, in a terminal next to the browser. Replay exactly the two attack transactions that G8 checks (the approval with the updateAdmin proposal, then the approve-and-execute):

    node packages/cli/dist/kelvara.mjs replay \
      2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H \
      4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1 2>&1 | head -22

This runs offline from `fixtures/tx/drift-replay/` (real mainnet transactions). Add `--live` to read current Helius mainnet state (offline, the nonce creators and the multisig are not read, so those claims are `Unknown`). Do not add the third fixture (`4a59…`): with three transactions the engine currently drops to L2 (engine bug, reported). The screen must show (2026-11-07 run):

- `ALERT L3 Critical -> hold_block_default`
- `[L3 Fact] authority.transfer c1: Proposed updateAdmin protocol.admin on 5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN: AiLGdNitMjv8n5HMS7HAdV2kaeJZZFd4jdfn5xp1PKrW gives authority to H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL.`
- `[L3 Fact] lifetime.durable_nonce` twice: transaction 0 on nonce `7s7s…tAeC` (proposalApprove) and transaction 1 on nonce `EmYE…hQnc` (proposalApprove, vaultTransactionExecute): "…so it does not expire: whoever holds the signed bytes can submit them at any later time."
- `[L3 Fact] squads.approve_and_execute c6: This session approves proposal J1w1…xti8 on multisig 2LW6…hx88 (approved by 39Jy…7Aq8, 6UJb…u924) and executes its vault transaction 2QmM…DAwc in the same session: the vote and the action land together, on a durable nonce, so they can land at any time the holder chooses.`
- `Preview (lower): H7Pi…7ZgL unlocks 136: settleExpiredMarket, initialize, initializeSpotMarket, …` (from Drift's IDL)

On-screen label: **"Real mainnet transactions (Drift)"**. The "$285M" figure in PLAN's hook line comes from PLAN, not from our tools; use it only if you have checked the public source.

## Shot 2 (0:10–0:45): Admin, blocked (Story 1, Squads upgrade hijack)

    pnpm scenario:admin-devnet --serve-only

1. In Solflare select the imported **member-a** wallet (devnet).
2. Open http://localhost:8781 (title "Ops Portal") and click **Approve Q4 fee update**. Connect Member A if the page asks.
3. SignGuard must hold the request **before Solflare opens**. The report shows:
   - Level **L3 Critical**, Block focused by default. Sign anyway needs a long press: do not use it.
   - Title: `Critical: Proposed setAuthority program.upgrade on <ProgramData>: <Squads vault> gives authority to <attacker>.`
   - Simulation line: `Simulation shows: Transaction 0: <Member A> -0.000005 SOL` (only the fee moves)
   - Claims, quoted from the 2026-11-07 run (template titles from E15 in brackets):
     - `[L3 Fact] authority.transfer` (Control of an account or program moves to another key)
     - `[L3 Fact] lifetime.durable_nonce`: "…so it does not expire: whoever holds the signed bytes can submit them at any later time. It carries Squads proposalApprove…" (The transaction does not expire)
     - `[L3 Fact] nonce.staged_by_outsider`: "Nonce account 3wvo…nJMo was created and funded by 2SvK…R198, who is not its authority J76M…BfD5 and does not sign this session…" (The nonce account was set up by someone outside your wallet)
     - `[L2 Derived] intent.label_mismatch`: "Transaction 0 is labeled "Q4 fee update" (memo, memo of proposalApprove), but it carries a proposal that, once executed, gives program.upgrade … The label does not mention that power."
     - `[L1 Derived] squads.zero_timelock_execution`: time lock of 0 seconds, no review window
     - `[L1 Derived] sim.power_without_value`: "…0 tokens move. Yet it carries a proposal that … gives program.upgrade … the risk is the power, not the amount."
   - Preview: **can deploy any code** ("replaces the program's code: every other power of the program follows"); recovery: "No recovery path: the upgrade authority itself passes to 9xEa…9aCY".
4. Open the `authority.transfer` claim to show its evidence (the decoded inner setAuthority in the Squads vault transaction).
5. Click **Block**. Solflare must not open. Proof: no Solflare popup, and the page reports the request was rejected.

Note: the demo program is a tiny no-op program (packages/scenarios/programs/devnet-demo), so the preview has no named admin instructions. The claim names the **ProgramData** account (`udD6…`) and the preview names the program (`C5P6…`); both are correct. Named admin instructions appear on the Drift replay (shot 1) and on localnet with the marginfi IDL.

Cross-check without the wallet: `node packages/cli/dist/kelvara.mjs analyze --network devnet packages/scenarios/.devnet/admin/approval.unsigned.b64` (text first, then JSON).

## Shot 3 (0:45–1:00): Admin, without Kelvara

Ctrl-C the server, then:

    pnpm scenario:admin-devnet:attack

The script submits Member A's exact approval bytes on the nonce, adds Member B's approval, executes through Member C, and checks the result. Expected last lines:

    executed <sig>: demo program <program> upgrade authority is now the attacker <attacker>
    payer after: … (+0.39 this run)   (the actors' SOL goes back to the payer)

Proof on screen: open `https://explorer.solana.com/address/<demoProgram>?cluster=devnet` in the human's browser (address in `packages/scenarios/.devnet/admin/scenario.json`, `demoProgram`) and show "Upgrade Authority" = the attacker. Evidence file: `packages/scenarios/.devnet/admin/attack.json`. (The explorer is the human's viewing aid; our tools only talk to Helius.)

If you want the wallet-path version (extension off, Member A approves in Solflare), that is the human's call; the scripted attack proves the same outcome without a wallet.

## Shot 4 (1:00–1:35): User, blocked (Story 2, Token-2022 trap)

    pnpm scenario:trap-devnet --serve-only

1. Select the imported **trap-user** wallet in Solflare (devnet).
2. Open http://localhost:8782 ("$SHINY launch") and click **Buy SHINY**. Every click fetches a freshly seller-signed buy, so an expired blockhash does not break a take.
3. SignGuard holds it. The report shows:
   - Level **L2 Warning**, Block and Sign anyway side by side.
   - Title: `Warning: Mint <SHINY mint>: Permanent delegate <creator> can call Transfer and Burn on your balance.`
   - Simulation line starts with: `Simulation shows: Transaction 0: <user> -1.00152384 SOL; <seller> +1 SOL; … <user> +50000 of mint <SHINY mint>` (1 SOL, the fee and the new token account's rent)
   - Claims:
     - `[L2 Fact] token2022.permanent_delegate`: "Permanent delegate GcW5…P6ow can call Transfer and Burn on your balance." (The token has a permanent delegate)
     - `[L2 Fact] token.freeze_authority`: "Freeze authority GcW5…P6ow can call FreezeAccount on your balance." (The token can be frozen)
     - `[L1 Derived] sim.power_without_value`: "Simulation of transaction 0 shows only a normal purchase: your wallet pays 1.00001 SOL and receives 50000 of mint … Yet it carries token.permanent_delegate … the risk is the power, not the amount."
   - Preview: the creator unlocks `transferChecked, transfer, burnChecked, burn` and `freezeAccount, thawAccount`.
4. Click **Block**. Solflare must not open.

Cross-check: `node packages/cli/dist/kelvara.mjs analyze --network devnet --wallet <user from .devnet/trap/scenario.json> packages/scenarios/.devnet/trap/buy.partial.b64`.

## Shot 5 (1:35–1:50): User, without Kelvara

Ctrl-C the server, then:

    pnpm scenario:trap-devnet:attack

Expected lines:

    buy landed <sig>: user holds 50,000 SHINY
    creator pulled 50000 SHINY back with the permanent delegate and froze the user's account: <sig>

The creator's "one command" is this script's second step: one transaction signed only by the creator. Proof: `packages/scenarios/.devnet/trap/attack.json`, or the user's token account in the explorer (`?cluster=devnet`): balance 0, state Frozen.

## Shot 6 (1:50–2:00): Close, address poisoning (L4)

    pnpm scenario:poison-devnet

The setup pays a "friend" 0.01 SOL from the user, sends the user dust from a ground lookalike, then builds the 0.5 SOL send to the lookalike. **There is no wallet page or Solflare export for this story yet**, so record the close in a terminal:

    node packages/cli/dist/kelvara.mjs analyze --network devnet \
      --wallet <user from .devnet/poison/scenario.json> packages/scenarios/.devnet/poison/send.unsigned.b64 2>&1 | head -9

Expected (2026-11-07 run):

    ALERT L4 Blocked -> reject
    Simulation shows: Transaction 0: BhAZ… -0.500005 SOL; A8yFk8de2QXndMebgExKhxdct6EdyAADjka1WSchGamu +0.5 SOL
      [L4 Fact] address.poisoning c1: Poisoned address: A8yF…Gamu sent you dust and you have never sent to it, but it looks like A8yH…dWmu, an address you really paid.
    recipient:        [A8y]Fk8de2QXndMebgExKhxdct6EdyAADjka1WSchGa[mu]
    you really sent:  [A8y]HT9RFGdV2Wv2FUFpy8T6b2mb3PzaysvEZ34s2dW[mu]

Afterwards run `pnpm --filter @kelvara/scenarios scenario:poison-devnet:attack`: it really sends the 0.5 SOL to the lookalike, then returns the lookalike's, the user's and the friend's SOL to the payer. The "same send to the real address passes with a small notice" half of the shot has no script; leave it out or build that transaction by hand.

## Extra L4 shot: "Claim airdrop" wallet sweep

    pnpm scenario:sweep-devnet --serve-only

Select the imported **sweep-user** wallet, open http://localhost:8783, click **Claim airdrop**. The page rebuilds the realistic sweep (per token: create the collector's account, transfer all, close ours; then every lamport but the fee) from the current balances on every click. SignGuard must reject it at once:

- Level **L4 Blocked**, no Sign anyway; the wallet never opens.
- Title: `Blocked: Simulation shows the wallet emptied: 53022680 lamports (all but the 5000 fee, including token account rent) and all 2 token balances go to non-signing destination <collector>.`
- Template title: "The transaction empties the wallet"; advice: "Check the recipient and amounts; a normal purchase rarely moves everything."

Without Kelvara (Ctrl-C first):

    pnpm scenario:sweep-devnet:attack --no-fixture

It leaves the user at 0 SOL with no token accounts, then the collector returns everything to the payer. **Always pass `--no-fixture` for demo takes**: without it the run replaces the committed `l4-sweep` golden fixture in fixtures/tx/devnet/sweep/. After an attack, the next `pnpm scenario:sweep-devnet` archives it and refunds the user to 0.05 SOL.

## Recording notes

- Label shot 1 **"Real mainnet transactions"** and shots 2–6 **"devnet"** on screen.
- No scanner is named in the video. The M6 scanner comparison (Phantom or any other) has not been run or recorded, so we have no observation to cite.
- Reset before every take (section 0). An executed setup cannot be inspected again: a used nonce or a spent buyer gives a different report.
- L3 holds have a fail-closed timer and the engine has a 40 s limit. Click Block within a few seconds of the report appearing.
- Never click Sign anyway on camera, apart from a deliberate unprotected take that you choose to do yourself.
- Keep the terminal free of `.env` contents and key files. The scripts never print the Helius URL with its key, and pages never serve keys.
- Cost per full take on devnet: about 0.01 SOL (see Test record). The payer needs at least 0.05 SOL plus about 2 SOL of float, which is returned after each attack.

## Demo assets (the human captures them)

Put them in `packages/scenarios/demo-assets/` (create it; PNG at 1920×1080 unless noted).

| File | Content |
|---|---|
| `01-drift-replay.png` | Terminal: shot 1 replay output (two transactions), the L3 Critical alert line, the authority.transfer claim and the 136-instruction preview |
| `02-admin-blocked.png` | Ops Portal with the SignGuard L3 report open, Block focused, Solflare not open |
| `03-admin-claim-evidence.png` | The authority.transfer claim expanded with its evidence |
| `04-admin-explorer.png` | Devnet explorer: demo program upgrade authority = attacker after the attack |
| `05-trap-blocked.png` | $SHINY page with the L2 report: simulation line plus the two L2 claims |
| `06-trap-pulled-back.png` | Terminal or explorer: 50,000 SHINY pulled back, account Frozen |
| `07-sweep-blocked.png` | Claim airdrop page with the L4 report, no Sign anyway |
| `08-poison-cli.png` | Terminal: the L4 address.poisoning output with the bracketed matching characters |
| `options-devnet.png` | Options page: network devnet, license valid (Helius key field masked) |
| `demo.mp4` | The 2-minute take (1080p, 30 fps) |

Before committing any screenshot, check that it shows no Helius key, `api-key=` URL, private key or license string.

## Narration

### Story 1: "Q4 fee update" (about 75 s)

"This is a Squads council: three members, two signatures needed, no time lock. A proposal called 'Q4 fee update' is waiting. Member A clicks Approve, the way they have done a hundred times.

Before the wallet even opens, Kelvara holds it. Critical. The approval itself moves nothing: the simulation shows only the five-thousand-lamport fee. That is exactly why a balance preview says it is fine.

Kelvara reads what the proposal does when it executes: setAuthority on the program, so control passes to a key nobody on the council knows. Then the transaction: it starts with a durable nonce, so it never expires and whoever holds the signature can land it whenever they choose. And that nonce was created and funded by an outsider who is not part of this approval. The label says fee update. The instructions say hand over the program. And there is no recovery path: the new authority can deploy any code.

Block. The wallet never opened.

Now without Kelvara. Member A's signed approval, Member B's vote, the attacker executes. On the explorer the program's upgrade authority is now the attacker. Nothing in that approval showed a token moving."

### Story 2: $SHINY (about 60 s)

"A new token launch. Buy: one SOL for fifty thousand SHINY. The simulation is honest: you pay one SOL, you get fifty thousand tokens.

Kelvara holds it at Warning. This is a Token-2022 mint with a permanent delegate: the creator can transfer or burn your balance at any time without asking. And it has a freeze authority: the creator can freeze your account. Neither of those is a balance change, so the simulation cannot show them. The risk is the power, not the amount.

Block.

Without Kelvara: the purchase goes through and the buyer holds fifty thousand SHINY. The creator sends one transaction, signed only by the creator: the tokens leave the buyer's wallet and the account is frozen."

### Close (about 15 s)

"Last one: a 0.5 SOL send to an address from your history. It is the lookalike that dusted you: same first three, same last two characters. Blocked outright. Simulation shows what moves. Kelvara shows what you give away."

## Repeating and verification

- `--reset` (admin, trap) archives the previous outputs, first recycles the old setup's SOL to the payer, and reuses the demo program while its upgrade authority is ours. Sweep archives an executed setup on its own.
- Flags: `--serve-only` serves the last setup without spending SOL; `--no-serve` sets up and exits; `--attack` sets up and attacks immediately; `--attack-only` (the `:attack` scripts) attacks the existing setup; `--recycle` (admin, trap) only cleans up.
- Offline tests: `pnpm --filter @kelvara/scenarios test`. Live devnet tests: `pnpm --filter @kelvara/scenarios test:devnet` (spends devnet SOL, takes no wallet action). Then `pnpm selfcheck --fast`.
- If Squads devnet is unavailable, PLAN.md allows Story 1 on cloned localnet (`pnpm scenario:admin-local`) with an on-screen **localnet** label. That fallback does not satisfy devnet G8.

## Test record

2026-11-07, Helius devnet, worktree team/scenarios after merging main 592bda1, no wallet action:

| Step | Result | Time |
|---|---|---|
| `scenario:admin-devnet --reset --no-serve` | multisig 2 of 3, time lock 0; nonce funded by outsider; proposal "Q4 fee update" Active; approval tx 416 bytes | 20.6 s |
| `scenario:trap-devnet --reset --no-serve` | $SHINY mint with permanent delegate and freeze authority = creator; buy tx 466 bytes | 9.1 s |
| `scenario:sweep-devnet --no-serve` | user funded 0.05 SOL plus 2 tokens; sweep tx 539 bytes | 3.6 s |
| `kelvara analyze --network devnet` on the three outputs | admin L3 Critical (8 claims), trap L2 Warning (5), sweep L4 Blocked (wallet.sweep) | |
| `--serve-only` pages :8781 / :8782 / :8783 | `/` 200 (Ops Portal, $SHINY launch, Claim airdrop), `/transaction` 200 JSON (`solana:devnet`), POST 403 | |
| `scenario:admin-devnet:attack` | upgrade authority = attacker | 10.7 s |
| `scenario:trap-devnet:attack` | buy landed, 50,000 SHINY pulled back, account frozen | 6.5 s |
| `scenario:sweep-devnet:attack` | user at 0 SOL, no token accounts; collector returned everything | 4.8 s |
| `scenario:poison-devnet` + analyze + `:attack` | L4 address.poisoning; 0.5 SOL send executed; funds returned | 5.9 s + 6.2 s |
| `kelvara replay` (Drift pair 2HvM… + 4BKB…, offline) | L3 Critical (11 claims): authority.transfer (updateAdmin to H7Pi…7ZgL), durable_nonce x2, approve_and_execute; 136-instruction preview | |

Payer 4.9104 SOL before, 4.9005 SOL after admin + trap + sweep (**0.0099 SOL** per full take), and 4.9204 SOL after poisoning, because its attack also returned 0.03 SOL left in the friend account by earlier runs. That sweep attack ran before `--no-fixture` existed and replaced the golden fixture; the change was reverted (not committed).

Not tested by an agent (human only): Solflare imports, clicking in the pages with the extension, the L3/L2/L4 report UI on these devnet requests, the explorer views, the license.

## Devnet playground hub — one account for all previews

Open **http://localhost:8780** (also http://127.0.0.1:8780). Enable SignGuard and configure devnet/Helius in its options. Manually import **one** dedicated devnet account from the local file shown at the top of the hub, connect it once through Wallet Standard Phantom/Solflare/Backpack, and all four cards become available together. The canonical account is the existing Squads Member A; trap and sweep transactions now use that same actual signer. GOOD also supports another funded devnet wallet. SignGuard can show a report for GOOD as well; inspect the level rather than expecting silence.

| Preview | Expected level |
| --- | --- |
| Harmless memo | L0 |
| SHINY permanent delegate/freeze trap | L2 |
| Squads upgrade authority hijack | L3 |
| All SOL/token wallet sweep | L4 |

The page calls only `signTransaction` and never submits signed bytes. For BAD previews choose **Block** in SignGuard. Imports and wallet prompts are manual; import files remain on disk and cannot be downloaded from this server. All account/import guidance appears once at the top, with no card-by-card account switching. The live shared account is `J76MW1tikG3C4SyQRcoSytGtnhq6hDjEDRXaCGHGBfD5`; its import file is `/home/andy/orca/workspaces/kelvara-signguard/scenarios/.keys/devnet/member-a.solflare.txt`.

Given existing pre-attack admin, trap and sweep setups, prepare the shared account and serve:

```sh
pnpm --filter @kelvara/scenarios demo:prepare
pnpm demo:serve
```

`demo:prepare` validates the real Member A key against the existing admin approval, tops only that dedicated account up to 1.1 devnet SOL, and creates/funds its two sweep-mint ATAs using the existing payer/mint authority. It never resets the admin proposal or executes an attack, preserves original buyer/sweep keys and balances, and writes separate public metadata to `packages/scenarios/.devnet/playground.json`. Repeating it tops up only missing balances. It cannot fund arbitrary browser-provided wallets. Coordinate exclusive devnet access before running preparation and restart the server after any external scenario mutations.

For a first checkout with no pre-attack scenarios, prepare admin/trap/sweep sequentially under a reservation using their existing setup commands (`--no-serve`, plus `--no-fixture` for sweep). Do not reset a live admin proposal: its shared cleanup can execute an old proposal. Reuse an existing active admin setup instead. No attacks are needed to prepare this hub. Keep the common account funded while testing. Memo/trap/sweep rebuild on a current blockhash per request; trap preserves the seller signature and admin retains its durable nonce.

Live shared-account check (2026-11-08): actual CLI analysis returned L0/L2/L3/L4 with the same Member A signer for every preview. Preparation moved the payer from 3.12362504 to 2.12059236 SOL (1.00303268 SOL including retained account funding and ATA rent/fees). Original funded accounts and fixtures were preserved. The hub binds only 127.0.0.1 and serves exact allowlisted routes: `/`, `/style.css`, `/app.js`, `/api/scenarios`, and validated `/api/transaction?kind=…&account=…`. Host/Origin/fetch-metadata restrictions, canonical address checks, method restrictions and attack-account matching remain enforced.

### Paired “Q4 fee update” proposals (S17)

Keep the existing shared Member A wallet and all four original cases. Prepare a fifth card with `pnpm --filter @kelvara/scenarios demo:prepare-fees`; this creates only an independent Token-2022 mint and a second active proposal in the existing council. Repeat preparation validates/reuses the active proposal; it does not approve or execute either proposal. `node packages/scenarios/scripts/demo-verify-fees.mjs` reads real Helius devnet state, checks both proposals remain Active, and simulates a fresh unsigned fee approval; it writes ignored `.devnet/fees/approval.unsigned.b64` for CLI analysis. Restart the exact owned `demo:serve` process after preparation to load the new card.

Both card titles, approval memo instructions, and Squads approval memo arguments are exactly `Q4 fee update`. The original proposal transfers program upgrade authority to the attacker upon later execution. The legitimate proposal's sole inner instruction is Token-2022 `TransferFeeExtension/SetTransferFee`: the council vault signs as fee-config authority; the mint changes from 25 basis points (0.25%), maximum 1,000,000 base units (1 token), to 75 basis points (0.75%), maximum 2,000,000 base units (2 tokens), with six decimals. Execution schedules the new fee at execution epoch plus two; approval itself changes no fee. The initial older/newer schedules, epochs, fee authorities, withheld amount, and proposed values are preserved in ignored `.devnet/fees/scenario.json`.

ABI and state are hand-encoded from official [instruction source](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/instruction.rs), [fee state source](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/mod.rs), and [processor scheduling](https://github.com/solana-program/token-2022/blob/main/program/src/extension/transfer_fee/processor.rs). No dependency added. This demo retains a 0.5 SOL payer floor. It never submits user-signed bytes, executes the proposals, or changes the original admin nonce.

Initial real devnet setup: mint `G1tkXpJ88NXd7vzjKDbUyJsRvP65czQLN74dcg73U3NG`, proposal `EYkF9NyB28Zq2g8KEiYWGEcQy98f5Z9Y66YHAqbThuJ3`, vault transaction `2UQxNHydgszFLemenEB7zNgLkF5r8ombYtQtGYxdrPKC`, index 2. Rent locked: 6,304,280 lamports; transaction fees: 20,000 lamports; payer after: 2,097,788,080 lamports. Before E20, the actual CLI returns L1 `squads.zero_timelock_execution`; no fabricated expected level or fee question is asserted. E20 fee-candidate verification remains required before declaring the paired intent demonstration complete.
