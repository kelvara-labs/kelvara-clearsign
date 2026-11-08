# Kelvara SignGuard selfcheck — V16 (G7 FAIL: two flaky e2e paths; G1-G6, G8-G10 PASS)

## V16 certification attempt — 2026-11-08, verifier `f237025` (main `ff54b48` merged)

Fresh plain clone `/tmp/kelvara-v16`, frozen install, build, `E2E_WORKERS=1 pnpm selfcheck`: **G1-G6 and G8-G10 PASS, G7 FAIL** (88 passed, 3 failed). Release zip sha256 `7923965228ff2a7c...28eb3` identical x3. `pnpm demo:verify-intent` PASS (read-only, run from the scenarios checkout that holds `.devnet/fees/scenario.json`). Live G8 not run. Localnet stopped.

Unit suites on the clone (vitest --maxWorkers=2, one package at a time): core 279/279, cli 11/11, extension 360/360, scenarios (node --test) 45/45. No red tests.

New specs (test-dapp/e2e): wallet-hold, message-review, options-v16, report-context (origin/network, E22 ComputeBudget, E23/X19 readable report, opacity/filter/transform regression for every `[data-kelvara-action]` button and ancestors at L2/L3/L4). The l4-sweep authorizes assertion now follows X19: the sweep has no capability changes, so the correct text starts with "Sends" and the no-permission line is accurate.

G7 failures (all pass when run in isolation, so they are timing/race dependent, not deterministic logic errors):
1. `levels.spec.ts` L3 admin "Sign anyway needs a hold, then calls the wallet once": one of the ws-register/legacy variants fails with "Sign anyway did not forward" (a different variant per run; reproduced in the clone and in the worktree after the L4 and L3-Block tests ran first, 3 of 4 full-file runs). Suspect: `packages/extension/src/report/page.ts` cancels the hold when the IntersectionObserver v2 gate flickers (`gesture?.cancel()` / `frameTick` `reset()`), or the plain click followed by a hold. Owner: extension.
2. `report-context.spec.ts` l4-sweep (both the E23 text test and the opacity test) intermittently hang 2 min in `click` on the L4 "Dismiss" button (`performing click action`, then timeout) after the report was already auto-rejected. Passes in 2 s when run alone. Owner: extension (L4 Dismiss after auto-reject).
3. `report-iframe.spec.ts` "page-framed report.html gets no channel": poll for `[{allow:true}]` empty after 5 s once (first full run only; not reproduced in two reruns). Owner: extension.
Host was under heavy memory pressure (swap full, ~1 GB free) during all runs, which probably widens the races.

## V15 AI intent certification — 2026-11-08, merged main `bdb906f` + verifier `52c08ae`

**All ten gates PASS** on fresh plain clone `/tmp/kelvara-v15` of team/verifier `52c08ae` (= main `bdb906f` / V14b merge `84f1145` plus the V15 verifier commit): `git clean -xfd`, `pnpm install --frozen-lockfile && pnpm build && pnpm release`, then `E2E_WORKERS=1 pnpm selfcheck`. No live AI provider and no real provider key was used: every provider case ran against the loopback mock `test-dapp/scripts/mock-provider.mjs` with synthetic key strings. X16 (wallet-hold audit) and D1 (UI redesign) are not part of this run; V16 covers them.

| Gate | Result | Seconds |
|---|---|---|
| G1 build | PASS | 25.6 |
| G2 decode | PASS (98.02%, 1000/1000) | 8.6 |
| G3 rules | PASS | 13.6 |
| G4 contract | PASS | 2.6 |
| G5 registry | PASS | 4.9 |
| G6 localnet | PASS | 26.7 |
| G7 e2e | PASS, 47 cases (was 31 + options-tab test; now +15 AI cases) | 374.2 |
| G8 replay | PASS (cached; live not run) | 1.1 |
| G9 determinism | PASS | 3.3 |
| G10 security | PASS | 2.9 |

