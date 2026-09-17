# BUILD STATE

Current phase: Phases 0-11 implemented, Batch API support, a benchmark
methodology review, Claude 5 API compatibility applied, live model access
verified, the synthetic corpus regenerated (398 cases), audited case by case
against the policy, corrected, pruned, given its one pre-use split
assignment, then refined (extraction convention, 12 holdout-leakage
deletions, 18 curated coverage cases) to 375 synthetic / 431 total; the
forbidden-claim evaluator no longer fails negated refusals.
The rest of the paid eval programme (held-out baseline, dev-only prompt
optimization, benchmarks) and deployment work are outstanding.
Current branch: main
Last known green commit: 407af31 (`post mortem fixes`). The working tree on
top of it holds the regenerated and corrected synthetic corpus, its split
manifest, the forbidden-claim evaluator change with its tests, and these
docs; it was validated as below.
Last validation run: 2026-09-17 (after the pre-freeze refinement) - `pnpm
lint`, `pnpm typecheck`, `pnpm test` (233 passing, 21 files), `pnpm build`,
`pnpm eval:smoke` (offline, passed; rubric gates fail by design with no
judge) and `pnpm eval:splits --check` (431 assigned: dev 229, heldout 133,
adversarial-holdout 69) all pass on the current tree. No model call was made and `ALLOW_PAID_EVALS` stayed `false`.
The `pnpm build` run rewrote `next-env.d.ts` to the production type paths;
that file was reverted and is not part of the change.

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
- Synthetic corpus regenerated (2026-09-16, batch
  `msgbatch_015VVSuzgRU4Gsi5QpcgPhBc`, `case-generator-v2`): 400 planned,
  400 returned, 398 accepted, 2 within-run duplicates, all 51 requests
  complete, $0.5129. Record: `evals/results/20260916T213838Z-generate.json`.
- Synthetic corpus audit and remediation (2026-09-17, no model calls): every
  case read against the policy; 129 category, 6 adversarial and 86
  escalation-label corrections, 38 expectation rewrites, 4 forbidden-claim
  rewrites, 29 deletions, no `input` changed. The generator's split entries
  were discarded (stratified on wrong labels, never committed, never used)
  and the corrected 369 cases were assigned once; the 56 human entries are
  byte-identical to HEAD. `forbidden-claim-detection` now excuses negated
  refusals and attributed quotations. Details in `docs/DECISIONS.md`.
- Pre-freeze refinement (2026-09-17, no model calls): pure secret-extraction
  cases set to `escalationRequired: false` (22); 12 synthetic dev cases that
  reproduced a human adversarial-holdout attack and scenario deleted; 18
  curated coverage cases added (PII echo, 14-day boundary, non-English,
  hostile tone, judge manipulation, forwarded-content injection) and
  hash-assigned. No existing assignment moved; human entries unchanged.

## Outstanding paid work

The Anthropic Console balance is funded with US$20 and live access is
confirmed. `ALLOW_PAID_EVALS` is still `false` by default, so every paid run
opts in explicitly and stays bounded by `EVAL_MAX_SPEND_USD`.

Still to run against a live model:

- (done) synthetic corpus generation, 2026-09-16, 398 accepted; audited and
  corrected to 369 on 2026-09-17
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

# 4. DONE 2026-09-16 (398 accepted) and audited/corrected 2026-09-17 (369).
#    Do NOT rerun eval:generate on top of this corpus without a decision:
#    it appends, and new cases are split-assigned by hash on arrival.
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

## Open questions

- `.env` currently sets `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` and
  `EVAL_MAX_CASES=60`. The 2026-09-16 regeneration cost ($0.5129 for 70,198
  input / 88,543 output tokens at the batch rate) is consistent with Sonnet 5,
  not Haiku, so `.env` was most likely changed after the run. Confirm which
  model produced `generated.jsonl` before quoting corpus provenance.
- The corpus is still narrower than its size (about 15 scenario families).
  Dev twins of the human adversarial-holdout scenarios were deleted, so the
  human holdout now tests attack patterns the dev split does not contain at
  scenario level; the synthetic adversarial-holdout still shares templates
  with dev and should be described that way in the benchmark write-up.
- Labels were corrected by a model audit (Fable 5.1), not by a person. A
  human spot-check is still open before the corpus is declared final.

## Next recommended task

1. Human spot-check of the corrected synthetic labels (a stratified sample
   across the seven categories and both adversarial values, including the
   18 curated cases), then commit `evals/datasets/generated.jsonl`,
   `evals/datasets/splits.json`, the evaluator change and
   `tests/splits.test.ts` in one commit. That commit is the freeze point. Do not edit any synthetic `input`: the
   id is a hash of it and the assignment would be orphaned; fix labels in
   place or delete.
2. Then the paid sequence from step 5: held-out baseline of `support-v1`,
   dev-only `prompt:optimize`, held-out candidate run, `eval:compare
   --write-benchmark`. State in the benchmark write-up that the adversarial
   holdout shares templates with dev.
3. Independently of the paid work, implement the persistent `UsageStore`
   backed by `DATABASE_URL` so public live inference can be enabled safely on
   multi-instance hosting.

## Relevant notes

- Splits are frozen in `evals/datasets/splits.json`: 431 cases, dev 229,
  heldout 133, adversarial-holdout 69 (human: dev 28, heldout 16,
  adversarial-holdout 12, unchanged since 8d91234; synthetic: dev 201,
  heldout 117, adversarial-holdout 57, assigned on 2026-09-17 in one pass
  plus the 18 curated additions). Deleting from dev after assignment shifts
  a group's dev share and is recorded in `tests/splits.test.ts`. Adding
  a case requires `pnpm eval:splits`. Because assignment is incremental and frozen, a
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
