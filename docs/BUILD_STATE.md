# BUILD STATE

Current phase: Phases 0-11 implemented plus Batch API support; paid and
deployment work outstanding
Current branch: main
Last known green commit: see `git log -1` (all commits below were validated)
Last validation run: 2026-09-16 - `pnpm lint`, `pnpm typecheck`, `pnpm test`
(120 passing), `pnpm build`, `pnpm test:e2e` (6 passing), `pnpm eval:smoke`
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
- Model configuration: defaults centralised in `src/config/env.ts`
  (`claude-sonnet-5` generation, `claude-opus-5` judge), both overridable by
  environment. No model id is hard-coded elsewhere.
- Pricing: `evals/pricing.json` carries current Anthropic rates, so
  `EVAL_MAX_SPEND_USD` now enforces against real tracked spend.
- Batch API: `src/ai/client/batch.ts` plus `src/evals/batch-execution.ts`.
  `eval:run`, `eval:generate` and `prompt:optimize` all accept
  `--execution batch`, or default to it with `EVAL_USE_BATCH_API=true`.
  Batch runs are costed at the 50% rate. Covered by 20 tests against a fake
  batch client; never used on the `/api/respond` request path.

## Blocked

**Paid Anthropic work** - the key authenticates, but the Anthropic *Console*
credit balance is empty, so every Messages API call returns
`400 invalid_request_error: Your credit balance is too low`. This is a
different billing pool from a claude.ai Pro subscription; Pro usage credits do
not fund the API. `ALLOW_PAID_EVALS` is deliberately `false`.

Blocked: a real synthetic corpus, any live experiment run, real benchmark
artifacts, recorded replay fixtures, prompt candidate search. All the code
paths exist and are covered by tests against fake sequential and batch
clients.

Exact commands once credentials exist:

```bash
# 1. Add credit at console.anthropic.com -> Billing (NOT claude.ai).
export ANTHROPIC_API_KEY=...
export ALLOW_PAID_EVALS=true
export EVAL_MAX_SPEND_USD=25          # enforced against real tracked spend
export EVAL_USE_BATCH_API=true        # half cost, queued not real-time

# 2. Free sanity checks first.
pnpm eval:generate --plan             # prints the batch plan, calls nothing
pnpm eval:run --dataset human --max-cases 6   # offline, no cost

# 3. Smallest possible live call, to confirm billing works.
pnpm eval:run --dataset seed --mode live --max-cases 2 --execution sequential

# 4. Then the real workloads.
pnpm eval:generate --ordinary 200 --edge 100 --adversarial 100
pnpm eval:run --dataset human --mode live
pnpm eval:compare --list
pnpm eval:compare <baseline-run-id> <candidate-run-id> --write-benchmark
pnpm prompt:optimize --dataset human --candidates 4
```

Models default to `claude-sonnet-5` (generation) and `claude-opus-5` (judge);
set `ANTHROPIC_MODEL` / `ANTHROPIC_JUDGE_MODEL` only to override. Retired ids
such as `claude-3-5-sonnet-20240620` will fail — `GET /v1/models` lists what a
key can reach.

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
- A batch run produces identical case results to a sequential one; only cost,
  latency and `config.execution` differ. Tests assert this.
- `evals/benchmarks/latest.json` does not exist yet and must never be created
  by hand.
- `.agents/`, `.claude/` and `skills-lock.json` are untracked user tooling and
  are excluded from commits.