- Release determinism: three `pnpm release` runs gave identical sha256 `f5e5eae2e379e57d07df3d54c1fc3d65d3d89cedcce68a62cb85aeaf30321bc8` (14 files, 286882 bytes).
- Read-only paired intent proof: `pnpm demo:verify-intent` PASS against the devnet playground state (fees: L1 "approve this proposed future token transfer-fee change", 75 bp, max 2000000; admin: L3 "approve a proposed future transfer of program.upgrade control"). Run in the clone with only public scenario state copied (fees/scenario.json, admin/approval.unsigned.b64) and the key from env; no devnet mutation, no playground restart.
- Live G8 not run (optional).
- Localnet stopped; port 8899 confirmed free.

### Verifier changes in V15
- Provider-sender oracle corrected (not weakened): `options_ui.open_in_tab` makes Chrome set `sender.tab` for the options page, so the old "tab must be undefined" rule was wrong. `provider-sender.test.ts` now ACCEPTS the tab-hosted exact options sender at frameId 0 and REJECTS: same URL with frameId != 0, content-script style senders (tab + https URL), and every earlier foreign id/URL/query/fragment/missing-field case. The options-tab spec passes.
- Provider-policy oracle: Chrome match patterns carry no port, so a granted `scheme://host/*` covers that exact scheme and host on any port; wildcards, other hosts, other schemes and other ports of the request are still rejected (unit-tested).
- New `test-dapp/e2e/intent-ai.spec.ts` (15 cases, one Playwright worker, temp copy of dist with only `http://127.0.0.1/*` added to host_permissions; the release zip and `packages/extension/dist` are unchanged): engine intent card present with source=engine and status=not-configured for l3-admin, l2-trap and l4-sweep; provider saved through the real Options UI, `select-highest` gives source=ai/selected with a question equal to an engine candidate and identical level, buttons, message hashes and claims versus the no-AI run of the same bytes; each of lower-priority, wrong-binding, invented-reason, malformed, refusal, http-500, redirect, slow, oversize falls back to the engine template with the expected invalid/unavailable status, unchanged level/controls, wallet uncalled until Block; request content has only binding/fallbackId/candidates, no transaction bytes or base64, signature-length strings, page URL, signer or key, Authorization only when a synthetic key is configured; a pure System transfer sends no request.
- Finding for the engine owner (not a failure): a transfer carrying a ComputeBudget instruction (what real wallets send) is classed complex by the engine (an "unknown effects" candidate at priority 2 becomes the fallback), so it is sent to the AI provider and its template question reads as unknown effects. The routine-no-request case therefore uses a real mainnet fixture with a lone System transfer.


## V14b re-certification — 2026-11-08, merged main `1481cfa` (team/verifier `08f4cce`) — FAIL (G7)

Fresh plain clone `/tmp/kelvara-v14b`, `git clean -xfd`, `pnpm install --frozen-lockfile && pnpm build && pnpm release`, then `E2E_WORKERS=1 pnpm selfcheck`. No live AI provider key was used; no paid model request was made.

| Gate | Result | Seconds |
|---|---|---|
| G1 build | PASS | 32.2 |
| G2 decode | PASS (98.02%, 1000/1000) | 10.4 |
| G3 rules | PASS | 13.2 |
| G4 contract | PASS | 2.9 |
| G5 registry | PASS | 6.7 |
| G6 localnet | PASS | 27.3 |
| G7 e2e | **FAIL** (31 pass, 1 fail of 32) | 329.2 |
| G8 replay | PASS (cached; live not run) | 1.7 |
| G9 determinism | PASS | 4.4 |
| G10 security | PASS (G10 regression from V14 fixed by `1481cfa`) | 3.9 |

**G7 failure:** `intent-provider.spec.ts: actual Chrome options tab can test saved provider through authenticated service worker`. Clicking Test with no provider saved shows "Provider test did not return a valid selection..." instead of "Save a provider before testing it.". Root cause: the manifest has `options_ui.open_in_tab: true`, so real Chrome sets `sender.tab` on messages from the options page, and `handleProviderTest` (`packages/extension/src/sw/provider-test.ts`) rejects `sender.tab !== undefined`. The handler returns null, no response is sent, and the options Test button can never work in real Chrome. Diagnostic only: removing `|| sender.tab !== undefined` makes this spec pass (1/1); the change was reverted and the release rebuilt from unmodified source. Fix is owned by the extension worker. Keep the content-script check by another means, for example require `sender.url === optionsUrl` and reject frames (`sender.frameId !== 0`).

