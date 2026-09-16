# BUILD STATE

Current phase: Phases 0-11 implemented, Batch API support, a benchmark
methodology review, Claude 5 API compatibility applied, live model access
verified, the first paid synthetic generation run diagnosed and fixed, and
its flawed 60-case corpus removed pending regeneration; the rest of the paid
eval programme and deployment work are outstanding
Current branch: main
Last known green commit: 407af31 (`post mortem fixes`). The working tree on
top of it removes the collapsed-plan synthetic corpus and its split entries,
updates these docs, and makes `tests/experiment.test.ts` independent of the
caller's `ALLOW_PAID_EVALS`; it was validated as below.
Last validation run: 2026-09-16 - `pnpm lint`, `pnpm typecheck`, `pnpm test`
(198 passing), `pnpm eval:splits --check` (56 assigned, after the corpus
removal) pass on the current tree. Earlier the same day, before the removal,
`pnpm build`, `pnpm test:e2e` (6 passing) and `pnpm eval:smoke` (24 cases,
offline) also passed; none of them reads `generated.jsonl`. A
live two-case sequential run against `claude-sonnet-5` and `claude-opus-5`
also passed (see below). No paid call was made while diagnosing the
generation run; `ALLOW_PAID_EVALS` stayed `false`.

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
- Live API smoke (2026-09-16): run
  `20260916T061945Z-seed-holdout-support-v1-adajy`, generation on
  `claude-sonnet-5` and judging on `claude-opus-5`, prompt `support-v1`,
  judge prompt `judge-rubric-v2`, sequential execution. 2 cases, 0 errors,
  judge coverage 100%, deterministic pass rate 100%, 6810 input / 1084 output
  tokens, estimated cost $0.0498. A smoke test only, not a benchmark
  artifact. It confirms that billing works, that the Claude 5 call paths no
  longer 400 on sampling parameters, and that `judge-rubric-v2` has now been
  validated against a live model end to end.
- Synthetic generation post-mortem (2026-09-16): the first paid
  `eval:generate` run submitted 51 batch requests for 400 planned cases and
  kept 60, at $0.5433. Root causes, all fixed and covered by
  `tests/generation-diagnostics.test.ts`: a flat `max_tokens: 2000` truncated
  most replies; `extractJsonObject` discarded the complete cases beside the
  cut-off one; `rejected` was incremented by a failed reply's *planned* count,
  which is where "288 rejected" and "348 returned" came from; `EVAL_MAX_CASES`
  was applied after the cases were paid for, silently dropping 52; and
  `planBatches` indexed category, angle and difficulty off one counter so the
  plan collapsed to ~8 distinct prompts. `eval:generate` now prints and
  persists a rejection breakdown. Details in `docs/DECISIONS.md`.

## Outstanding paid work

The Anthropic Console balance is funded with US$20 and live access is
confirmed. `ALLOW_PAID_EVALS` is still `false` by default, so every paid run
opts in explicitly and stays bounded by `EVAL_MAX_SPEND_USD`.

Still to run against a live model:

- synthetic corpus generation (ran once, under-delivered; its 60 cases were
  removed on 2026-09-16 and regeneration under the fixed plan is pending; see
  the post-mortem)
- prompt optimization (candidate search, dev split only)
- held-out benchmark
- adversarial-holdout benchmark
- real replay fixtures

Exact commands, in order:

