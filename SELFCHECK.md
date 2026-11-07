```
Kelvara selfcheck  2026-11-07T11:00:42Z  commit c263c87
G1  build        PASS     10.8s
G2  decode       PASS     5.9s  98.48%, 1000/1000
G3  rules        PENDING  0.8s  (milestone M2)
G4  contract     PENDING  0.9s  (milestone M2)
G5  registry     PENDING  1.0s  (milestone M3)
G6  localnet     PENDING  0.9s  (milestone M4)
G7  e2e          PENDING  15.5s  (milestone M5) waiting on 2 × report UI not landed, 3 × forge ran only against an immediate block; rerun while the report UI holds the request, 7 × real engine not wired into the extension (stub engine says L2 for everything)
G8  replay       PENDING  1.7s  (milestone M6) waiting on drift replay, scenario:admin-devnet, scenario:trap-devnet
G9  determinism  PENDING  1.1s  (milestone M7)
G10 security     PENDING  1.9s  (milestone M7) waiting on no API key in zip, license key offline [unpacked]
```
