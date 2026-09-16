# DECISIONS

Implementation decisions not dictated by `PROJECT_SPEC.md`.

## 2026-09-16 - Conservative dependency pinning

**Decision.** Pin Next 16.3.5, React 19.3.0, TypeScript 5.9.3, Zod 4.6.5,
ESLint 9.39.5, Vitest 3.2.7, Tailwind 4.3.3, `@anthropic-ai/sdk` 0.126.0,
`langfuse` 3.39.2. Bleeding-edge majors (TypeScript 7, Vitest 5, ESLint 10)
were rejected.

**Why.** `eslint-config-next@16` and the Next toolchain are only validated
against these majors. The spec forbids mid-build major upgrades, so the
starting point should be the version set least likely to force one.

## 2026-09-16 - ESLint flat config consumed directly from eslint-config-next

**Decision.** `eslint.config.mjs` spreads `eslint-config-next`'s exported flat
config array. The `@eslint/eslintrc` `FlatCompat` route was removed, and the
project adds no rule overrides of its own.

**Why.** `FlatCompat` crashed with a circular-structure error against this
version of the config. Overrides also failed because the TypeScript plugin is
registered inside the shared config's own objects, not globally.

## 2026-09-16 - Support policy is read from markdown at runtime

**Decision.** `src/domain/support-policy.md` is read with `fs` at first use and
embedded into the support, judge, generator and optimizer prompts.
`next.config.ts` traces it (and `data/replays/`, `evals/datasets/`,
`evals/benchmarks/`) into the server bundle.

**Why.** The spec makes the markdown file authoritative. Duplicating it into
TypeScript would create a second source of truth that silently drifts.

## 2026-09-16 - Offline runs carry no rubric scores

**Decision.** `eval:run` and `eval:smoke` default to an offline mode backed by
a deterministic stub generator (`src/evals/offline-generator.ts`). Offline runs
produce deterministic evaluator verdicts only; rubric means are reported as
`n/a`, and rubric-based promotion gates fail as "no measurement".

**Why.** The pipeline, validation, metrics and reporting paths need coverage
without paid calls, but a rubric mean that did not come from a judge would be
an invented benchmark number. A gate with no measurement must not pass.

## 2026-09-16 - Cost is unavailable rather than estimated

**Decision.** `EVAL_MAX_SPEND_USD` is enforced against *tracked actual* usage,
which requires an operator-supplied `evals/pricing.json`. Without it, cost is
reported as "unavailable (no pricing configured)" and runs are bounded by
`EVAL_MAX_CASES` and token limits.

**Why.** The spec forbids inventing a precise estimate when a reliable one is
unavailable. Hard-coding model prices into the repository would do exactly
that, and they go stale.

## 2026-09-16 - Replay fixtures are authored and carry no judge scores

**Decision.** The six fixtures in `data/replays/` are explicitly authored
(`source: "authored"`) and contain no `rubric`. The demo therefore shows
"evaluation unavailable" for replays. Deterministic guardrails are recomputed
at read time rather than stored.

**Why.** The spec permits authored fixtures but forbids invented evaluation
results. An authored rubric score would be a fabricated judge result presented
as a measurement. Recomputing guardrails keeps fixtures honest if the rules
change.

## 2026-09-16 - Benchmarks are written only by `eval:compare --write-benchmark`

**Decision.** No separate benchmark command was added; `eval:compare` gained a
`--write-benchmark` flag that writes an immutable snapshot plus
`evals/benchmarks/latest.json`. `latest.json` is absent until a real run
produces it, and the engineering view says so plainly.

**Why.** The spec fixes the command list and forbids duplicate commands under
different names. A benchmark is a persisted comparison, so it belongs to the
comparison step.

## 2026-09-16 - Experiment results are gitignored

**Decision.** `evals/results/*.json` is gitignored; `evals/candidates/`,
`evals/benchmarks/` and the datasets are tracked.

**Why.** Run records are machine-local working artifacts produced on every
offline run. Benchmarks are the durable, reviewable output. Keeping runs out of
git avoids noise without losing anything reproducible.

