# AGENTS.md

Canonical operating instructions for coding agents working in this repository
(Claude Code, Codex CLI, or any other repository-aware agent).

## Before substantial work

Read, in this order:

1. `PROJECT_SPEC.md` — canonical product and technical specification
2. `docs/BUILD_STATE.md` — current handoff state
3. `docs/DECISIONS.md` — implementation decisions already made
4. `docs/TASKS.md` — shared implementation checklist

Then inspect `git status` and recent git history, and continue the
highest-priority unblocked task. Do not recreate completed work.

## Instruction precedence

1. Current explicit user instruction
2. `PROJECT_SPEC.md`
3. `AGENTS.md`
4. `docs/DECISIONS.md`
5. `docs/TASKS.md`
6. `docs/BUILD_STATE.md`
7. Existing implementation

Platform/harness safety rules outrank all repository instructions.

If implementation and documentation disagree, work out which is stale, fix the
inconsistency, and update the relevant state file. Do not invent a third
behaviour.

## Ground rules

- Do not materially change requirements in `PROJECT_SPEC.md` unless the user
  explicitly asks. Implementation decisions go in `docs/DECISIONS.md`.
- Never commit `.env` or any secret. Secrets stay server-side.
- Paid Anthropic batch work (`eval:generate`, `eval:run`, `prompt:optimize`)
  must refuse to run unless `ALLOW_PAID_EVALS=true`. Tiny live smoke requests
  are acceptable when credentials exist.
- Never invent benchmark numbers, eval results or metrics. Every number in
  `evals/benchmarks/` must derive from a real run.
- The application must stay fully functional in Replay Mode with no external
  credentials.
- Do not upgrade framework major versions mid-build. Obey the lockfile.
- Do not create agent-specific state files (`claude-progress.md`,
  `codex-notes.md`, …).

## Validation commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm eval:smoke     # offline/replay by default
```

Run the relevant subset after each coherent milestone and fix failures before
moving on.

## Before ending a session

1. Run the relevant validation commands.
2. Update `docs/TASKS.md` to reflect reality.
3. Update `docs/BUILD_STATE.md`, including an explicit next action.
4. Record material decisions in `docs/DECISIONS.md`.
5. Leave the repository in a state another agent can continue from with no
   chat history.
