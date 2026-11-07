# M8 / V11 final verification — 2026-11-07

**All ten gates PASS on a fresh plain clone of main `7c57a6a8da3e80b6bf16191437dac1748270b09f`.** Live G8 also PASSes on that commit. Live G5 initially FAILed there; E19 fixes its clean-clone credential lookup, and live G5 PASSes on fresh clean main `7b00cbde953f5812a4af034576e25b0a16774cdf`. S14 follow-up checks PASS on main `1fb6ae116bde5d8f5ffdcdad66bfc07802b397c4`.

These are separate, precisely scoped runs: the full ten-gate run was not repeated on either follow-up commit. E19 changes the IDL chain key loader and its regression test; S14 changes only scenario `--verify` preflight/diagnostics and tests, leaving browser `--serve` behavior and extension/engine runtime unchanged. The coordinator authorized these scoped follow-ups. No gate is PENDING, no failing test was skipped or weakened, and the original failures remain below.

## Clean-clone scoreboard

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

## Commands and live results

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

## Release and mutations

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

## Saved-case failure and S14 diagnostics

**Original supplemental failure retained:** after the full run and live G8, `pnpm scenario:e2e-cases --no-setup --with-ata-sweep --verify` on `7c57a6a` reported admin L3 correctly but trap **L1 instead of L2**, sweep and ATA sweep **L1 instead of L4**. This was not a G7 failure: G7 used fresh served bytes and passed all 25 cases. The old wrapper recorded only levels/ruleIds, not simulation diagnostics; subsequent fresh setup overwrote the original wires before they were preserved. Therefore original blockhash expiry is **unconfirmed**, and a fresh PASS alone does not resolve the original diagnosis.

The correct fresh command, `pnpm scenario:e2e-cases --with-ata-sweep --verify`, PASSed all four expected levels on `7c57a6a`. Scenarios diagnosed that a failed exact-message fee lookup can drop inventory enrichment even when independent simulation retries, explaining a possible loss of trap/sweep facts. S14 `5b07a74`, merged main `1fb6ae1`, adds exact saved-blockhash validity and non-replacing simulation preflight; failures retain public input, RPC diagnostics and CLI output under `.localnet/verify-failures`. It does not change engine rules or expected levels.

On a clean checkout of `1fb6ae1` in the original verification clone:

- Fresh `pnpm scenario:e2e-cases --with-ata-sweep --verify` PASSes L3 admin / L2 trap / L4 sweep / L4 ATA sweep.
- `node --test packages/scenarios/test/e2e-cases.test.mjs` PASSes 5/5.
- A real generated ATA sweep was cloned **in memory**, its wire blockhash changed to zero and its matching metadata marked invalid, then passed to `verify`. It rejects `STALE saved blockhash is no longer valid`, saves the exact public mutated input plus `diagnostics.blockhash.value=false`, and leaves the saved-case file byte-identical. This is a mutation test, not a fabricated fixture or evidence of the original failure's cause.
- Validator stopped; tracked/untracked git status clean.

## Demo coverage, residual risks and limitations

The automated portions of the two DEMO.md stories are exercised by G6 and live G8: Drift replay, admin upgrade-authority takeover, and trap purchase/delegate pullback/freeze. DEMO.md also contains the scenarios owner's dated S8 test record for serve-only pages, sweep and poisoning. This verification did not repeat those human demo steps: Solflare imports/prompts, devnet browser recording, explorer views and a human-issued license remain human-only and are not certified here. The localnet browser test wallet is not Solflare.

Cached G8 intentionally skips devnet execution; its separate live PASS closes that requirement. Helius availability and chain state may change after the recorded runs. Decode coverage is 98.02%, not universal instruction or protocol coverage; offline/cached evidence and bounded address-history searches retain their stated limits. Host-sink analysis is name-based and may over-report; runtime network checks supplement it. Original stale-case root cause remains unconfirmed; S14 now rejects and preserves such inputs instead of silently interpreting their lower level as a valid scenario result.

Detailed redacted logs and original summaries are retained locally at `/tmp/kelvara-v11-evidence/`; selected summaries are committed beside this report. No credentials, private keys or copied env files are included. The final report/progress commit changes verifier-owned paths only.
