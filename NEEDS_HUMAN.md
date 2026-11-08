# Needs human

Open asks for the human. Write the exact ask; keep working on unblocked tasks.

## Resolved
- 2026-11-08: License requirement removed by the user (full reports for everyone); the earlier license paste step is obsolete.
- 2026-11-07: Devnet payer refill no longer needed: S11 recycled 4.1 SOL stranded in trap-seller back to the payer (4.91 SOL); a live G8 run now costs ~0.01 SOL.
- 2026-11-07: Helius key in `.env` (main checkout); mainnet, devnet and Drift history (slot 410344009) verified.
- 2026-11-07: License public key BQ6k3Z57n1TEVENpRBbe3VgTMj4XdfsKREMJaJTZvoiF in config/license-public-key.txt (rotated 2026-11-08 at user request; dedicated signing key stored outside repo).

## Open
- Port 127.0.0.1:28538 (wallet-browser CDP) is taken by Docker container `kelvara-wallet-exposure-preview`. If you can, run `docker stop kelvara-wallet-exposure-preview` before the M5 real-wallet check; agents won't stop it. Until then the SolSub check is unverified (moved to M6).
- /home/andy/KELVARA/local-browser-session/launch.sh points at Solflare 2.40.1_0, which is no longer installed (2.41.2_0 and 2.42.0_0 are). Our tools/browser/launch.sh picks the newest; update yours if you use it directly.
- PLAN.md (M2, Definition of done) says the report must match "the example API response" (internal), but that JSON is not in the repo or anywhere under ~/MLH Hackaton or ~/KELVARA. If you have it, drop it at docs/example-report.json and the engine will diff its kelvara-report-v1 schema against it. Until then the engine's schema (packages/core/src/report/schema.ts, G4 PASS) is the contract.
- Demo takes (G8 human part): all ten gates PASS on main (v0.2.1). Load packages/extension/dist (or dist/kelvara-signguard.zip), set the Helius key and network devnet on the Options page, import the one shared Member A account from the scenarios worktree (.keys/devnet/member-a.solflare.txt) into your wallet, open the playground at http://localhost:8780 and follow DEMO.md. Every case shows the full report; harmless ones need Continue to wallet; Block the bad ones. Never click Sign anyway; devnet keys only. Send the coordinator the paths of the takes and assets.
- PLAN's hook line uses "$285M" for Drift. It comes from PLAN, not from our tools: check the public source before using it on screen, or drop the number.

## Optional AI provider (2026-11-08)
- Expand Optional AI provider in extension Options to configure API URL, key and model, then enable, Save provider and Test saved provider. All three fields start collapsed and saved keys are never displayed. No real provider key exists in this repo/environment, so live paid-model usage is not yet demonstrated; engine templates continue without a provider. Do not paste provider keys into chat or commit them.
