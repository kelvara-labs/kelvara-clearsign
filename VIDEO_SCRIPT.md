# ClearSign demo video (one video, 2:00, three simulations)

Recorded on the devnet playground at http://localhost:47731 with the shared Member A account
(`J76MW1tikG3C4SyQRcoSytGtnhq6hDjEDRXaCGHGBfD5`, import file shown at the top of the playground). Every
case is a real devnet transaction built fresh per request; nothing is submitted. Label the video
**devnet** on screen. Setup: DEMO.md.

Before recording:
- Extension loaded from `packages/extension/dist` (check the version on `chrome://extensions`), Helius key
  saved, network **Devnet**, your AI provider saved and enabled in Options (for example
  `http://127.0.0.1:20128/v1`).
- Lines marked [X20] need the two-step report (Assessment first, details after "Yes, this is what I
  intended", extension 0.5.0). If you record before it lands, skip those lines.
- Never show a key, an `api-key=` URL or a key file. Never click Sign anyway on a bad case and never
  approve a bad case in the wallet. Do not show the unverified "$285M" Drift figure.
- Rehearse once; keep each report on screen for at least 3 seconds; cut between simulations.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:10 | Title card: "Your wallet shows bytes. ClearSign shows consequences." Cut to the playground, wallet connected, five cards visible. | "Every Solana signature request now goes through ClearSign before your wallet opens." |
| 0:10–0:30 | **Simulation 1: harmless memo (L0).** Click "Preview harmless memo". Calm report, no red box: "No risks found · signs a memo". [X20] Step 2: memo text, network fee, "No authority, delegate, owner or upgrade permission changes", Ledger hash line. Click **Continue to wallet**: only now does the wallet popup appear. Reject it in the wallet. | "Harmless stays calm: a memo, a tiny fee, no permission changes. The wallet opens only when I continue." |
| 0:30–1:15 | **Simulation 2: "Q4 fee update" multisig hijack (L3).** Two-second cut to the two cards with the same title "Q4 fee update" (fees and admin). Click the admin card's "Preview L3 scenario". **L3 · Critical** banner. [X20] Assessment by your AI provider: this approval reaches the threshold and hands program upgrade authority to an outside key; question "Did you intend to transfer upgrade authority?". Click **Yes** briefly to show step 2: "Grants program.upgrade …", the transaction never expires (durable nonce), zero timelock; Sign anyway needs a 2-second hold (do not complete it). Click **Block**. | "Two proposals, same title, same signed memo. One really changes a fee; this one gives an attacker the power to replace the program, and the signature never expires: the pattern of the Drift admin takeover. ClearSign reads the transaction inside the proposal and stops it before the wallet opens." |
| 1:15–1:50 | **Simulation 3: $SHINY token trap (L2).** Click "Preview L2 scenario". Amber **L2 · Warning**. [X20] Assessment: the creator keeps a permanent delegate and a freeze authority over the tokens you buy; question "Did you intend to buy a token whose creator can move or freeze it?". Click **No, reject**. The wallet is never called. | "The buy simulates fine, but this Token-2022 mint lets its creator take or freeze your tokens at any time. ClearSign reads the mint's extensions and explains it in plain words before you buy." |
| 1:50–2:00 | End card: "Calm when safe · clear when not · the wallet opens last." Small line: "Squads · Token-2022 · simulation · AI assessment checked against the facts · Helius". | "ClearSign. Know what you sign." |

Differentiators on screen: wallet held until the user decides; calm L0 versus graded L2/L3; Squads v4
inner-transaction decoding and same-label intent check; capability view ("what you actually authorize");
durable-nonce and timelock rules; Token-2022 extension awareness; AI assessment that cannot change the
level; hold-to-confirm; Ledger hash.

If a shot fails on the day, swap in the **wallet sweep (L4)** card for simulation 3: everything drained,
accounts closed, no Sign anyway button at all.
