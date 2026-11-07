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
| @solana/kit (and its @solana/* packages) | 8.5.0 | MIT | packages/core (ingest) |
| @sqds/multisig (Squads v4 SDK) | 2.1.4 (to install in M4) | MIT per npm package.json; source repo Squads-Protocol/v4 is AGPL-3.0, so treated as AGPL-tainted | packages/scenarios only (scenario scripts); never packages/core or packages/extension |
| marginfi v2 program binary + on-chain IDL (mainnet dump) | ProgramData slot 465361726, sha256 1c4c84ae… | Apache-2.0 (mrgnlabs/marginfi-v2) | packages/scenarios/programs (localnet demo target only, not shipped) |
| @codama/dynamic-parsers (+ @codama/dynamic-codecs 1.3.0, @codama/errors, @codama/visitors-core) | 1.4.2 (codecs 1.3.0, others 1.11.0) | MIT | packages/core (decode) |
| @codama/nodes | 1.11.0 | MIT | packages/core (types), packages/idls (build) |
| zod | 4.6.7 | MIT | packages/core (report schema) |
| @codama/nodes-from-anchor (+ @codama/visitors) | 1.5.6 | MIT | packages/idls (build-time IDL conversion, dev only) |
| System Codama root (solana-program/system idl.json) | e9cb0513 (js@v0.16.0) | Apache-2.0 | packages/idls (raw + roots) |
| SPL Token Codama root (solana-program/token idl.json) | 31646dce (js@v0.18.0) | Apache-2.0 | packages/idls (raw + roots) |
| Token-2022 Codama root (solana-program/token-2022 idl.json) | e6b4af36 (js@v0.20.0) | Apache-2.0 | packages/idls (raw + roots) |
| Drift v2 IDL (on-chain anchor:idl account, v2.150.0) | see packages/idls/manifest.json | Apache-2.0 (drift-labs/protocol-v2) | packages/idls (raw + roots) |
| Squads v4 IDL (on-chain anchor:idl account, v2.0.0) | see packages/idls/manifest.json | interface data published on-chain by Squads; source repo AGPL-3.0. Only the IDL is used (PLAN.md Risks: decode Squads from its IDL); no Squads code | packages/idls (raw + roots) |
