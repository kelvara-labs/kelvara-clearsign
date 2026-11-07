# Licenses

Every dependency, its license, and where it is used. Nothing under AGPL, BUSL or MPL in packages/core or packages/extension.

| Package | Version | License | Used in |
|---|---|---|---|
| sol-sign-preview (own, ported code) | 4dd1eb5 | ISC | packages/extension |
| helius-labs/watchtower (ported detector logic, Helius adapters) | to pin at port | MIT | packages/core/rules, packages/core/state, tools/watchtower |
| OpenSubmissionn/Open_DevTool (dev-only CLI, not bundled) | to pin at install | MIT | tools/ |
| typescript | 5.9.3 | Apache-2.0 | dev, all packages |
| vitest | 3.2.7 | MIT | dev, tests |
| esbuild | 0.28.2 | MIT | dev, extension bundle |
| eslint, @eslint/js | 9.39.x | MIT | dev, lint |
| typescript-eslint | 8.72.1 | MIT | dev, lint |
| @types/node | 22.x | MIT | dev, types |
| @sqds/multisig (Squads v4 SDK) | 2.1.4 (to install in M4) | MIT per npm package.json; source repo Squads-Protocol/v4 is AGPL-3.0, so treated as AGPL-tainted | packages/scenarios only (scenario scripts); never packages/core or packages/extension |
| marginfi v2 program binary + on-chain IDL (mainnet dump) | ProgramData slot 465361726, sha256 1c4c84ae… | Apache-2.0 (mrgnlabs/marginfi-v2) | packages/scenarios/programs (localnet demo target only, not shipped) |