Release determinism: three `pnpm release` runs produced identical `ddca4b9cc4ede738f1440bdda906d9caa2078458e8fd0fc8a53053604464c12c` (14 files, 286872 bytes).

Skipped: live G8 (optional, not run); read-only paired intent proof (devnet playground on localhost:8780 was down and was not started). Localnet stopped; port 8899 confirmed free.

## V14 intent/provider validation — preparation only

Merged scope baseline `1e24e0a`; implementation and final integration SHA are pending coordinator authorization. V13 below certifies the historical v0.2.1 release only; it does not certify optional remote AI or intent review. No V14 G7/G9/G10 integration verdict, live paired-proposal proof, or paid model usage is claimed.

Verifier preparation adds an independent exact-origin/provider-permission oracle, optional-capability versus installed-grant checks, seeded provider-key leakage checks, and browser assertions for all three collapsed fields and a never-prefilled password field. Foreign hosts, changed endpoints, wildcard actual grants, and redirects are rejected by the oracle; unrecognized dynamic hosts remain G10 failures. Current targeted self-tests and spec typecheck/lint are preparation evidence, not provider implementation evidence. Full G7 awaits merged implementation and one browser worker; live paired devnet evidence additionally requires explicit reservation.

## V13 final certification — 2026-11-08, main `a22a51c`

**All ten gates PASS on a fresh plain `git clone` of main `a22a51c4fddb0d8388826e531c0ea230d00f5b94`.** Live G8 also PASSes on the same clone, and two `pnpm release` builds are byte-identical. This supersedes the V12b partial run and the V11 MVP certification below, which are kept as history. `a22a51c` differs from `8f894c9` (V12b) only by the V12b verifier report merge and the coordinator log; the extension and engine sources are the same.

Checkout: `git clone '<main checkout>' <scratch>/v13 && git checkout a22a51c && git clean -xfd`. `.env` and the devnet payer are found through the clone's local-path origin; nothing was copied or printed. `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm release` all exit 0. Run started `2026-11-08T02:00:39Z`, `dirty: false`; git status was empty before and after every run. Playwright used 1 worker. The devnet playground on :8780 stayed up throughout and was not reset. Localnet was stopped after the runs (`localnet:down`, 8899 free).

| Gate | Status | Seconds | Evidence |
|---|---|---:|---|
| G1 build / typecheck / lint | PASS | 21.7 | Build, typecheck and lint exit 0 |
| G2 decode | PASS | 7.6 | 98.02% named; malformed inputs 1000/1000 |
| G3 rules | PASS | 9.5 | Rule suite exit 0 |
| G4 contract | PASS | 2.2 | Contract suite exit 0 |
| G5 registry, cached | PASS | 4.1 | Registry suite exit 0 |
| G6 localnet | PASS | 25.0 | Real CLI levels/claims, then both attacks and on-chain outcomes |
| G7 browser e2e | PASS | 237.0 | **29 passed / 0 failed / 0 skipped** (3.5 m, headless, 1 worker) |
| G8 replay, cached | PASS | 1.0 | Drift fixtures 2HvMSgDE + 4BKBmAJn ok, drift critical; devnet scenarios skipped in cached mode |
| G8 replay, **live** | PASS | 48.1 | Drift critical (live Helius); admin-devnet 1/1 (32 s), trap-devnet 1/1 (14 s) |
| G9 determinism | PASS | 2.6 | Determinism suite exit 0 |
| G10 security | PASS | 2.3 | passThrough locked, hosts ok, no eval, min perms, offline content scripts, no page control, no key in zip or dist, licenses ok |

Full run total: 313 s wall clock (`E2E_WORKERS=1 pnpm selfcheck`, exit 0).

