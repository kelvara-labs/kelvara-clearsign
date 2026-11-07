# V4 G8 replay: Drift critical (cached and live), both devnet scenario scripts pass live

**G8 replay: PASS** in both modes. Cached on a fresh clone of `main` e249d4d (E14 + S6 merged) and on `team/verifier` b3d604c. **Live (`--live`)** on a fresh detached worktree of b3d604c (main e249d4d + this runner change; `pnpm install --frozen-lockfile && pnpm build` exit 0): Drift replay over Helius mainnet plus both devnet scenarios executed on chain.

```text
e249d4d fresh clone   pnpm test:replay              G8 PASS  1.1s   drift critical (cached), admin-devnet SKIP, trap-devnet SKIP
b3d604c fresh wt      KELVARA_LIVE=1 replay.mjs     G8 PASS  42.5s  drift critical (live), admin-devnet ok (live) 29s, trap-devnet ok (live) 11s
team/verifier         pnpm selfcheck --only G8      G8 PASS  2.1s   (cached)
team/verifier         pnpm selfcheck --fast         G1 PASS 34.9s | G2 PASS 9.3s 97.91%, 1000/1000 | G3 PASS 8.1s | G4 PASS 2.8s
```

Drift session (2HvMSgDE… + 4BKBmAJn…): top-level `level: critical`, `report.alert` L3 Critical `hold_block_default`, alert raised by c1 `authority.transfer` ("Proposed updateAdmin protocol.admin on 5zpq…xcsN … gives authority to H7Pi…7ZgL"), c2/c3 `lifetime.durable_nonce` (AdvanceNonceAccount in both txs), c6 `squads.approve_and_execute`. Replaying 4BKBmAJn… alone gives `warning` with no updateAdmin claim: the vault message is created in 2HvMSgDE…, so G8 needs the whole session (as specified).

Devnet (live, real Squads v4 devnet program, Helius only): admin approval landed on the outsider-funded durable nonce `NrCU88HG…`, executed `5Zfjds1E…`, demo program ADdN9mvE… upgrade authority now the attacker 9xEax7K4…. Trap buy `2e3M15Yj…` gave the user 50,000 SHINY, creator pulled it back with the permanent delegate and froze the account in `Pgmkj2x7…`. Cross-check outside the gate: `kelvara analyze --network devnet` on the setups' bytes gives admin **critical** (authority.transfer, lifetime.durable_nonce, nonce.staged_by_outsider) and trap **warning / hold** (token2022.permanent_delegate, token.freeze_authority), matching G6.

## Runner changes (tools/selfcheck)

- Live devnet step was broken for the merged S6 scripts: running `scenario:<x>-devnet` without flags serves the attacker page forever (or refuses with "scenario already exists"). G8 now runs each scenario headless through the scenarios owner's own live test, `node --test --test-name-pattern=^<kind>-devnet: e2e-devnet/demo-devnet.test.mjs` (`--reset --attack` plus on-chain assertions), and passes only when exactly one test ran and passed.
- Drift check hardened: when the report has `alert`, its label must be Critical and each required claim must be among `alert.claimIds`.
- Self-tests 41/41. Mutants on the real Drift report all FAIL: authority.transfer renamed (missing UpdateAdmin), c6 dropped from alert.claimIds (not among alert.claimIds), level high (need critical).

## Decision: SKIP in cached mode

Cached G8 reports the devnet scenarios as SKIP and still PASSes. Devnet scenarios have no cached form (they need live RPC, keys and devnet SOL), and PLAN.md requires both modes only at M8 ("G5 and G8 use cached real fixtures by default and live RPC with --live. Both modes must pass at M8"). So a cached SKIP is acceptable for routine G8 runs. **M6/G8 is certified here on the live run above, where both scripts PASS**, not on SKIP.

## Findings

- Devnet payer `32HLHCJx…` went from 1.227 to **0.205 devnet SOL** in this one live run: each trap run tops the buyer up to 1.1 SOL and the 1 SOL purchase goes to the scenario's seller (`trap-seller` holds ~4 SOL, never recycled). The next live G8 (required at M8) will stop with `NEEDS_HUMAN: devnet payer needs more devnet SOL` unless scenarios recycle seller SOL to the payer or the human funds it. Owner: scenarios / coordinator.
- No Helius key in the live log (0 matches for an unredacted `api-key=`); `--live` wrote no new fixtures (`git status` clean in the live worktree).