## 2026-09-16 - Rate limiting and usage counting are in-memory

**Decision.** `InMemoryRateLimiter` and `InMemoryUsageStore` back the public
endpoint. `clientIdentifier` returns a salted SHA-256 hash and reports whether
it is stable. The persistent `DATABASE_URL`-backed `UsageStore` is not
implemented.

**Why.** The spec says not to require a database for the MVP. The limitation is
documented in the README: on multi-instance hosting these cannot enforce a true
global cap, so public live inference should stay disabled until a persistent
store exists.

## 2026-09-16 - Agent toolkit directories are untracked, not gitignored

**Decision.** `.agents/`, `.claude/` and `skills-lock.json` were left untracked
and excluded from commits. They are excluded from ESLint.

**Why.** They are user-installed tooling, not project source, but whether they
belong in this repository is the maintainer's call, not the agent's.

## 2026-09-16 - Model defaults centralised, judge stronger than generator

**Decision.** `src/config/env.ts` defines `DEFAULT_GENERATION_MODEL =
"claude-sonnet-5"` and `DEFAULT_JUDGE_MODEL = "claude-opus-5"`. Both are
overridable by `ANTHROPIC_MODEL` / `ANTHROPIC_JUDGE_MODEL`. Live mode now
turns on with an API key alone, since both roles resolve.

**Why.** The spec forbids hard-coding a model *throughout* the codebase, not
having one default in the configuration module. The previously configured ids
(`claude-3-5-sonnet-20240620`, `claude-3-5-haiku-20240307`) were retired and
would have failed at the first call. A judge from the same family as the
generator is prone to self-preference bias, so the judge defaults one tier
above the generator.

## 2026-09-16 - Pricing populated; cost enforcement is now real

**Decision.** `evals/pricing.json` carries current Anthropic rates: Sonnet 5
$2/$10, Opus 5 $5/$25, Haiku 4.5 $1/$5 per million input/output tokens. A
model with no entry is still reported as unpriced rather than free.

**Why.** `EVAL_MAX_SPEND_USD` was inert without pricing. Rates live in one
data file rather than in code so they can be corrected without a release, and
the "unpriced, not free" rule still prevents a silent zero.

## 2026-09-16 - Batch API for offline runs only

**Decision.** `src/ai/client/batch.ts` wraps Message Batches behind a
`BatchModelClient` interface. `eval:run`, `eval:generate` and
`prompt:optimize` accept `--execution batch` and honour `EVAL_USE_BATCH_API`.
`eval:run` submits a generation batch, a retry batch for malformed output,
then a judge batch. Batch usage is costed at 50%. `/api/respond` never
batches.

**Why.** Batches halve the cost of the full 400-500 case corpus, which matters
on a fixed credit balance. They are queued rather than real-time, so they are
wrong for a public demo request. A separate interface keeps the sequential
path unchanged and lets both be tested against fakes; tests assert the two
paths produce identical case results.

**Known gaps.** Batches above the 100,000-request limit are refused with a
clear error rather than chunked (recorded in `docs/TASKS.md`). Resume after a
poll timeout was added later; see the pending-manifest decision below.

## 2026-09-16 - Frozen dataset splits: dev, heldout, adversarial-holdout

**Decision.** Every eval case carries a split in `evals/datasets/splits.json`,
assigned once by `pnpm eval:splits` and never moved. Assignment is stratified
within (category, adversarial) groups in `sha256(id)` order: 60% of ordinary
cases and 50% of adversarial cases go to `dev`; the rest go to `heldout` or
`adversarial-holdout`. `eval:run` defaults to `--split holdout`.
`prompt:optimize` is pinned to `dev` and rejects `--split`. A case with no
assignment fails any run that loads it. `eval:generate` assigns splits to new
synthetic cases as it writes them.

