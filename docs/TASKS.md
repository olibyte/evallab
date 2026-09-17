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
- [x] `pnpm eval:generate` (implemented; first paid run 2026-09-16 yielded 60
      of 400 planned cases - causes fixed, see the post-mortem section below)
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
- [x] Claude 5 API compatibility: no `temperature`/`top_p`/`top_k` and no
      manual thinking configuration on any Anthropic call path, including
      Batch API payloads; text selected by content-block type; regression
      tests assert on the payloads reaching the SDK
- [x] Full audit of synthetic case labels against the support policy
      (2026-09-17, Fable 5.1, every case read; corrections in
      `docs/DECISIONS.md`). Labels were written by the runtime model family
- [ ] Human spot-check of the corrected synthetic labels before the corpus is
      declared final

## Synthetic generation post-mortem (run of 2026-09-16)
- [x] Surface `stopReason` on `ModelCallResult` and `BatchItemResult` so a
      reply cut off at the output ceiling is distinguishable from a malformed one
- [x] Budget the output ceiling per case (`outputTokenBudget`) instead of a
      flat 2000 for any batch size
- [x] Salvage the complete cases from a truncated reply
      (`salvageJsonArrayItems`); each one still passes `evalCaseSchema`
- [x] Count request outcomes in requests and case rejections in candidates;
      stop adding a failed reply's planned count to `rejected`
- [x] Report schema failures by field path
- [x] Persist the breakdown to `evals/results/<stamp>-generate.json`
- [x] Apply `EVAL_MAX_CASES` to the plan before submission
      (`trimPlanToCaseLimit`), not to results already paid for
- [x] Decorrelate category, angle and difficulty in `planBatches`; adversarial
      batches now reach all seven categories
- [x] `case-generator-v2` with an explicit, length-bounded output contract
      (v1 retained)
- [x] Remove the 60 collapsed-plan cases and their split entries
      (2026-09-16; `generated.jsonl` deleted, `splits.json` restored to the
      56 human assignments from 8d91234, unchanged)
- [x] Regenerate the synthetic corpus under the fixed plan (2026-09-16,
      batch run: 400 planned, 400 returned, 398 accepted, 2 within-run
      duplicates, $0.5129)

## Synthetic corpus audit remediation (2026-09-17)
- [x] `forbidden-claim-detection` excuses negated refusals and attributed
      quotations; genuine assertions and unattributed quoted claims still fail
      (`src/ai/evaluators/forbidden-claims.ts`, `tests/forbidden-claims.test.ts`)
- [x] Escalation labels corrected under one written rule (86 changes)
- [x] Category corrected from content (129), adversarial flags fixed (6)
- [x] `expectedBehaviour` entries that asserted non-policy facts rewritten (38);
      overly broad or dead `forbiddenClaims` fixed (4)
- [x] 27 audit deletions plus 2 dev-side twins of heldout cases; no `input` edited
- [x] Synthetic split entries discarded and assigned once on the corrected
      corpus; 56 human entries verified unchanged; assignments frozen from here
- [x] Coverage cases for pasted PII / full card numbers, the exact 14-day
      boundary, non-English messages, hostile tone, judge-directed requests,
      forwarded-content injection (18 curated cases, hash-assigned splits)
- [x] Secret-extraction convention: pure extraction attempts carry
      `escalationRequired: false` (22 changes)
- [x] Adversarial-holdout leakage review at the attack-family level; 12 dev
      twins of human holdout scenarios deleted, not moved
- [x] `tests/splits.test.ts` dev-fraction guard accounts for documented dev
      deletions instead of loosening its slack
- [ ] Commit `evals/datasets/generated.jsonl`, `evals/datasets/splits.json`,
      the evaluator change and the test change together (the freeze point)

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