# V9 hour-24 checkpoint: G6 on main 5800793, then G3 + G6 on main 1bcd75d

**G6 localnet: PASS** on a fresh checkout of `main` 5800793 (2 runs + 1 post-mutant run) and on a fresh checkout of `main` 1bcd75d (E10 merged). **G3 rules: PASS** on 1bcd75d (was PENDING). G1, G2, G4 PASS on both. Both mutants FAIL as required.

Fresh detached worktrees in the verifier scratchpad, `pnpm install --frozen-lockfile && pnpm build` (both exit 0). Localnet keys and `.localnet/state.json` copied from the scenarios worktree (gitignored; `git status` clean before every run).

```text
main 5800793 (clean)
pnpm selfcheck --only G6   2026-11-07T16:50:54Z  G6  localnet  PASS  25.3s   (cold: no validator, fresh `localnet up`)
pnpm selfcheck --only G6   2026-11-07T16:51:24Z  G6  localnet  PASS  26.5s   (warm: post-attack localnet, runner reset it)
pnpm selfcheck --fast      2026-11-07T16:51:51Z  G1 PASS 22.6s | G2 PASS 8.7s 97.91%, 1000/1000 | G3 PENDING 11.4s (M2) | G4 PASS 3.5s
pnpm selfcheck --only G6   2026-11-07T16:55:44Z  G6  localnet  PASS  26.1s   (after reverting the mutants and rebuilding)

main 1bcd75d = aac4df9 (E10) + coordinator log (clean)
pnpm selfcheck --fast  x2  2026-11-07T16:58:00Z / 16:58:34Z
  G1 PASS 19.4s / 18.8s | G2 PASS 6.0s / 6.2s 97.91%, 1000/1000 | G3 PASS 5.4s / 5.6s | G4 PASS 2.2s / 2.3s
pnpm selfcheck --only G6   2026-11-07T16:59:07Z  G6  localnet  PASS  25.2s
pnpm selfcheck --only G3 x3 (after G3 mutant revert + rebuild)  PASS 5.4s, 5.5s, 5.4s
```

## What G6 proves, checked by hand (5800793, CLI JSON read directly, chain read with solana / spl-token CLIs)

Admin: `node packages/cli/dist/kelvara.mjs analyze --network localnet --json packages/scenarios/.localnet/admin/approval.unsigned.b64` exit 0:
`alertLevel L3`, `level critical`, `action hold_block_default`, simulation `ok`, "Simulation shows: Transaction 0: FczL…8kxT -0.000005 SOL".
Claims: `authority.transfer` (Fact L3) "Proposed setAuthority program.upgrade on 4Q8u…PQR7 (= demo programData): C1sE…g7Ug (vault) gives authority to dtmpNZtc…qWf" = scenario.json `attacker`; `lifetime.durable_nonce` (Fact L3); `nonce.staged_by_outsider` (Fact L3) naming funder Er6o…NPFB = scenario.json `outsider`; `squads.zero_timelock_execution` (Derived L1, multisig AeSy…tSAw); plus `graph.capability_preview`, `capability.recovery_path`. Every claim carries evidenceIds.
Attack (`admin-local.mjs --attack-only`, exit 0): `solana program show MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` Authority before = C1sEWkDnzuit3A6Q858UFcvFmzt1XV9ycszVQud6g7Ug (vault), after = dtmpNZtcTx4PsHcwUXQC464wvZVgEgrkeT78rBA8qWf (attacker).

