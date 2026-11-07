# Demo program (upgrade target): marginfi v2

Picked in M0 (task S0). Used only on localnet as the program whose upgrade
authority the admin scenario hands to a Squads vault and then tries to steal.

| | |
|---|---|
| Program | marginfi v2, `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` (mainnet) |
| Source | github.com/mrgnlabs/marginfi-v2, Apache-2.0 |
| Framework | Anchor; IDL spec 0.1.0, metadata version 0.1.8 |
| On-chain IDL | `9tb2tzSkQqDng2h8dC2xbuKHfQpmPoZP4vnd5Y1rkmmK` (anchor:idl account, 58,890 bytes) |
| Mainnet ProgramData | `4Q8u2ny8YYgytJEncwZQfVWbd5axZtfgDxYKHehvPQR7`, last deployed slot 465361726 |
| Dumped | 2026-11-07 via Helius mainnet RPC |

Files
- `marginfi_v2.so`: `solana program dump MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` (10,485,715 bytes,
  sha256 ff993886…3c19), trimmed to the ELF end (section-header table end, 3,868,320 bytes; the rest was
  zero padding of the 10 MiB ProgramData account). sha256
  `1c4c84aecab95f48db04577f345b76bdfb9712a15f2466a5b183aaf08eecb1ed`.
- `marginfi_v2.idl.json`: the on-chain IDL account, zlib-inflated and pretty-printed (content unchanged).
  sha256 `00f776e5e571b1d513fe99873edecdcff96455cf0fc0b04f7e239925fb2b7146`.

Deploying on localnet without Anchor: either
`solana-test-validator --upgradeable-program <PROGRAM_ID> marginfi_v2.so <UPGRADE_AUTHORITY>`
(no write transactions; checked in M0: `solana program show` reports our authority and
Data Length 3868320), or `solana program deploy` under our keys. The IDL is then published
from the scenario script (anchor:idl account), else pinned from this file and labelled unverified.