Live G8 devnet spend: payer 2.120592 → 2.104112 devnet SOL (**0.016480 SOL**: admin 0.013896, trap 0.002584), funds recycled from scenario accounts. No wallet GUI or human signing prompt was used.

Evidence: [full run summary](tools/selfcheck/evidence/v13/a22a51c-full.json), [live G8 summary](tools/selfcheck/evidence/v13/a22a51c-live-g8.json), [G7 case list](tools/selfcheck/evidence/v13/a22a51c-g7.txt). No log contains an API key.

### Release

`dist/kelvara-signguard.zip` from `pnpm release` on `a22a51c`: **14 files, 254307 bytes** (1718162 bytes unpacked), extension v0.2.1. Built three times (once after `pnpm build`, twice more after the gate runs), every time with the same SHA-256, which also matches V12b:

```text
4894a87806ae0fb3b2324ce84647091607362a9bf9e13e685bd6a8c54e0ae4b4
```

### Commands

```sh
git clone '<main checkout>' <scratch>/v13
cd <scratch>/v13
git checkout a22a51c && git clean -xfd
pnpm install --frozen-lockfile && pnpm build && pnpm release
E2E_WORKERS=1 pnpm selfcheck
pnpm selfcheck --only G8 --live
pnpm release && sha256sum dist/kelvara-signguard.zip
pnpm release && sha256sum dist/kelvara-signguard.zip
pnpm --filter @kelvara/scenarios localnet:down
```

### Limits

Human-only demo steps (Solflare prompts, devnet browser recording, explorer views) are not certified here; the G7 test wallet is not Solflare. Live G5 was not re-run (cached G5 passed; its last live PASS is E19 on `7b00cbd`, below). Helius availability and chain state may change after these runs.

---

## History: V12b — 2026-11-08, main `8f894c9`

**G7 PASS 29/29 and G10 PASS on a fresh detached checkout of main `8f894c9686e6d5410012b96f1c437a8d48186d0d`** (X12 extension v0.2.1 merged as `9025acd` + V12 always-show G7 cases merged as `8d6f249`). Fast gates G1-G4 also PASS on the same tree. G5, G6, G8 and G9 were not re-run for this change; their last results are the MVP certification below.

Checkout: `git -C <main checkout> worktree add --detach <scratch>/wt 8f894c9` (finds `.env` in place; nothing copied or printed). `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm release` all exit 0; git status empty before and after the runs. Playwright used 1 worker. Devnet was not touched; the devnet playground on :8780 stayed up throughout. Localnet was stopped after G7 (`localnet:down`).

| Gate | Status | Seconds | Evidence |
|---|---|---:|---|
| G1 build / typecheck / lint | PASS | 23.3 | `pnpm selfcheck --fast` |
| G2 decode | PASS | 8.1 | 98.02% named; malformed inputs 1000/1000 |
| G3 rules | PASS | 9.9 | Rule suite exit 0 |
| G4 contract | PASS | 2.3 | Contract suite exit 0 |
| G7 browser e2e | PASS | 252.4 | `pnpm selfcheck --only G7`: **29 passed / 0 failed / 0 skipped** in 3.7 m, headless; selfcheck unit tests 8/8 |
| G10 security | PASS | 2.4 | `pnpm selfcheck --only G10`: unit tests 22/22; 14 checks PASS on zip and unpacked dist |

Evidence: [G7 case list](tools/selfcheck/evidence/v12b/8f894c9-g7.txt), [G10 checks](tools/selfcheck/evidence/v12b/8f894c9-g10.txt).

### What changed since the MVP certification

