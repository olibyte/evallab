# BUILD STATE

Current phase: Phases 0-11 implemented, Batch API support, a benchmark
methodology review, and Claude 5 API compatibility applied; paid and
deployment work outstanding
Current branch: main
Last known green commit: see `git log -1` (the working tree on top of it was
validated as below and is not yet committed)
Last validation run: 2026-09-16 - `pnpm lint`, `pnpm typecheck`, `pnpm test`
(184 passing), `pnpm build`, `pnpm test:e2e` (6 passing), `pnpm eval:smoke`
(24 cases, offline), `pnpm eval:splits --check` all pass.

## Completed

- Phase 0: `AGENTS.md`, `CLAUDE.md`, `docs/*`
- Phase 1: Next 16 App Router scaffold, Tailwind 4, environment validation,
  `GET /api/health`
- Phase 2: support policy, prompt registry with `ACTIVE_SUPPORT_PROMPT`,
  separate generation/judge clients, Zod-validated structured output,
  `POST /api/respond`
- Phase 3: eval case schema and loader, 56 human-authored cases, six
  deterministic evaluators, consolidated rubric judge (`judge-rubric-v2`
  active, v1 retained), weighted quality score
- Phase 4: `eval:generate`, `eval:run`, `eval:compare`, `eval:splits`,
  `prompt:optimize`, `eval:smoke`, paid-execution gating, usage tracking
- Phase 5: input validation, injection heuristics, PII redaction, output
  authority and leakage checks
- Phase 6: `Observability` abstraction with Langfuse and no-op implementations
- Phases 7-9: demo UI, `/engineering`, Replay Mode with six fixtures, rate
  limits and global daily cap
- Phase 10: unit/integration tests, Playwright E2E, GitHub Actions CI that
  needs no paid model access
- Phase 11: README with architecture diagram, methodology, limitations and
  deployment steps
- Model configuration centralised in `src/config/env.ts`; `evals/pricing.json`
  carries current rates; Batch API for offline runs at the 50% rate.
- Benchmark methodology review (2026-09-16): frozen dev/heldout/
  adversarial-holdout splits; optimizer isolated to dev with leakage
  rejection; per-case aggregates with errors as failures and coverage gates;
  like-for-like comparison checks and benchmark refusal on mismatch; full
  run/benchmark provenance; judge prompt v2 with escaped delimiters and
  manipulation handling; resumable batch runs; shared optimization budget.
  Details in `docs/DECISIONS.md`.
- Claude 5 API compatibility (2026-09-16): `supportsSamplingParams` in
  `src/ai/client/model-capabilities.ts` gates `temperature` for every
  Anthropic call path, sequential and batch; nothing is sent unless a caller
  asked for it and the model accepts it. Run records report the sampling
  actually sent. Details in `docs/DECISIONS.md`.

## Blocked

Anthropic Console credit available: US$20
Paid evals remain disabled by default.
No live experiment has yet been run. `ALLOW_PAID_EVALS`
is deliberately `false`.

Blocked: a real synthetic corpus, any live experiment run, real benchmark
artifacts, recorded replay fixtures, prompt candidate search. All code paths
exist and are covered by tests against fake sequential and batch clients.

Exact commands once credentials exist, in order:

```bash
# 1. Add credit at console.anthropic.com -> Billing (NOT claude.ai).
export ANTHROPIC_API_KEY=...
export ALLOW_PAID_EVALS=true
export EVAL_MAX_SPEND_USD=25          # enforced against real tracked spend
export EVAL_USE_BATCH_API=true        # half cost, queued not real-time

# 2. Free sanity checks first.
pnpm eval:splits --check
pnpm eval:generate --plan
pnpm eval:run --dataset human --max-cases 6              # offline, no cost

# 3. Smallest possible live call, to confirm billing works.
pnpm eval:run --dataset seed --mode live --max-cases 2 --execution sequential

# 4. Corpus, then splits are assigned automatically for the new cases.
pnpm eval:generate --ordinary 200 --edge 100 --adversarial 100
pnpm eval:splits --check

# 5. Held-out baseline of the active prompt (the benchmark control).
pnpm eval:run --dataset all --mode live                  # --split holdout is the default

# 6. Candidate search on the dev split only.
pnpm prompt:optimize --dataset all --candidates 4

# 7. Evaluate the recommended candidate on the held-out split, then compare.
pnpm eval:run --dataset all --mode live --candidate <candidate-id>
pnpm eval:compare --list
pnpm eval:compare <holdout-baseline-run-id> <holdout-candidate-run-id> --write-benchmark

# If a poll times out or a process dies mid-batch:
pnpm eval:run --pending
pnpm eval:run --resume <run-id>
```

Do not write a benchmark from dev-split or offline runs. `eval:compare`
refuses non-comparable runs; do not pass `--allow-mismatch` for the
published benchmark.

**Deployment** - `ALLOW_DEPLOY` is unset and no Vercel credentials are
configured. `pnpm build` passes; deployment steps are documented in the README.

## Known failures

None.

## Next recommended task

1. Commit the Claude 5 compatibility fix (the working tree is validated but
   uncommitted; `.agents/`, `.claude/` and `skills-lock.json` stay out).
2. If credentials become available, run the paid sequence above in order and
   commit `evals/datasets/generated.jsonl`, `evals/datasets/splits.json` and
   the `evals/benchmarks/` artifacts. Step 3, the two-case live sequential
   run, is the check that the 400 on `temperature` is gone; it was never
   reached before. Then review a sample of synthetic case
   labels by hand; they are written by the model under test.
3. Otherwise, implement the persistent `UsageStore` backed by `DATABASE_URL`
   so public live inference can be enabled safely on multi-instance hosting.

## Relevant notes

- Splits are frozen in `evals/datasets/splits.json` (dev 28, heldout 16,
  adversarial-holdout 12 over the 56 human cases). Adding a human case
  requires `pnpm eval:splits`; a test asserts the manifest matches the
  deterministic assignment and covers every case.
- Sampling parameters are omitted, not defaulted: `claude-sonnet-5` and
  `claude-opus-5` reject `temperature`, `top_p` and `top_k` with a 400, and
  use adaptive thinking rather than `budget_tokens`. Eval runs still ask for
  `DETERMINISTIC_TEMPERATURE`, which reaches only models that accept it, so
  Claude 5 runs sample at the model default and the run record says so.
- Offline runs carry no rubric scores and fail the `judge-coverage` gate by
  design; `eval:smoke` enforces only the deterministic and generation-success
  gates offline.
- Neither judge prompt has been used against a live model, so switching to
  `judge-rubric-v2` broke no score continuity. Changing it again once live
  results exist means a new version and a fresh baseline.
- `evals/benchmarks/latest.json` does not exist yet and must never be created
  by hand.
- `evals/results/pending/` holds resumable batch manifests; `evals/results/`
  is gitignored.
- `.agents/`, `.claude/` and `skills-lock.json` are untracked user tooling and
  are excluded from commits.