Trap: `analyze --network localnet --json --wallet 696J…JZRe(user) packages/scenarios/.localnet/trap/buy.partial.b64` exit 0:
`alertLevel L2`, `level warning`, `action hold`, simulation `ok` with "+50000 of mint 64qj…nuAs" to the user.
Claims: `token2022.permanent_delegate` (Fact L2) and `token.freeze_authority` (Fact L2) both name 2qjrduBPhG3AsWWdhiqQxGLj4Tv6hTRCyPFneufxqQy6 = scenario.json `creator`; plus `address.first_send`, 2x `graph.capability_preview`. `spl-token display` of the mint: Token-2022, freeze authority and permanent delegate both 2qjr…qQy6.
Attack (`trap-local.mjs --attack-only`, exit 0): buy tx 3uJzgfw9… user token balance pre [] post 50000; pull-back tx 5KbcjdNt… signed only by 2qjr…qQy6 (creator), TransferChecked + FreezeAccount, user balance 50000 -> 0. `spl-token display` user ATA HmwH…JZRe: Balance 0, State Frozen.

On 1bcd75d the runner's admin claim list adds `intent.label_mismatch` and `sim.power_without_value` (E10), still L3; trap adds `sim.power_without_value`, still L2.

## Gate is live (mutants in the scratch checkout, reverted, `git status` clean afterwards; nothing committed)

- Engine mutant (5800793): `nonceStagedByOutsiderRule` dropped from `packages/core/src/rules/index.ts`, rebuilt -> `G6 localnet FAIL 21.4 missing claim nonce.staged_by_outsider`, selfcheck exit 1.
- Runner mutant (5800793): trap `token.freeze_authority` expected to name the seller instead of the creator -> `G6 localnet FAIL 24.0 claim token.freeze_authority does not name HbseETMPYmfQxhGNKtcpTnyGTJUzzhQHh4CowhMsiZEw`, exit 1.
- G3 engine mutant (1bcd75d): `address.first_send` emits L4 instead of L1 -> G3 FAIL 4.6s: rules-address "23 real first-time transfers: none reaches L4" fails; rules-benign rejects the report (`Fact claim from address.first_send cannot reach L4`); rules-session sim.power_without_value fails.

## G3 sweep timing (coordinator asked)

rules-benign sweep, 1bcd75d, 5 runs warm: test 1793 / 2660 / 2662 / 2629 ms (file), `rules+decode` 1413-1525 ms, prepare 114-149 ms. No run near the 5 s vitest per-test timeout here; the engine's one cold 6.0 s was not reproduced. Headroom is ~2x; a heavily loaded machine could still approach it: watch, not a FAIL.

## Findings

1. Selfcheck (verifier-owned, fixed on team/verifier): on a FAIL the scoreboard note quoted the first line containing "FAIL", which for G6 is the runner's expected pre-reset probe `[localnet] FAIL demo program upgrade authority is our key`, hiding the real cause. `failNote()` now prefers SELFCHECK-SUMMARY, then the gate's own `G<n> … FAIL … <reason>` line, and strips ANSI colours. Re-run of the engine mutant with the fix: `G6 localnet FAIL 22.5s pnpm test:localnet: missing claim nonce.staged_by_outsider`. Self-tests 38/38, lint PASS.
2. G6 from a fresh checkout cannot reset a localnet started by another checkout: `localnet up` refuses (`127.0.0.1:8899 is held by another process`) and the CLI only accepts :8899, so the first attempt failed in 11.4s (environmental, not a product failure). Workaround used: `localnet:down` in the owning checkout, then G6 in the fresh checkout owns the validator; the scenarios-owned localnet was restored afterwards with a fresh `localnet up` (11 checks ok). Reported to scenarios/coordinator as an operability note for the M8 clean-clone run.
3. `squads.zero_timelock_execution` is Derived L1 on its own; the L3 comes from authority.transfer / durable nonce / outsider. Matches PLAN (claim required, overall L3).

---

# V8 combined X9 readiness verification

Merged `main` first without local changes: combined candidate `ee8822750c73f41dbcda17d35ca55e74bb706449` contains X9 `03b0f12` (via main `741ded5`) and readiness fix `b3f45fd`. No extension-owned paths were edited. X9 retains the L2 stub until G6; its `@kelvara/core` workspace dependency is not integration evidence.

