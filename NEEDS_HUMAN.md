# Needs human

Open asks for the human. Write the exact ask; keep working on unblocked tasks.

## Resolved
- 2026-11-07: Helius key in `.env` (main checkout); mainnet, devnet and Drift history (slot 410344009) verified.
- 2026-11-07: License public key 96kkANgM8egAtbFSa81PHfjNFajQNo77dpTcno2xmM1s in config/license-public-key.txt.

## Open
- Port 127.0.0.1:28538 (wallet-browser CDP) is taken by Docker container `kelvara-wallet-exposure-preview`. If you can, run `docker stop kelvara-wallet-exposure-preview` before the M5 real-wallet check; agents won't stop it. Until then the SolSub check is unverified (moved to M6).
- /home/andy/KELVARA/local-browser-session/launch.sh points at Solflare 2.40.1_0, which is no longer installed (2.41.2_0 and 2.42.0_0 are). Our tools/browser/launch.sh picks the newest; update yours if you use it directly.
- By hour 32: about 5 devnet SOL in .keys/devnet-payer.json.
