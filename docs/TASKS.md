# TASKS

Shared implementation checklist. Tasks map to `PROJECT_SPEC.md` requirements.

## Phase 0 - Repository agent setup
- [x] Create `AGENTS.md`, `CLAUDE.md`
- [x] Create `docs/BUILD_STATE.md`, `docs/DECISIONS.md`, `docs/TASKS.md`

## Phase 1 - Application scaffold
- [x] Next.js + TypeScript + Tailwind + pnpm scaffold
- [x] Environment validation module
- [x] `GET /api/health`
- [x] Basic homepage
- [x] lint / typecheck / test / build pass

## Phase 2 - Generation pipeline
- [x] `src/domain/support-policy.md`
- [x] Versioned support prompts + registry
- [x] Anthropic server client (generation + judge boundaries)
- [x] Structured `SupportResponse` output with Zod
- [x] `POST /api/respond` orchestration

## Phase 3 - Evaluation foundation
- [x] Eval case schema + loader
- [x] Seed dataset (human-authored)
- [x] Adversarial dataset
- [x] Deterministic evaluators
- [x] Rubric judge (`judge-rubric-v2` active; never exercised against a live model)
- [x] Automated quality score

## Phase 4 - Durable eval assets
- [x] `pnpm eval:generate` (implemented; a real generated corpus is BLOCKED on credentials)
- [x] `pnpm eval:run`
- [x] `pnpm eval:compare`
- [x] `pnpm prompt:optimize`
- [ ] Real benchmark artifacts (BLOCKED: needs credentials + `ALLOW_PAID_EVALS=true`)

## Phase 5 - Guardrails
- [x] Input validation
- [x] Injection heuristics
- [x] PII redaction
- [x] Output authority/leakage checks

## Phase 6 - Observability
- [x] Langfuse abstraction + no-op fallback
- [x] Spans for guardrails/generation/evaluation
- [x] Token, latency, cost metadata

## Phase 7 - Public demo UI
- [x] Homepage demo experience

## Phase 8 - Engineering View
- [x] `/engineering` dashboard

## Phase 9 - Replay and cost controls
- [x] Replay Mode + fixtures
- [x] Rate limits, daily global limit, live-mode switch, timeouts, token caps

## Phase 10 - Test and CI hardening
- [x] Unit + integration tests
- [x] Playwright E2E
- [x] GitHub Actions CI
- [x] Offline eval smoke test

## Phase 11 - Documentation and deployment
- [x] README
- [x] Deployment documentation
- [ ] Vercel deploy (BLOCKED: requires `ALLOW_DEPLOY=true` + credentials)

## Cost and throughput
- [x] Model defaults centralised in `src/config/env.ts` (`claude-sonnet-5`
      generation, `claude-opus-5` judge), both environment-overridable
- [x] `evals/pricing.json` populated with current Anthropic rates
- [x] Batch API client (`src/ai/client/batch.ts`)
- [x] Batch execution for `eval:run` (generation + retry + judge batches)
- [x] Batch execution for `eval:generate`
- [x] Batch execution for `prompt:optimize`
- [x] Batch runs costed at the 50% Batch API rate
- [ ] Chunk batches above the 100,000-request limit (currently refuses with a
      clear error; the corpus is far below the limit)
- [x] Resume a batch run after the polling process exits or times out
      (`eval:run --resume <run-id>`, `eval:run --pending`,
      `eval:generate --resume <batch-id>`; pending manifests under
      `evals/results/pending/`)
- [x] One shared spend budget across every run in `prompt:optimize`

## Benchmark methodology (review of 2026-09-16)
- [x] Frozen dataset splits (`dev`, `heldout`, `adversarial-holdout`) in
      `evals/datasets/splits.json`; `pnpm eval:splits` assigns new cases
- [x] `eval:run --split` (default `holdout`); `prompt:optimize` pinned to `dev`
      and refuses `--split`; reused baselines must be live dev-split runs of
      the same prompt over the same cases
- [x] Candidate prompts that quote dev-case text are rejected; the proposer is
      told not to special-case the sample
- [x] Per-case pass rates; errored cases fail every rate; no default pass when
      an evaluator never ran; rubric gates require full judge coverage;
      generation-success and judge-coverage gates
- [x] `structured-output-validity` records a failing verdict for a case with no
      valid output; judge failures record `judgeError`
- [x] Comparisons check case ids, dataset hash, split, mode, models and judge
      prompt; `--write-benchmark` refuses non-comparable runs unless
      `--allow-mismatch`; rubric-score drops of 20+ points are regressions
- [x] Benchmarks and runs carry provenance: split, dataset hash, prompt hash,
      judge prompt id and hash, models, sampling params, git commit, tokens,
      cost with pricing snapshot, gate results
- [x] Judge prompt v2: rationale before score, anchored dimensions, escaped
      delimiters, manipulation handling, policy references treated as claims
- [x] `judge-manipulation-indicators` deterministic evaluator
- [x] Cost unavailable when any model is unpriced; retry and malformed-judge
      tokens counted
- [x] `--max-cases` takes a stratified subset rather than a file-ordered prefix
- [ ] Human verification of synthetic case labels once `generated.jsonl`
      exists (labels are written by the runtime model under test)

## Outstanding follow-ups
- [ ] Persistent `UsageStore` backed by `DATABASE_URL` (required before enabling
      public live inference on multi-instance hosting; in-memory store cannot
      enforce a true global daily cap)
- [ ] Optional LLM injection classifier behind `ENABLE_LLM_INJECTION_CLASSIFIER`
      (spec marks it optional; the app works without it)
- [ ] Record replay fixtures from a real model run to replace the authored ones
      (BLOCKED: needs credentials)
- [ ] Add prompt versions v2/v3 once `prompt:optimize` has produced real
      candidates (BLOCKED: needs credentials)
