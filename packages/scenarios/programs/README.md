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

Localnet (M4, task S2): `pnpm --filter @kelvara/scenarios localnet:up` loads `marginfi_v2.so` at genesis
(`solana-test-validator --upgradeable-program`) at its mainnet program id with our key
`.keys/localnet/demo-upgrade-authority.json` as upgrade authority. The program must keep its mainnet id: Anchor
checks `declare_id!`, and we do not hold the mainnet program keypair, so `solana program deploy` cannot place it there.

IDL status on localnet: **pinned, unverified**. `localnet:up` tries to publish the IDL through the program's own
Anchor IDL instructions (create / resize / write, built by hand, no Anchor CLI). This binary has none: it answers
`Custom 101` (InstructionFallbackNotFound) to the IDL create instruction (checked 2026-11-07), and the ELF contains no
`Idl*` instruction names. The mainnet IDL account predates that build. So the scenarios use `marginfi_v2.idl.json`
from this folder (copied from the mainnet IDL account, `9tb2tzSk…kmmK`), recorded as `idl.status: "unverified"` in
`.localnet/state.json`. The publish path stays in the script and is used as-is for any program that keeps its IDL
instructions.
