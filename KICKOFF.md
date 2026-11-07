# Kickoff with Orca

## Before you start
1. In Orca: Settings → Experimental → enable Orchestration.
2. Add this folder (`~/MLH Hackaton/kelvara-signguard`) to Orca as a repo.
3. Check the runtime: `orca status --json`.
4. Open a Claude Code agent on `main` in this repo. That agent is the coordinator.

## Coordinator prompt
Paste this into the coordinator:

> You are the coordinator. Execute PLAN.md under the rules in CLAUDE.md.
>
> 1. Do M0 yourself on `main`, commit it, and confirm `pnpm selfcheck` runs and prints
>    all ten gates.
> 2. Create the Orca run:
>    `orca orchestration run-create --objective "Build Kelvara SignGuard MVP per PLAN.md" --json`
> 3. Create one Orca task per PLAN.md task from M1 onward, with dependencies, and put the
>    owning role (engine, extension, scenarios, verifier) and the task's gate at the top of
>    each spec. Use the worker spec template in KICKOFF.md.
> 4. Start four workers, each in its own worktree and branch:
>    `orca orchestration worker-start --task <taskId> --worktree new-child --name <role> --agent claude --setup run --json`
>    with names engine, extension, scenarios and verifier. Re-dispatch each worker's next
>    task to the same worktree as it finishes.
> 5. Run the coordinator loop in CLAUDE.md until all ten gates pass on `main`.
>    Report to me at each milestone gate and at the hour-24 checkpoint.

## Worker spec template
Every Orca task spec starts with this header:

```
ROLE: <engine | extension | scenarios | verifier>
BRANCH: team/<role>
MILESTONE: M<n>   GATES: G<x>[, G<y>]
TASK: <one line from PLAN.md>
DEPENDS ON: <task ids or "none">
OWNED PATHS: <from CLAUDE.md roles table>

Read CLAUDE.md first and follow the worker loop. Commit only on your branch.
Send heartbeat every 20 minutes. Finish with exactly one worker_done:
  orca orchestration send --type worker_done --task-id <taskId> --dispatch-id <dispatchId> \
    --outcome <succeeded|failed> --subject "<task>" \
    --body "Done: ... Found: ... Remains: ..." --files-modified "<paths>" --json
Blocking question: orca orchestration ask --to <coordinator> --question "..." --json
```

## What you (the human) watch
- NEEDS_HUMAN.md: the six human checkpoints from PLAN.md land here.
- PROGRESS.md: one line per merged task.
- SELFCHECK.md: the scoreboard, written only by the verifier.