- **Always-show policy (X12, v0.2.1).** Every transaction, L0 and L1 included, is held and gets the full report modal. G7 grew from 25 to 29 cases. Benign transfers (ws-app-ready, legacy) and v1 message-first Kamino requests (ws-app-ready, legacy) are each tested twice: once through **Continue** (`[data-kelvara-action=continue]`, "Continue to wallet") and once through **Block**. The test wallet is never called before an explicit trusted Continue; a synthetic `HTMLButtonElement.click()` on Continue (an untrusted event) is asserted not to forward, then a real click forwards once with identical bytes. Block leaves the wallet uncalled. L4 sweeps (both shapes) are still rejected at once with no Sign anyway; L3 admin still defaults to Block with hold-to-confirm Sign anyway; L2 trap is held with both buttons; forged approvals, the 90 s fail-closed timeout, UI-removal fail-closed, page-framed report isolation and all hook paths still pass.
- **Product license removed.** The user removed the license gate, so G10 no longer checks for an embedded offline license public key. The dependency-license audit is kept: **77 packages, 6 direct, none AGPL/BUSL/MPL**.
- **G10 numbers on v0.2.1:** only Helius and localhost reach **41 network sinks** (was 34; the larger UI adds sinks, all allowed hosts), **11 audited inert-string occurrences**, permissions `[storage]` + 4 hosts, 2 offline content scripts that never touch storage, no `externally_connectable` or external listeners, no eval/remote code, passThrough read only by `sw/settings.ts` and `sw/policy.ts` and never written, no API key in zip or unpacked dist.

### Release

`dist/kelvara-signguard.zip` from `pnpm release` on `8f894c9`: **14 files, 254307 bytes** (1718162 bytes unpacked), extension v0.2.1, SHA-256:

```text
4894a87806ae0fb3b2324ce84647091607362a9bf9e13e685bd6a8c54e0ae4b4
```

Release determinism (two builds byte-identical) was not re-checked in this run.

### Commands

```sh
git -C '<main checkout>' worktree add --detach <scratch>/wt 8f894c9
cd <scratch>/wt
pnpm install --frozen-lockfile && pnpm build && pnpm release
pnpm selfcheck --fast
pnpm selfcheck --only G7
pnpm selfcheck --only G10
pnpm --filter @kelvara/scenarios localnet:down
```

---

## History: M8 / V11 MVP certification — 2026-11-07 (extension v0.1.0, license-gated)

**All ten gates PASS on a fresh plain clone of main `7c57a6a8da3e80b6bf16191437dac1748270b09f`.** Live G8 also PASSes on that commit. Live G5 initially FAILed there; E19 fixes its clean-clone credential lookup, and live G5 PASSes on fresh clean main `7b00cbde953f5812a4af034576e25b0a16774cdf`. S14 follow-up checks PASS on main `1fb6ae116bde5d8f5ffdcdad66bfc07802b397c4`.

These are separate, precisely scoped runs: the full ten-gate run was not repeated on either follow-up commit. E19 changes the IDL chain key loader and its regression test; S14 changes only scenario `--verify` preflight/diagnostics and tests, leaving browser `--serve` behavior and extension/engine runtime unchanged. The coordinator authorized these scoped follow-ups. No gate is PENDING, no failing test was skipped or weakened, and the original failures remain below.

### Clean-clone scoreboard

Full run started `2026-11-07T22:33:08Z`, detached HEAD `7c57a6a`, `dirty: false`, clone `/tmp/kelvara-v11-release`. Frozen install, build and release succeeded; git status was empty before and after the run. Playwright used one worker, with one browser context at a time. Secrets and the devnet payer were resolved in place through the local origin; neither was copied into a clone or printed.

| Gate | Status | Seconds | Evidence |
|---|---|---:|---|
| G1 build / typecheck / lint | PASS | 32.8 | All three root commands exit 0 |
| G2 decode | PASS | 11.4 | 98.02% named; malformed inputs 1000/1000 |
| G3 rules | PASS | 14.5 | Rule suite exit 0 |
| G4 contract | PASS | 3.6 | Contract suite exit 0 |
| G5 registry, cached | PASS | 6.7 | Registry suite exit 0 |
| G6 localnet | PASS | 27.2 | Real CLI levels/claims, then both attacks and on-chain outcomes |
| G7 browser e2e | PASS | 223.7 | 25 PASS / 0 FAIL / 0 PENDING, headless |
| G8 replay, cached | PASS | 1.7 | Drift pair critical; devnet scenarios explicitly skipped in cached mode |
| G9 determinism | PASS | 4.6 | Determinism suite exit 0 |
| G10 security | PASS | 4.4 | Release zip and unpacked extension both checked |

