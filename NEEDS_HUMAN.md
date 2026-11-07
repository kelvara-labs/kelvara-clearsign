# Needs human

Open asks for the human. Write the exact ask; keep working on unblocked tasks.

## Resolved
- 2026-11-07: Devnet payer refill no longer needed: S11 recycled 4.1 SOL stranded in trap-seller back to the payer (4.91 SOL); a live G8 run now costs ~0.01 SOL.
- 2026-11-07: Helius key in `.env` (main checkout); mainnet, devnet and Drift history (slot 410344009) verified.
- 2026-11-07: License public key 96kkANgM8egAtbFSa81PHfjNFajQNo77dpTcno2xmM1s in config/license-public-key.txt.

## Open
- Port 127.0.0.1:28538 (wallet-browser CDP) is taken by Docker container `kelvara-wallet-exposure-preview`. If you can, run `docker stop kelvara-wallet-exposure-preview` before the M5 real-wallet check; agents won't stop it. Until then the SolSub check is unverified (moved to M6).
- /home/andy/KELVARA/local-browser-session/launch.sh points at Solflare 2.40.1_0, which is no longer installed (2.41.2_0 and 2.42.0_0 are). Our tools/browser/launch.sh picks the newest; update yours if you use it directly.
- PLAN.md (M2, Definition of done) says the report must match "the example API response" (internal), but that JSON is not in the repo or anywhere under ~/MLH Hackaton or ~/KELVARA. If you have it, drop it at docs/example-report.json and the engine will diff its kelvara-report-v1 schema against it. Until then the engine's schema (packages/core/src/report/schema.ts, G4 PASS) is the contract.
- Before recording the demo (M8): issue yourself a license, or the extension shows only the level and top finding. Run `node packages/extension/scripts/issue-license.mjs --key <your license private key, outside the repo> --email <you> --plan pro --days 365` and paste the KSG1.… string into the extension's options page. Agents never run this with the real key.
- Demo takes (G8 human part), now unblocked (G7 PASS): follow DEMO.md end to end. Import member-a / trap-user / sweep-user exports (.keys/devnet/*.solflare.txt, created by the --reset runs) into Solflare on devnet, record the takes and the 10 assets DEMO.md lists into packages/scenarios/demo-assets/, then tell the coordinator the paths. Never click Sign anyway; devnet keys only.
- PLAN's hook line uses "$285M" for Drift. It comes from PLAN, not from our tools: check the public source before using it on screen, or drop the number.