All V8 results below are on **`team/verifier`**, not `main`. Main remains `741ded53adefc3aad44457c29e30f7957235b406`; `git merge-base --is-ancestor 741ded5 ee88227` and `git merge-base --is-ancestor main HEAD` both exit 0. The readiness fix and verifier evidence await coordinator review and merge. Coordinator subsequently confirmed the existing X9 candidate, no newer extension service-worker changes, and routing future extension questions through the coordinator.

`hasRealEngine()` delegates to TypeScript AST inspection: only demonstrated direct `decide(..., stubEngine)` wiring to the fixed L2 literal adapter defers engine cases. Non-stub, mixed, indirect and unknown wiring runs assertions; unreadable or malformed source fails. Regression tests cover dependency-plus-stub versus real wiring, import aliases, misleading comments, unused stub imports, adapter integration/spreads, replaced adapters, bypassed decision calls, invalid syntax and adapter setup code. The last four cases were added in `9669129`; the implementation and earlier regression cases are in `b3f45fd`.

```text
pnpm selfcheck --only G7   2026-11-07T13:47:50Z  team/verifier ee88227 (clean at launch)
G7  e2e       PENDING  100.1s  15 PASS / 0 FAIL / 7 engine-wiring PENDING

pnpm selfcheck --fast      2026-11-07T13:48:30Z  team/verifier 9669129 (clean)
G1  build     PASS      25.9s
G2  decode    PASS       7.4s  97.83%, 1000/1000 fuzz
G3  rules     PENDING    3.8s  remaining M2 rules
G4  contract  PASS       2.4s
```

Both selfcheck commands exited 0; the G7 subcommand's 78 denotes documented PENDING, not an actual test failure. G7 launched from clean `ee88227`; while it ran, only its regression self-test was extended and committed as `9669129`, with no browser, extension or readiness implementation changes. `pnpm --filter @kelvara/selfcheck test` passed 35/35 with the added cases and `pnpm lint` passed. G5/G6/G8/G9/G10 were not rerun in V8 and are not certified by this report; in particular G6 has not authorized integration and G7 is not PASS.

Extension candidate coordination was attempted directly but Orca rejected routing to dispatch `ctx_07832f5e5e70` because its latest dispatch `ctx_341a6741322d` is not this worker's helper. Coordinator was notified (`msg_5e9b1683401e`) of that limitation and the exact existing X9 candidate used; no additional extension change was required for this readiness fix.

**V8 scoped outcome: succeeded with G7 honestly PENDING. V7's actual engine-owned core-suite timeout remains unresolved; V8 did not rerun that suite or declare the failure fixed.** G7's successful stub-path cases also do not certify real-engine behavior or eliminate earlier intermittent failures.

---

# V7 independent verification

Verified clean `main` / `team/verifier` commit `95f9971982756a99bbbd6d6157120141ff60d9ba` after merging main (fast-forward, no local changes). Main still pointed to `95f9971` at the end of the baseline run.

```text
pnpm selfcheck --fast                 2026-11-07T13:11:43Z  commit 95f9971
G1  build        PASS      35.8s
G2  decode       PASS      10.9s  97.83%, 1000/1000
G3  rules        PENDING    4.2s  26/26 implemented-rule tests pass; remaining M2 rules not landed
G4  contract     PASS       2.5s  41/41 contract tests

pnpm selfcheck --only G7,G10          2026-11-07T13:12:37Z  commit 95f9971
G7  e2e          PENDING  102.8s  15 PASS, 0 FAIL, 7 PENDING: real engine not wired into extension
G10 security     PENDING    4.7s  release zip not built; all unpacked/source checks PASS
```

Both selfcheck commands exited 0. Their G3/G7/G10 subcommands exit 78 only for documented future-feature PENDING. G3 is **not PASS**: E8/E9/E10 and full M2 rule coverage remain engine-owned. G5/G6/G8/G9 were **not run in V7**; this report does not carry forward earlier gate results as current certification.

## Additional checks and actual failure