Machine-readable evidence: [full run](tools/selfcheck/evidence/v11/7c57a6a-full.json), [original live run](tools/selfcheck/evidence/v11/7c57a6a-live.json), [fixed live G5](tools/selfcheck/evidence/v11/7b00cbd-live-g5.json).

G7 includes all hook paths, forged approvals, the 90-second fail-closed timeout, page-framed report isolation, L3 default Block and hold-to-confirm forwarding, L2 trap, benign forwarding, and both L4 sweep shapes. The realistic ATA create + close sweep is now a default case. Both Wallet Standard app-ready and legacy v1 message-first Kamino requests reach the engine at L0 and call the test wallet exactly once with identical bytes; capture logs prove a numeric engine level rather than a pre-analysis bypass.

G10 reports 34 network sinks and 11 audited inert-string occurrences per bundle; all eight remaining inert-host entries occur, with no unused entries. The four obsolete zod entries were pruned. It also checks locked passThrough, no eval/remote code, storage-only permissions, allowed hosts, offline content scripts, no page control, embedded offline license public key, no API key in zip/dist, and dependency licenses (77 packages, six direct).

### Commands and live results

```sh
git clone '/home/andy/MLH Hackaton/kelvara-signguard' /tmp/kelvara-v11-release
cd /tmp/kelvara-v11-release
git checkout 7c57a6a8da3e80b6bf16191437dac1748270b09f
pnpm install --frozen-lockfile
pnpm build
pnpm release
E2E_WORKERS=1 pnpm selfcheck
# Save logs/summary before the next command overwrites them.
pnpm selfcheck --only G5,G8 --live
pnpm release
sha256sum dist/kelvara-signguard.zip
pnpm scenario:e2e-cases --with-ata-sweep --verify
```

Live G8 PASS, **48.2 s**: real Helius mainnet Drift replay remains critical with the required durable-nonce, approve-and-execute and UpdateAdmin claims; admin-devnet passes 1/1 in 32 s, trap-devnet 1/1 in 14 s. Both execute headlessly with on-chain assertions and recycle funds; payer 4.893173 → 4.876693 devnet SOL (0.016480 SOL spent). No wallet GUI or human signing prompt was used.

**Original live G5 FAIL, 7.4 s, preserved:** `pnpm selfcheck --only G5,G8 --live` on `7c57a6a`: `Error: ENOENT: no such file or directory, open '/tmp/kelvara-v11-release/.env'`, at `packages/idls/src/chain.ts:48` (`heliusMainnetUrl`). Reported to coordinator for engine ownership; direct cross-worker routing was rejected by Orca, so coordinator assigned E19. The loader unconditionally read the clone's common-dir `.env`.

**Scoped resolution:** E19 `e925af5`, merged main `7b00cbd`, supports environment/common-dir/local-origin lookup without copying credentials. In fresh plain clone `/tmp/kelvara-v11-g5-fixed`, frozen install succeeds and `pnpm selfcheck --only G5 --live` PASSes **9.4 s**, started `2026-11-07T22:43:48Z`, `dirty: false`. Additional `pnpm --filter @kelvara/idls exec vitest run test/chain-key.test.ts` PASSes 1/1; `pnpm --filter @kelvara/idls build` (tsc --noEmit) and eslint on both changed files PASS. Git status remains empty. This fix result supplements, and does not erase, the original FAIL.

### Release and mutations

`dist/kelvara-signguard.zip`: **7 files, 238454 bytes**, built twice with `pnpm release` on `7c57a6a`, byte-identical SHA-256:

```text
4aa7bcd359e3105fc991a66c65a231fa97d152ed588a603e2af2e2a675b39b10
```

Both release invocations exit 0. The follow-up changes do not affect extension inputs. G10 checks the actual zip as well as unpacked files; the hash remains unchanged after mutation restoration.

