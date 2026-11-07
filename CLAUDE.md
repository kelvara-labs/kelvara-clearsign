# Kelvara SignGuard: agent operating rules

## Mission
Build the MVP in PLAN.md within 48 hours. Optimize for a green `pnpm selfcheck`
and a working Drift demo, not for feature count.

## Loop (repeat until M8 is closed)
1. Read PROGRESS.md and PLAN.md; take the first open task of the current milestone.
2. Write the test or gate check first when practical.
3. Implement the smallest change that makes it pass.
4. Run `pnpm selfcheck --fast` after every task; the full suite before closing a milestone.
5. Commit as `M<n>: <task>`; append one line to PROGRESS.md: task, gates, minutes, decisions.

## Hard rules
- Network: Solana JSON-RPC only (localnet, devnet, or the configured mainnet endpoint).
  No third-party APIs, analytics, telemetry or remote AI.
- Keys: localnet and devnet only, kept in `.keys/` (gitignored). Never a mainnet key.
- Tests: never skip, weaken or delete a failing test to go green. Fix the code, or
  write a waiver with the reason in PROGRESS.md.
- Golden files: change only with a written reason in PROGRESS.md.
- Data: fixtures come from real RPC responses or from transactions executed on
  localnet. Never invent transactions, addresses or results.
- Licenses: check each new dependency and record it in LICENSES.md. Nothing under
  AGPL, BUSL or MPL goes into packages/core or packages/extension.
- Extension: never sign, never submit, never store wallet secrets. Fail closed.

## Timeboxes
- One blocker: 45 minutes, then take the fallback in PLAN.md (Risks) and log it.
- A milestone 50% over budget: cut from the cut list in PLAN.md, top first.

## When you need the human
Write the exact ask in NEEDS_HUMAN.md, then keep working on unblocked tasks.

## Done
All ten gates PASS from a clean clone, SELFCHECK.md committed, DEMO.md tested,
dist/kelvara-signguard.zip built.