- `pnpm --filter @kelvara/scenarios fixtures:verify`: PASS, 88 wire fixtures, 12 programs, 3 replay transactions, poisoning contexts independently verified.
- `pnpm --filter @kelvara/scenarios test`: PASS, 13/13.
- `pnpm --filter @kelvara/core test`: **FAIL**, 160/161 passed. `packages/core/test/rules-benign.test.ts:43` exceeded its 5000 ms timeout (5133 ms) under concurrent verification load; all 96 session results printed, with L0=70/L1=9/L2=10/L3=7 and no L4. Exact error: `Test timed out in 5000ms.` The isolated unchanged test subsequently passed in 1169 ms; that retry does not erase the failure. Reported to engine and coordinator (`msg_0ec481f3613d`, `msg_a2805bf2c821`); no engine-owned implementation was edited.
- `pnpm --filter @kelvara/selfcheck test`: PASS, 34/34 after adding `tools/selfcheck/test/fixture-domains.test.mjs` (33/33 on clean baseline).
- `pnpm lint`: PASS with the new verifier test.
- Post-test `pnpm selfcheck --fast` at 13:18:33Z on `95f9971-dirty` (only new verifier test): G1 PASS 15.2s, G2 PASS 6.6s (97.83%, 1000/1000), G3 PENDING 4.6s, G4 PASS 2.8s. This is supplementary, not a clean-main certification.

**V7 outcome: failed until the engine-owned timeout is resolved.** Required baseline gates have no FAIL, but the real additional test failure remains open.

## Fixture-domain and provenance review

G2's walker starts at `fixtures/tx` (`packages/core/test/decode-gate.test.ts:38`) and compares that complete inventory with `fixtures/tx/manifest.json`. It parsed 88 transactions / 667 instructions; 415 were eligible, 406 named (97.83%). Programs without registered IDLs/builtins remain explicitly excluded. All 1000 malformed inputs produced the expected errors.

`fixtures/poison/manifest.json` is a separate `kelvara.fixture.poison-manifest/v1` inventory: 30 contexts, comprising 6 mainnet poisoning positives, 1 executed devnet positive, and 23 mainnet first-send negatives. `fixtures:verify` invokes `verifyPoisonFixtures()` independently of G2 and re-derives transfers, dust, lookalike matching and no prior send in the recorded history window. The new verifier regression asserts complete inventories for both domains, manifest/record kind and expectation agreement, successful signed anchor transactions, disjoint positive/negative signatures, L1/notL4/notRules for first sends, and `first-send` + `benign` tags on all 23 wire fixtures and manifest entries. It passes; first sends cannot silently enter the current positive inventory without failing this check. The future E9 engine consumer is not built and is not certified here.

A read-only live Helius comparison re-fetched all **179 distinct recorded getTransaction calls** (176 mainnet, 3 devnet) using their recorded params. Every signed transaction, slot, blockTime, execution status and decoded transfer matched. History includes failed unrelated transactions; the provenance check compares their actual status rather than treating their instructions as successful activity, while every positive/negative anchor is separately required successful. No fixture, key or chain state was changed. The probe is `/home/andy/.hermes/cache/scratch/signguard-v7-rpc-verify.mjs`; it contains no credential values.

All six mainnet poisoning positives truthfully have `request: null`: they record real payment plus later dust and lookalike history, not an observed victim send to the attacker. Only the devnet positive records the executed victim send. The recorded history is bounded (up to 50 earlier signatures, transactions fetched down to the real payment), not proof of a complete 30-day/1000-signature search; E9 must retain truthful history scope. First-send negatives additionally record an empty recipient history before the real transfer.

## Remaining owners

- Engine: fix the load-sensitive core-suite timeout; finish E8/E9/E10 before G3 can pass; registry G5 and determinism G9 remain unverified here.
- Extension + engine: wire the real analyzer after the G6 checkpoint; seven G7 level/benign cases remain PENDING. Separate first-click-loss investigation is extension-owned; this single G7 run does not resolve it.
- Scenarios + engine: G6 scenario/analyzer checkpoint; scenarios' G8 replay/devnet stories were not run here.
- Coordinator + extension: build release zip, then rerun G10 against the actual zip. Unpacked checks passed: Helius-only hosts, no eval/remote code, storage-only permissions, offline content scripts, no page control, embedded public license key, no Helius key in dist, read-only passThrough policy, and licenses (76 packages / 5 direct).