**Why.** Before this, the optimizer proposed candidates from failures on the
same cases it was then scored on, and the proposer saw the case inputs
verbatim. A benchmark produced that way measures memorisation. A manifest, not
a hash rule alone, so that assignments are auditable in a diff and stay fixed
when cases are added. A new command rather than a flag because assigning
splits is a distinct, unpaid operation and the spec's rule is against
duplicate commands for the same operation.

**Alternatives considered.** A `split` field on every case (touches every row
and the spec's schema); hash-only assignment with no manifest (not stratified,
not auditable); letting the optimizer use `--split` with a warning (a warning
is not isolation).

**Consequences.** With 56 human cases the held-out sets are small (16 + 12)
until the synthetic corpus exists. Adding a human case now requires running
`pnpm eval:splits`.

## 2026-09-16 - Aggregates are per case, errors are failures, gates need full coverage

**Decision.** `computeMetrics` reports pass rates per case: a case passes only
when every applicable deterministic check passed, and a case with no valid
output counts as a failure in every rate. An evaluator with no verdicts
reports no measurement (previously a pass rate of 1). Rubric means carry
judged count and coverage, and a rubric gate fails unless every case was
judged. Two gates were added: generation-success-rate (must be 1) and
judge-coverage (must be 1). A generation that never produced valid output
records a failing `structured-output-validity` verdict. Judge failures record
`judgeError` on the case. Comparisons flag rubric-score drops of 20 points or
more as regressions.

**Why.** An errored case previously had an empty verdict list and no rubric,
so it vanished from every denominator; a judge that failed on the hardest
cases raised the mean. Per-verdict rates let one leaked prompt in an
adversarial case count as 75% passing. `structured-output-validity` could
never fail inside a run because the output was already parsed, so it was a
free pass on every case.

**Consequences.** Offline runs now fail the judge-coverage gate explicitly
(they have no judge), which `eval:smoke` does not enforce offline. Real
benchmark numbers will be lower than the old computation would have given
for the same run, and that is the point.

## 2026-09-16 - Judge prompt v2 and judge-manipulation indicators

**Decision.** `judge-rubric-v2` replaces v1 as the active judge prompt via
`ACTIVE_JUDGE_PROMPT`; v1 is retained. v2 asks for each rationale before its
score, anchors all four dimensions, treats the customer message and the
response as untrusted, treats the response's own `policyReferences` and
`escalationReason` as claims to verify, names evaluator-directed text as
manipulation with a scoring consequence, scores compliance with an injected
instruction as 1, and says length is not quality. Delimiter look-alikes in
both blocks are escaped by `wrapUntrusted` (also applied to the generation
input). A deterministic `judge-manipulation-indicators` evaluator records
evaluator-directed phrasing. Runs record judge prompt id and hash, judge
model, and generation/judge sampling parameters.

**Why.** Score-before-rationale makes the rationale a post-hoc justification;
unescaped delimiters let a response close its own block and address the
judge; unanchored dimensions score inconsistently; the judge prompt id was
returned by the judge but never stored, so a change to the judge prompt would
have been invisible in the results. The judge deliberately does not see the
case's `expectedBehaviour`: reference-guided grading is more reliable on
ambiguous cases but anchors on the author's expectation, and the escalation
expectation is already enforced deterministically. Recorded in the README as
a limitation.

**Consequences.** No live run has used either judge prompt yet, so there is no
score continuity to break. When one exists, changing the judge prompt again
means a new version and a fresh baseline.

## 2026-09-16 - Comparisons and benchmarks must be like-for-like

**Decision.** `compareRuns` checks case id sets, dataset hash, split, mode,
generation model, judge model, judge prompt id and execution, and sets
`comparable: false` on any hard mismatch. `eval:compare --write-benchmark`
refuses a non-comparable comparison unless `--allow-mismatch` is passed; the
warnings are stored in the snapshot either way, and a benchmark from the
`dev` or `all` split carries a warning that held-out results are needed.
Benchmarks now record per-run provenance: prompt id, version, hash and
source, candidate id, models, judge prompt id, execution, timestamps, token
usage, cost with the pricing snapshot used, and gate results. Run ids include
the split. Every run records `datasetHash`, `promptHash`, `gitCommit` and
sampling parameters.

