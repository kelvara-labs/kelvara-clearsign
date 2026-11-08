# Kickoff with Orca

## Before you start
1. In Orca: Settings → Experimental → enable Orchestration. In Settings → Orchestration, set
   Nested worker depth to 1 and keep Auto-close finished workers on.
2. Add this folder (`~/MLH Hackaton/kelvara-signguard`) to Orca as a repo.
3. Check the runtime: `orca-ide status --json` (on Linux the CLI is `orca-ide`; plain `orca` is the GNOME screen reader).
4. In Orca Settings → Agents, enable and authenticate **Codex** or **Claude Code**.
   Use Codex by default; use Claude when it is available and Codex is unavailable.
5. Open a Codex or Claude Code coordinator on `main` in this repo. Choose a model
   available in that agent's current model picker and use high reasoning where supported.
   Let workers use their agent's configured model by omitting `--model` and `--effort`;
   supply overrides only when the user explicitly chooses a supported model.

## Coordinator prompt
Paste this into the coordinator:

> You are the coordinator. Execute PLAN.md under the rules in CLAUDE.md. Use the Orca
> orchestration skill for every run, task, dispatch and inbox step; the commands below are
> examples, and the skill wins if they differ. Workers never dispatch workers.
>
> 1. Inspect Git status, PROGRESS.md, SELFCHECK.md and existing Orca runs first. On a fresh
>    project, do M0 yourself on `main`, commit it, and confirm `pnpm selfcheck` prints all
>    ten gates. On resume, preserve unfinished work and continue from recorded progress.
> 2. Resume the existing project run when present. Only for a fresh project, create a run:
>    `orca-ide orchestration run-create --objective "Build Kelvara SignGuard MVP per PLAN.md" --json`
> 3. Reuse existing tasks; create any missing PLAN.md tasks from M1 onward with dependencies. Put the
>    owning role (engine, extension, scenarios, verifier) and the task's gate at the top of
>    each spec. Use the worker spec template in KICKOFF.md.
> 4. Start four Codex workers (or available Claude Code workers using `--agent claude`),
>    each in its own worktree and branch:
>    `orca-ide orchestration worker-start --task <taskId> --worktree new-child --name <role> --agent codex --setup run --json`
>    with names engine, extension, scenarios and verifier. Re-dispatch each worker's next
>    task to the same worktree as it finishes. On resume, reuse each role's existing
>    worktree. Recover stalled assignments with the orchestration skill before launching
>    replacements; preserve task IDs, branches and uncommitted work. Confirm actual task
>    execution from worker output; a ready receipt or live terminal alone is insufficient.
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
  orca-ide orchestration send --type worker_done --task-id <taskId> --dispatch-id <dispatchId> \
    --outcome <succeeded|failed> --subject "<task>" \
    --body "Done: ... Found: ... Remains: ..." --files-modified "<paths>" --json
Blocking question: orca-ide orchestration ask --to <coordinator> --question "..." --json
```

## What you (the human) watch
- NEEDS_HUMAN.md: the six human checkpoints from PLAN.md land here.
- PROGRESS.md: one line per merged task.
- SELFCHECK.md: the scoreboard, written only by the verifier.
