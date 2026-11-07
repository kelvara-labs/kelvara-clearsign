# Needs human

Open asks for the human. Write the exact ask; keep working on unblocked tasks.

## Resolved
- 2026-11-07: Helius key in `.env` (main checkout); mainnet, devnet and Drift history (slot 410344009) verified.
- 2026-11-07: License public key 96kkANgM8egAtbFSa81PHfjNFajQNo77dpTcno2xmM1s in config/license-public-key.txt.

## Open
- Port 127.0.0.1:28538 (wallet-browser CDP) is taken by Docker container `kelvara-wallet-exposure-preview`. If you can, run `docker stop kelvara-wallet-exposure-preview` before the M5 real-wallet check; agents won't stop it. Until then the SolSub check is unverified (moved to M6).
- /home/andy/KELVARA/local-browser-session/launch.sh points at Solflare 2.40.1_0, which is no longer installed (2.41.2_0 and 2.42.0_0 are). Our tools/browser/launch.sh picks the newest; update yours if you use it directly.
- By hour 32: about 5 devnet SOL in .keys/devnet-payer.json.
- PLAN.md (M2, Definition of done) says the report must match "the example API response" (internal), but that JSON is not in the repo or anywhere under ~/MLH Hackaton or ~/KELVARA. If you have it, drop it at docs/example-report.json and the engine will diff its kelvara-report-v1 schema against it. Until then the engine's schema (packages/core/src/report/schema.ts, G4 PASS) is the contract.
- Before recording the demo (M8): issue yourself a license, or the extension shows only the level and top finding. Run `node packages/extension/scripts/issue-license.mjs --key <your license private key, outside the repo> --email <you> --plan pro --days 365` and paste the KSG1.… string into the extension's options page. Agents never run this with the real key.
