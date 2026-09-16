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
