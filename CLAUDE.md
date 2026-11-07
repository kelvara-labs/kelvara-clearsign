# Kelvara SignGuard: agent operating rules (Orca team)

## Mission
Build the MVP in PLAN.md within 48 hours. Optimize for a green `pnpm selfcheck`
and a working Drift demo, not for feature count.

This repo is built by a team of agents run by Orca orchestration: one coordinator
and four workers, each worker in its own git worktree and branch. Find your role
below and follow it. If you were not told a role, you are the coordinator.

## Roles and ownership
Only the owner edits a path. Need a change elsewhere? Ask its owner by Orca message.

| Role | Branch | Owns | Milestones |
|---|---|---|---|
| coordinator | `main` | PLAN.md, CLAUDE.md, PROGRESS.md, NEEDS_HUMAN.md, root config (package.json, pnpm-workspace.yaml, tsconfig*, esbuild config), all merges | M0, M8 |
| engine | `team/engine` | packages/core, packages/idls, packages/cli | M1, M2, M3, core half of M4 |
| extension | `team/extension` | packages/extension, test-dapp | M5, extension half of M7 |
| scenarios | `team/scenarios` | packages/scenarios, programs/helix-perps, fixtures, DEMO.md | localnet half of M4, M6, demo assets for M8 |
| verifier | `team/verifier` | tools/selfcheck, SELFCHECK.md, e2e specs under test-dapp/e2e | gate runner from M0 on; runs and reports every gate |

Shared files with special rules:
- LICENSES.md: anyone may append a row for a dependency they add; never edit others' rows.
- Golden files in fixtures/: scenarios owns them; a change needs a written reason in the
  owner's progress log and the coordinator's approval.
- The engine's public API (`packages/core/src/index.ts` and the report zod schema) is a
  contract. The engine announces any change to it with `orca orchestration send --to "@all"`
  before merging.

## Order of work
1. Coordinator does M0 alone on `main`: pnpm workspace, toolchain, package skeletons,
   empty `pnpm selfcheck` that prints all ten gates as PENDING. Commit, then start workers.
2. Engine, scenarios and verifier start right after M0.
3. Extension starts after M0 on capture, hold and decide (hook, bridge, shadow-root UI,
   fail-closed timer) against a stub of the engine API. It wires in the real engine only
   after the hour-24 checkpoint: the engine catches the Drift pattern on localnet (G6).
4. Coordinator merges worker branches into `main` after each closed task group, rebasing
   workers when the engine contract changes.

## Worker loop (repeat until your milestones are closed)
1. Read PLAN.md, your progress log `progress/<role>.md`, and your task spec from Orca.
2. Write the test or gate check first when practical.
3. Implement the smallest change that makes it pass.
4. Run `pnpm selfcheck --fast` after every task.
5. Commit on your branch as `M<n>/<role>: <task>`; append one line to
   `progress/<role>.md`: task, gates, minutes, decisions.
6. Send `orca orchestration send --type heartbeat` at least every 20 minutes of work.
7. When the task is done or failed, send `worker_done` exactly once with the task id,
   dispatch id, outcome, a short summary (done / found / remains) and `--files-modified`.

Blocked on a decision? Use `orca orchestration ask --to <coordinator>`, never a local
prompt, and keep working on anything unblocked while you wait.

## Coordinator loop
1. Keep the task list in Orca: one task per PLAN.md task, with dependencies and the
   owning role in the spec. Dispatch with `orca orchestration worker-start`.
2. Wait on the inbox: `orca orchestration check --wait --types worker_done,escalation,question`.
   Ack each delivery after handling it.
3. On `worker_done`: review the diff, merge the branch into `main`, ask the verifier to run
   the gates for that milestone, then append one line to PROGRESS.md.
4. Close a milestone only when the verifier reports its gates PASS on `main`.
5. Answer questions and resolve decision gates; anything only the human can do goes into
   NEEDS_HUMAN.md, then carry on.

## Verifier rules
- Only the verifier writes SELFCHECK.md and only the verifier declares a gate PASS.
- Run gates on a fresh checkout of `main` (or the branch you were asked to check), never
  in a worker's dirty tree.
- On FAIL, message the owning worker directly with the failing gate, the command and the
  first relevant output, and copy the coordinator.

## Hard rules (all roles)
- Network: Solana JSON-RPC only (localnet, devnet, or the configured mainnet endpoint).
  No third-party APIs, analytics, telemetry or remote AI.
- Keys: localnet and devnet only, kept in `.keys/` (gitignored). Never a mainnet key.
- Tests: never skip, weaken or delete a failing test to go green. Fix the code, or
  write a waiver with the reason in your progress log.
- Golden files: change only with a written reason (see above).
- Data: fixtures come from real RPC responses or from transactions executed on
  localnet. Never invent transactions, addresses or results.
- Licenses: check each new dependency and record it in LICENSES.md. Nothing under
  AGPL, BUSL or MPL goes into packages/core or packages/extension.
- Extension: never sign, never submit, never store wallet secrets. Fail closed.
- Never edit a path you do not own, and never push to `main` unless you are the coordinator.

## Timeboxes
- One blocker: 45 minutes, then take the fallback in PLAN.md (Risks), log it and tell
  the coordinator.
- A milestone 50% over budget: the coordinator cuts from the cut list in PLAN.md, top
  first. Never cut G4, G6, G7 or G8.

## When you need the human
Workers ask the coordinator. The coordinator writes the exact ask in NEEDS_HUMAN.md, then
keeps the team working on unblocked tasks.

## Done
All ten gates PASS from a clean clone of `main`, SELFCHECK.md committed, DEMO.md tested,
dist/kelvara-signguard.zip built.