| Mutation on the tested tree | Command | Required rejection observed |
|---|---|---|
| Rename `nonce.staged_by_outsider` to `mutant.staged_by_outsider` in bundled CLI only | `pnpm selfcheck --only G6` | FAIL, exit 1, 25.8 s: `missing claim nonce.staged_by_outsider` |
| Inject foreign fetch + WebSocket into service worker via existing runtime mutation hook | `KELVARA_E2E_NET_MUTANT=1 E2E_WORKERS=1 node tools/selfcheck/src/e2e.mjs v1-wire.spec.ts` | FAIL, exit 1, both cases reject `sw GET https://evil.invalid/mutant` and `sw WebSocket wss://evil.invalid/mutant` |
| Append `eval("1")` to unpacked service-worker.js | `pnpm selfcheck --only G10` | FAIL, exit 1, 5.2 s: `no eval/remote code [unpacked]: eval( in service-worker.js` |

The CLI and worker bundle were restored byte-for-byte in finally blocks. Runtime mutation was confined to the test process; no source or golden fixture was changed. Git status is clean in the verification clone. Localnet was explicitly stopped after the mutation checks and again after S14 checks.

### Saved-case failure and S14 diagnostics

**Original supplemental failure retained:** after the full run and live G8, `pnpm scenario:e2e-cases --no-setup --with-ata-sweep --verify` on `7c57a6a` reported admin L3 correctly but trap **L1 instead of L2**, sweep and ATA sweep **L1 instead of L4**. This was not a G7 failure: G7 used fresh served bytes and passed all 25 cases. The old wrapper recorded only levels/ruleIds, not simulation diagnostics; subsequent fresh setup overwrote the original wires before they were preserved. Therefore original blockhash expiry is **unconfirmed**, and a fresh PASS alone does not resolve the original diagnosis.

The correct fresh command, `pnpm scenario:e2e-cases --with-ata-sweep --verify`, PASSed all four expected levels on `7c57a6a`. Scenarios diagnosed that a failed exact-message fee lookup can drop inventory enrichment even when independent simulation retries, explaining a possible loss of trap/sweep facts. S14 `5b07a74`, merged main `1fb6ae1`, adds exact saved-blockhash validity and non-replacing simulation preflight; failures retain public input, RPC diagnostics and CLI output under `.localnet/verify-failures`. It does not change engine rules or expected levels.

On a clean checkout of `1fb6ae1` in the original verification clone:

- Fresh `pnpm scenario:e2e-cases --with-ata-sweep --verify` PASSes L3 admin / L2 trap / L4 sweep / L4 ATA sweep.
- `node --test packages/scenarios/test/e2e-cases.test.mjs` PASSes 5/5.
- A real generated ATA sweep was cloned **in memory**, its wire blockhash changed to zero and its matching metadata marked invalid, then passed to `verify`. It rejects `STALE saved blockhash is no longer valid`, saves the exact public mutated input plus `diagnostics.blockhash.value=false`, and leaves the saved-case file byte-identical. This is a mutation test, not a fabricated fixture or evidence of the original failure's cause.
- Validator stopped; tracked/untracked git status clean.

### Demo coverage, residual risks and limitations

The automated portions of the two DEMO.md stories are exercised by G6 and live G8: Drift replay, admin upgrade-authority takeover, and trap purchase/delegate pullback/freeze. DEMO.md also contains the scenarios owner's dated S8 test record for serve-only pages, sweep and poisoning. This verification did not repeat those human demo steps: Solflare imports/prompts, devnet browser recording, explorer views and a human-issued license remain human-only and are not certified here. The localnet browser test wallet is not Solflare.

Cached G8 intentionally skips devnet execution; its separate live PASS closes that requirement. Helius availability and chain state may change after the recorded runs. Decode coverage is 98.02%, not universal instruction or protocol coverage; offline/cached evidence and bounded address-history searches retain their stated limits. Host-sink analysis is name-based and may over-report; runtime network checks supplement it. Original stale-case root cause remains unconfirmed; S14 now rejects and preserves such inputs instead of silently interpreting their lower level as a valid scenario result.

Detailed redacted logs and original summaries are retained locally at `/tmp/kelvara-v11-evidence/`; selected summaries are committed beside this report. No credentials, private keys or copied env files are included. The final report/progress commit changes verifier-owned paths only.
