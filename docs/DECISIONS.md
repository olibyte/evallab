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
clear error rather than chunked, and a batch that outlives its poll timeout
must currently be collected by hand (the error prints the batch id). Both are
recorded in `docs/TASKS.md`.
