# V8 combined X9 readiness verification

Merged `main` first without local changes: combined candidate `ee8822750c73f41dbcda17d35ca55e74bb706449` contains X9 `03b0f12` (via main `741ded5`) and readiness fix `b3f45fd`. No extension-owned paths were edited. X9 retains the L2 stub until G6; its `@kelvara/core` workspace dependency is not integration evidence.

`hasRealEngine()` delegates to TypeScript AST inspection: only demonstrated direct `decide(..., stubEngine)` wiring to the fixed L2 literal adapter defers engine cases. Non-stub, mixed, indirect and unknown wiring runs assertions; unreadable or malformed source fails. Regression tests cover dependency-plus-stub versus real wiring, import aliases, misleading comments, unused stub imports, adapter integration/spreads, replaced adapters, bypassed decision calls, invalid syntax and adapter setup code. The last four cases were added in `9669129`; the implementation and earlier regression cases are in `b3f45fd`.

```text
pnpm selfcheck --only G7   2026-11-07T13:47:50Z  candidate ee88227 (clean at launch)
G7  e2e       PENDING  100.1s  15 PASS / 0 FAIL / 7 engine-wiring PENDING

pnpm selfcheck --fast      2026-11-07T13:48:30Z  candidate 9669129 (clean)
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
