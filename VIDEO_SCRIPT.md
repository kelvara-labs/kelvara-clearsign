# SignGuard video script (2 videos, about 2 minutes each)

Two short videos, three simulations each, recorded on the devnet playground at http://localhost:47731
with the shared Member A account (`J76MW1tikG3C4SyQRcoSytGtnhq6hDjEDRXaCGHGBfD5`, import file shown at the
top of the playground). Every case is a real devnet transaction built fresh per request; nothing is
submitted unless you choose to. Label every shot **devnet** on screen. Follow DEMO.md for setup.

Before recording:
- Extension loaded from `packages/extension/dist` (check the version on `chrome://extensions`), Helius key
  saved, network **Devnet**. For the AI assessment shots, your provider is saved and enabled in Options
  (for example the 9router forward `http://127.0.0.1:20128/v1`).
- The two-step report (Assessment first, details after "Yes, this is what I intended") ships with X20
  (extension 0.5.0). If you record before it lands, skip the lines marked [X20].
- Never show a key, an `api-key=` URL or a key file on screen. Never click Sign anyway on a bad case and
  never approve a bad case in the wallet.
- Do not put the "$285M" Drift figure on screen unless you have checked the public source.

---

## Video 1: "Same label, two different futures" (multisig signer, about 2:00)

Audience: protocol teams and multisig signers. Message: SignGuard reads what a proposal will actually do
when executed, not what its title says.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:12 | Title card: "Two proposals. Same name. Same memo." Then the playground's two **Q4 fee update** cards side by side (fees card and admin card). | "Both proposals in this Squads council are called 'Q4 fee update' and carry the same signed memo. Your wallet would show you almost the same thing for both." |
| 0:12–0:50 | **Simulation 1: the fees card.** Click "Preview fee proposal approval". SignGuard opens before the wallet. [X20] Step 1 shows the Assessment ("Assessment by your AI provider") and the question about the proposed fee change. Click "Yes, this is what I intended". Step 2: the decoded inner instruction "Token-2022 · setTransferFee", 25 → 75 basis points, maximum fee 1 → 2 tokens, labelled as a proposed future effect; the Ledger hash line. Click **Block** (you are demonstrating, not approving). | "SignGuard decodes the vault transaction hidden inside the approval: a real Token-2022 fee change from 0.25 to 0.75 percent. It says clearly that approving is not executing. This one is what the title says." |
| 0:50–1:35 | **Simulation 2: the admin card.** Click "Preview L3 scenario". Red-orange banner **L3 · Critical**. [X20] The Assessment says this approval reaches the threshold and hands program upgrade authority to an outside key; question: "Did you intend to transfer upgrade authority?". Click "No, reject" → blocked, wallet never opened. Re-run once and click "Yes" to show step 2: "What you actually authorize: Grants program.upgrade …", durable nonce (the transaction never expires), zero timelock. Show that Sign anyway needs a 2-second hold; do not complete it. Click Block. | "Same title, same memo, completely different future: this approval gives an attacker the power to replace the program, and the signature never expires. That is the pattern of the Drift admin takeover. SignGuard stops before your wallet even opens." |
| 1:35–1:55 | **Simulation 3 (optional, terminal): real mainnet replay.** `pnpm kelvara replay 2HvMSgDE… 4BKBmAJn…` (DEMO.md shot 1) showing **L3 Critical** with authority.transfer and the durable-nonce claims. Label "real mainnet transactions". | "And this is not a lab trick: on Drift's two real admin transactions SignGuard raises the same critical alert." |
| 1:55–2:00 | End card: "SignGuard · reads what you really sign · Helius-only · open evidence". | — |

Differentiators shown: Squads v4 inner-transaction decoding, capability graph ("what you actually
authorize"), durable-nonce and threshold/timelock rules, same-label intent check, AI assessment that cannot
change the level, hold-to-confirm, wallet held until the decision, real mainnet replay.

---

## Video 2: "Every day, one clear decision" (wallet user, about 2:00)

Audience: everyday Solana users. Message: harmless things stay calm; dangerous things are explained in
plain words and stopped before the wallet opens.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:10 | Title card: "Your wallet shows bytes. SignGuard shows consequences." Playground, wallet connected. | "Every signature request now goes through SignGuard first." |
| 0:10–0:35 | **Simulation 1: GOOD memo (L0).** Click "Preview harmless memo". Calm report, no red box: "No risks found · signs a memo". [X20] No question for routine transactions; step 2 shows the memo text, network fee, "No authority, delegate, owner or upgrade permission changes", the Ledger hash line. Click **Continue to wallet**: only now does the wallet popup appear. Reject in the wallet (no need to submit). | "Harmless stays harmless: a memo, a small fee, no permission changes. Only when I continue does my wallet open." |
| 0:35–1:15 | **Simulation 2: the $SHINY token trap (L2).** Click "Preview L2 scenario". Amber **L2 · Warning**. [X20] Assessment: the token's creator keeps a permanent delegate and a freeze authority, so they can take or freeze your tokens after you buy; question "Did you intend to buy a token whose creator can move or freeze it?". Click "No, reject". Wallet count stays zero. | "The price looks fine and the simulation succeeds. But this Token-2022 mint keeps a permanent delegate and freeze authority: the creator can take your tokens back or lock them. SignGuard reads the mint extensions before you buy." |
| 1:15–1:50 | **Simulation 3: "Claim airdrop" wallet sweep (L4).** Click "Preview L4 scenario". Filled red **L4 · Blocked**: the transaction sends all SOL and both token balances to a collector and closes your token accounts. Step 2 shows the new states (balances to zero, accounts closed). There is no Sign anyway button at all; only Dismiss. | "A 'claim' that empties everything: all SOL, every token, accounts closed. That is never something you sign, so SignGuard does not even offer the option." |
| 1:50–2:00 | End card: "Calm when safe · clear when not · the wallet opens last". Optional quick flash of the Options page (Helius, network, AI provider collapsed) and the toolbar activity list. | "SignGuard. Know what you sign." |

Differentiators shown: wallet held until the user decides (works with Wallet Standard and legacy
wallets), calm L0 versus graded L2/L4, Token-2022 extension awareness, simulation plus resulting states,
hard block with no Sign anyway at L4, Ledger hash for hardware-wallet users, optional AI assessment that is
checked against the facts.

---

## Optional 10-second inserts (use only if time allows)

- **Sign in with Solana:** a sign-in request for a different domain is held and shown as **L3** before the
  wallet opens (X17 message review).
- **Address poisoning:** DEMO.md shot 6 (L4, lookalike address of someone you paid before).

## Shot checklist

1. Fresh browser profile with only SignGuard and the wallet; devnet everywhere.
2. Playground loaded, Member A connected, all five cards enabled.
3. One take per simulation; cut between them. Keep each report on screen for at least 3 seconds.
4. Before publishing, scrub every frame for keys, `api-key=` and key files.
