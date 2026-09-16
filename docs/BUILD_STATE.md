# BUILD STATE

Current phase: Phases 0-11 implemented; paid and deployment work outstanding
Current branch: main
Last known green commit: see `git log -1` (all commits below were validated)
Last validation run: 2026-09-16 - `pnpm lint`, `pnpm typecheck`, `pnpm test`
(103 passing), `pnpm build`, `pnpm test:e2e` (6 passing), `pnpm eval:smoke`
(24 cases, offline) all pass.

## Completed

- Phase 0: `AGENTS.md`, `CLAUDE.md`, `docs/*`
- Phase 1: Next 16 App Router scaffold, Tailwind 4, environment validation,
  `GET /api/health`
- Phase 2: support policy, prompt registry with `ACTIVE_SUPPORT_PROMPT`,
  separate generation/judge clients, Zod-validated structured output,
  `POST /api/respond`
- Phase 3: eval case schema and loader, 56 human-authored cases, five
  deterministic evaluators, consolidated rubric judge, weighted quality score
- Phase 4: `eval:generate`, `eval:run`, `eval:compare`, `prompt:optimize`,
  `eval:smoke`, paid-execution gating, usage tracking
- Phase 5: input validation, injection heuristics, PII redaction, output
  authority and leakage checks
- Phase 6: `Observability` abstraction with Langfuse and no-op implementations
- Phases 7-9: demo UI, `/engineering`, Replay Mode with six fixtures, rate
  limits and global daily cap
- Phase 10: 103 unit/integration tests, 6 Playwright E2E tests, GitHub Actions
  CI that needs no paid model access
- Phase 11: README with architecture diagram, methodology, limitations and
  deployment steps

## Blocked

**Paid Anthropic work** - no `ANTHROPIC_API_KEY` in this environment and
`ALLOW_PAID_EVALS` is unset. Blocked: a real synthetic corpus, any live
experiment run, real benchmark artifacts, recorded replay fixtures, prompt
candidate search. All the code paths exist and are covered by tests with
mocked clients.

Exact commands once credentials exist:

```bash
export ANTHROPIC_API_KEY=...
export ANTHROPIC_MODEL=...
export ANTHROPIC_JUDGE_MODEL=...
export ALLOW_PAID_EVALS=true
export EVAL_MAX_CASES=60

pnpm eval:generate --plan                 # free: inspect the batch plan
pnpm eval:generate --ordinary 200 --edge 100 --adversarial 100
pnpm eval:run --dataset human --mode live
pnpm eval:compare --list
pnpm eval:compare <baseline-run-id> <candidate-run-id> --write-benchmark
pnpm prompt:optimize --dataset human --candidates 4
```

**Deployment** - `ALLOW_DEPLOY` is unset and no Vercel credentials are
configured. `pnpm build` passes; deployment steps are documented in the README.

## Known failures

None.

## Next recommended task

1. If credentials become available, run the paid sequence above in order and
   commit the resulting `evals/datasets/generated.jsonl` and
   `evals/benchmarks/` artifacts. Prioritise this: it is the only thing that
   turns the engineering view's "no benchmark yet" into real data.
2. Otherwise, implement the persistent `UsageStore` backed by `DATABASE_URL`
   so public live inference can be enabled safely on multi-instance hosting.

## Relevant notes

- Offline runs deliberately produce no rubric scores; rubric gates report "no
  measurement" rather than passing. See `docs/DECISIONS.md`.
- `evals/benchmarks/latest.json` does not exist yet and must never be created
  by hand.
- `.agents/`, `.claude/` and `skills-lock.json` are untracked user tooling and
  are excluded from commits.