**Why.** The old check compared dataset name and size only, so two runs over
different eight-case subsets of the same dataset, or with different judge
models, would have been averaged into one benchmark. The spec requires the
benchmark to identify the exact dataset and prompts; a name does not do that.

## 2026-09-16 - Batch runs are resumable from a pending manifest

**Decision.** A batch run writes `evals/results/pending/<run-id>.json` before
submitting anything, containing the exact cases, prompt text, judge prompt id
and configuration, and rewrites it with each batch id the moment that stage
is submitted. `eval:run --resume <run-id>` collects the recorded batches and
continues from the next stage without resubmitting; `--pending` lists them.
`eval:generate --resume <batch-id>` does the same for its single batch. The
manifest is removed once the run record is written. A single `UsageTracker`
budget is shared across every run in `prompt:optimize`, with per-run trackers
forwarding to it; the batch discount is applied at the call site.

**Why.** The previous timeout error told the operator to rerun with a
`--batch-id` flag that did not exist, and a killed process lost the batch id
entirely, leaving paid results uncollected. The spend cap was per run, so an
optimization could spend five times `EVAL_MAX_SPEND_USD`. A tracker with a
built-in discount could not be shared between batch runs and the sequential
proposal call.

**Consequences.** A `prompt:optimize` run interrupted mid-way is not resumed
as a whole: its candidate runs are resumed individually with `eval:run
--resume` and the comparison is reproduced with `eval:compare`.

## 2026-09-16 - Cost is unavailable when any model used is unpriced

**Decision.** `UsageTracker.estimatedCostUsd` is undefined if any recorded
model has no pricing entry, and the run record lists `unpricedModels`. Tokens
spent on failed generation attempts and unusable judge replies are counted.

**Why.** With a priced generator and an unpriced judge the old tracker
reported the generator's cost as the run's cost, and `EVAL_MAX_SPEND_USD` was
enforced against that partial figure. Retry attempts and malformed judge
replies were billed by Anthropic but not tracked.

## 2026-09-16 - Sampling parameters are omitted, not defaulted

**Decision.** `src/ai/client/model-capabilities.ts` owns one predicate,
`supportsSamplingParams(model)`, and both Anthropic clients spread
`samplingParamsFor(model, { temperature })` into the request rather than
setting a field. Nothing is sent unless a caller asked for a value *and* the
model accepts one. The predicate is an allow-list of models that still take
sampling parameters (Opus/Sonnet 4.0-4.6, Haiku 4.x, Claude 3.x); every other
identifier, including one this code has never seen, is treated as a model
that has removed them. Manual thinking configuration is never sent: Claude 5
uses adaptive thinking, and `thinking: { type: "enabled", budget_tokens: N }`
is rejected the same way. Eval runs still *ask* for `temperature: 0` through
`DETERMINISTIC_TEMPERATURE`, so a model that honours it stays reproducible.

**Why.** The first live Sonnet 5 smoke request failed with `400
invalid_request_error: temperature is deprecated for this model` before
consuming any tokens. Both clients defaulted the field to `0` whenever a
caller omitted it, so every call path — request, judge, synthetic generation,
prompt optimization, and Batch API payloads — carried a parameter the current
models reject. An allow-list rather than a deny-list of Claude 5 ids is the
direction that fails safe: omitting the field is accepted by every model,
sending it to one that has removed it fails the whole request, and model ids
are environment-overridable.

**Consequences.** Run records report the sampling that was actually sent:
`generationParams.temperature` and `judgeParams.temperature` are now optional
and absent on Claude 5, where the run used the model's own default. Runs on
those models are therefore not bit-reproducible, which the record now states
rather than implying otherwise with a `temperature: 0` that never left the
process. Benchmark methodology and model selection are unchanged.
`tests/model-compat.test.ts` asserts on the payloads that reach the SDK, so a
reintroduced `temperature`, `top_p`, `top_k` or `thinking` field fails
offline instead of on the first paid call.