```bash
# 1. Credit is already funded at console.anthropic.com -> Billing.
export ANTHROPIC_API_KEY=...
export ALLOW_PAID_EVALS=true
export EVAL_MAX_SPEND_USD=25          # enforced against real tracked spend
export EVAL_USE_BATCH_API=true        # half cost, queued not real-time

# 2. Free sanity checks first.
pnpm eval:splits --check
pnpm eval:generate --plan
pnpm eval:run --dataset human --max-cases 6              # offline, no cost

# 3. DONE 2026-09-16, run 20260916T061945Z-seed-holdout-support-v1-adajy.
#    Smallest possible live call, to confirm billing works.
pnpm eval:run --dataset seed --mode live --max-cases 2 --execution sequential

# 4. Corpus, then splits are assigned automatically for the new cases.
#    RAN 2026-09-16 and under-delivered (60 of 400); causes fixed since and
#    those 60 cases removed, so generated.jsonl is absent until this reruns.
#    Unset EVAL_MAX_CASES first or the plan is trimmed to it, confirm the
#    generator prints "0 existing case(s) will be preserved", and check the
#    printed rejection breakdown before trusting the yield.
pnpm eval:generate --plan --ordinary 200 --edge 100 --adversarial 100
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

## Open questions from the generation post-mortem

- The 60 synthetic cases produced under the collapsed plan (roughly eight
  distinct prompts) were removed on 2026-09-16 along with their split
  entries; `evals/datasets/splits.json` is back to the 56 human assignments
  from commit 8d91234, unchanged. `generated.jsonl` does not exist until the
  corpus is regenerated, which is a paid operation and has not been run. See
  `docs/DECISIONS.md` for why removal rather than keeping them.
- `.env` currently sets `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` and
  `EVAL_MAX_CASES=60`, neither of which matches the documented paid sequence
  (`claude-sonnet-5`, no case cap). The $0.5433 cost of the generation run is
  consistent with Sonnet 5 at the Batch API rate, not with Haiku at that rate,
  so `.env` was most likely changed after the run. Confirm which model
  produced `generated.jsonl` before quoting the corpus provenance anywhere.

## Next recommended task

1. Regenerate the synthetic corpus under the fixed plan (paid). The flawed
   60 cases are gone, so the generator starts from an empty corpus and every
   accepted case gets a fresh split assignment. Before running: unset
   `EVAL_MAX_CASES` (`.env` currently sets it to 60, which would cap the plan
   to 60 again) and set `ANTHROPIC_MODEL` to the documented generation model
   (`.env` currently names Haiku 4.5). The previous run cost $0.5433 for what
   should now cost about the same and yield several hundred. Then run the
   remaining paid sequence from step 4 onward and commit
   `evals/datasets/generated.jsonl`, `evals/datasets/splits.json` and the
   `evals/benchmarks/` artifacts. Review a sample of synthetic case labels by
   hand; they are written by the model under test.
2. Independently of the paid work, implement the persistent `UsageStore` backed by `DATABASE_URL`
   so public live inference can be enabled safely on multi-instance hosting.

## Relevant notes

- Splits are frozen in `evals/datasets/splits.json` (dev 28, heldout 16,
  adversarial-holdout 12 over the 56 human cases; the synthetic entries were
  removed with their cases on 2026-09-16). Adding a case
  requires `pnpm eval:splits`. Because assignment is incremental and frozen, a
  from-scratch rebuild does *not* reproduce the manifest once a group has
  grown; the tests assert reassignment is a no-op and that each group stays
  near its dev fraction instead. See `docs/DECISIONS.md`.
- Sampling parameters are omitted, not defaulted: `claude-sonnet-5` and
  `claude-opus-5` reject `temperature`, `top_p` and `top_k` with a 400, and
  use adaptive thinking rather than `budget_tokens`. Eval runs still ask for
  `DETERMINISTIC_TEMPERATURE`, which reaches only models that accept it, so
  Claude 5 runs sample at the model default and the run record says so.
- Offline runs carry no rubric scores and fail the `judge-coverage` gate by
  design; `eval:smoke` enforces only the deterministic and generation-success
  gates offline.
- `evals/benchmarks/latest.json` does not exist yet and must never be created
  by hand.
- `evals/results/pending/` holds resumable batch manifests; `evals/results/`
  is gitignored.
- `.agents/`, `.claude/` and `skills-lock.json` are untracked user tooling and
  are excluded from commits.
