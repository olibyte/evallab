# EvalLab

## What is EvalLab?

EvalLab is a support assistant for a fictional SaaS product, **AcmeCloud**,
built so that its quality, safety and behaviour can be inspected rather than
asserted. Every response passes through guardrails, structured-output
validation and rubric-based evaluation, and the same machinery runs offline
over a versioned eval dataset so prompt changes can be measured instead of
guessed at.

The assistant performs no real support actions. It has no access to accounts,
billing, payments or identity systems, and it cannot issue a refund or cancel
a subscription.

## Live demo

Not currently deployed. Deployment is gated on `ALLOW_DEPLOY=true` plus Vercel
credentials; see [Deployment](#deployment). The application runs locally with
no credentials at all — see [Replay Mode](#replay-mode).

## What it demonstrates

- A production-shaped LLM request pipeline with explicit stages
- Structured model output validated with Zod, never trusted on faith
- Deterministic guardrails separated from LLM-as-judge evaluation
- A versioned prompt registry with an explicitly selected production prompt
- An eval dataset, experiment runner, prompt comparison and candidate search
- Paid-execution controls so a coding agent cannot burn API credit by accident
- Replay Mode, so the site stays useful with no API key

## Architecture

```mermaid
flowchart TD
    U[User message] --> V[Zod request validation]
    V --> G[Input guardrails<br/>injection heuristics, PII redaction]
    G --> GEN[Generation<br/>active support prompt + generation model]
    GEN --> S[Structured output validation<br/>SupportResponse]
    S --> OG[Output guardrails<br/>authority + leakage checks]
    OG --> E[Rubric judge<br/>one consolidated call]
    E --> R[API response]
    G -.-> O[(Observability<br/>Langfuse or no-op)]
    GEN -.-> O
    OG -.-> O
    E -.-> O

    subgraph Offline[Offline evaluation]
        D[(evals/datasets/*.jsonl)] --> RUN[eval:run]
        RUN --> RES[(evals/results/)]
        RES --> CMP[eval:compare]
        CMP --> BM[(evals/benchmarks/)]
        RES --> OPT[prompt:optimize]
        OPT --> CAND[(evals/candidates/)]
    end
```

Layout:

| Path | Purpose |
| --- | --- |
| `app/` | Routes: demo page, engineering view, `/api/respond`, `/api/health` |
| `src/ai/` | Client, generation, guardrails, evaluators, prompts, pipeline |
| `src/domain/support-policy.md` | Authoritative support policy |
| `src/evals/` | Datasets, runner, metrics, comparison, optimization, benchmarks |
| `src/observability/` | Trace abstraction with Langfuse and no-op implementations |
| `src/replay/` | Replay fixture loading and response construction |
| `src/usage/` | Usage store and rate limiting |
| `evals/` | Datasets, candidates, results, benchmark snapshots |
| `data/replays/` | Replay fixtures |
| `scripts/` | The eval and optimization CLIs |

## How requests are processed

1. **Validate** the request with Zod: non-empty message, 2000-character cap.
2. **Input guardrails**: deterministic prompt-injection heuristics return a
   `detected` flag, a `low`/`medium`/`high` risk and categories. Detection is
   diagnostic and never rejects the request. PII is redacted for logging; the
   model still receives the original message.
3. **Generate** with the active support prompt and the configured generation
   model.
4. **Validate structured output** against the `SupportResponse` contract. One
   retry is allowed; a second failure is a hard error.
5. **Output guardrails**: deterministic checks for claims that a refund,
   cancellation or account change was performed, guaranteed refund outcomes,
   and system-prompt or credential leakage.
6. **Evaluate** with one consolidated rubric judge call, or report evaluation
   as unavailable.
7. **Trace** the request and return the response.

No stage is silently skipped. If the judge fails, the support response is
still returned and the evaluation is explicitly marked unavailable.

## Evaluation methodology

Two separate things, deliberately not conflated:

**Deterministic checks** run without a model and give an explicit pass/fail:

| Evaluator | Checks |
| --- | --- |
| `structured-output-validity` | Output conforms to the `SupportResponse` contract |
| `unauthorized-action-claims` | No claim of an action the assistant cannot perform |
| `prompt-leakage` | No system-prompt or credential disclosure indicators |
| `expected-escalation-match` | Escalation matches the eval case's expectation |
| `forbidden-claim-detection` | None of the case's forbidden phrases appear |

A check that does not apply to a case is labelled `not-applicable` rather than
counted as a pass.

**LLM-as-judge evaluation** scores four dimensions from 1 to 5 in a single
consolidated call: policy compliance, groundedness, helpfulness and tone.
Scores are converted to a 0–100 scale and weighted 30/30/25/15 into the
**Automated quality score**. That score is an automated signal, not objective
ground truth, and a deterministic **Guardrail failure** is always shown
separately so a high average cannot hide it.

Judge failures never produce fabricated scores.

## Guardrails

- **Input validation** — Zod schema, non-empty message, length cap.
- **Injection detection** — deterministic heuristics for instruction override,
  system-prompt and secret extraction, role change, developer impersonation,
  guardrail bypass and delimiter injection. The generation prompt
  independently frames customer text as untrusted.
- **PII logging hygiene** — `redactSensitiveText` redacts emails, telephone
  numbers and likely card numbers before anything is logged or traced.
- **Output validation** — model output is parsed and schema-checked before it
  is used.
- **Authority checks** — regex checks for performed-action and guaranteed
  outcome claims.

Regex checks are deterministic guardrails that complement the judge. They are
not a complete safety system.

## Prompt optimization

`pnpm prompt:optimize` is empirical candidate search, not automatic tuning:

1. Run a baseline over a fixed dataset.
2. Sample the failed cases.
3. Ask the model for 3–5 candidate system prompts with described changes.
4. Persist each candidate under `evals/candidates/<run-id>/`.
5. Evaluate every candidate on the same dataset.
6. Compare metrics and produce a recommendation.

A candidate is only ever *recommended*. Promotion requires all hard gates to
pass — policy compliance mean ≥ 4.5, groundedness mean ≥ 4.5,
unauthorized-action pass rate ≥ 99%, adversarial injection pass rate ≥ 95% —
and is always a manual source change: add a new immutable prompt version,
update `ACTIVE_SUPPORT_PROMPT`, record the decision in `docs/DECISIONS.md`,
and rerun the regression suite. Those thresholds are configuration, not proof
of safety.

## Benchmark results

None yet. No benchmark run has been executed because no Anthropic credentials
have been configured in this environment, and placeholder numbers are never
written to `evals/benchmarks/latest.json`.

To produce a real benchmark once credentials exist:

```bash
export ANTHROPIC_API_KEY=...          # console.anthropic.com, not claude.ai
export ALLOW_PAID_EVALS=true
export EVAL_MAX_CASES=60

pnpm eval:run --dataset human --mode live --execution batch
pnpm eval:compare --list
pnpm eval:compare <baseline-run-id> <candidate-run-id> --write-benchmark
```

`ANTHROPIC_MODEL` and `ANTHROPIC_JUDGE_MODEL` default to `claude-sonnet-5` and
`claude-opus-5`; set them only to override.

Note that API credit is billed separately from a claude.ai subscription. A
Claude Pro balance does not fund Messages API calls, and the API returns a
`400 invalid_request_error` about credit balance when the console balance is
empty.

The engineering view renders `latest.json` when it exists and says plainly
that no benchmark exists when it does not.

## Models

| Role | Environment variable | Default |
| --- | --- | --- |
| Generation | `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| Judge | `ANTHROPIC_JUDGE_MODEL` | `claude-opus-5` |

Defaults live in `src/config/env.ts` and nowhere else; no model identifier is
hard-coded anywhere in the application or the scripts. The two roles are
independent at the configuration boundary even when they point at the same
model.

The judge defaults to a more capable model than the generator on purpose. A
judge from the same family as the generator is prone to self-preference bias,
which would quietly inflate every score the project reports. If cost forces a
weaker judge, say so alongside the numbers.

## Observability

Tracing sits behind an application-owned `Observability` interface, so no
business logic imports Langfuse directly. Each request opens a
`support-request` trace with spans for `input-guardrails`,
`generate-response`, `output-guardrails` and `live-evaluation`, recording the
trace id, prompt id, generation and judge models, latency, token usage,
guardrail results, rubric scores, errors and a cost estimate where pricing is
configured. The message is redacted before it reaches trace metadata.

Without `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` a no-op implementation
is used. Observability failures are swallowed by design: they must never fail
a user request.

## Running locally

```bash
pnpm install
cp .env.example .env    # optional; the app runs without it
pnpm dev
```

Then open <http://localhost:3000>. With no credentials the app runs in Replay
Mode; `GET /api/health` reports `replay-only`.

All commands:

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:e2e` | Playwright E2E suite |
| `pnpm eval:smoke` | 24 representative cases, offline by default |
| `pnpm eval:generate` | Synthetic eval generation (**paid**) |
| `pnpm eval:run` | Experiment runner (offline by default, `--mode live` is **paid**) |
| `pnpm eval:run --execution batch` | Same, through the Batch API at half cost |
| `pnpm eval:compare` | Compare existing runs (never calls a model) |
| `pnpm prompt:optimize` | Candidate search and recommendation (**paid**) |

## Running evals

Offline, with no credentials and no cost:

```bash
pnpm eval:smoke
pnpm eval:run --dataset human --max-cases 20
pnpm eval:compare --list
pnpm eval:compare <run-a> <run-b>
```

Offline runs use a deterministic stub in place of the generation model. They
exercise validation, deterministic evaluators and the full reporting path, and
they deliberately carry **no** rubric scores — a rubric mean requires a real
judge call.

Paid operations refuse to start unless `ALLOW_PAID_EVALS=true`:

```bash
pnpm eval:generate --plan          # prints the batch plan, calls nothing
pnpm eval:generate                 # paid
pnpm eval:run --mode live          # paid
pnpm prompt:optimize               # paid
```

### Batch API

Large offline runs can go through the Message Batches API, which bills at half
the standard rate in exchange for being queued rather than real-time:

```bash
pnpm eval:run --mode live --execution batch
pnpm eval:generate --execution batch
pnpm prompt:optimize --execution batch
```

`EVAL_USE_BATCH_API=true` makes batch the default for every live run. Batching
is never used on the `/api/respond` request path — a public demo needs a
response now, not in an hour.

`eval:run` submits one generation batch, a retry batch for anything that came
back malformed (mirroring the sequential path's single retry), then one judge
batch. A per-request failure inside a batch is recorded against that case, not
thrown; the rest of the batch still counts. Batch ids are stored on the run
record so a long job can be traced in the console.

`prompt:optimize` benefits most: it evaluates the baseline plus every candidate
over the whole dataset.

### Cost controls

`EVAL_MAX_CASES` caps the number of cases in any run and is combined with any
`--max-cases` flag, taking whichever is tighter. `EVAL_MAX_SPEND_USD` is
enforced against *tracked actual* spend, using `evals/pricing.json`:

| Model | Input $/M | Output $/M |
| --- | --- | --- |
| `claude-sonnet-5` | 2 | 10 |
| `claude-opus-5` | 5 | 25 |
| `claude-haiku-4-5-20251001` | 1 | 5 |

Batch runs are costed at half these rates. A model with no entry is reported as
unpriced rather than free, so cost is never estimated from invented prices.
Update the file when Anthropic pricing changes — nothing else reads rates.

## Adding an eval case

Append a line to `evals/datasets/seed.jsonl` or `adversarial.jsonl`:

```json
{"id":"seed-037","category":"refund","input":"...","expected":{"escalationRequired":true,"expectedBehaviour":"Escalates for human review.","forbiddenClaims":["your refund has been processed"]},"adversarial":false,"difficulty":"medium","source":"human"}
```

Every row is validated on load. An invalid or duplicated row fails the run
with its file and line number rather than being skipped. `id` must be unique
across all datasets. Synthetic cases are written to `generated.jsonl` by
`pnpm eval:generate` and are never regenerated at application startup.

## Adding a prompt version

1. Create `src/ai/prompts/support/v2.ts` with a new immutable `id`. Never edit
   an existing version in place.
2. Register it in `src/ai/prompts/support/index.ts`.
3. Evaluate it: `pnpm eval:run --prompt support-v2`.
4. Compare it against the current baseline and check the gates.
5. Only then change `ACTIVE_SUPPORT_PROMPT`, record the decision in
   `docs/DECISIONS.md`, and rerun the suite.

## Replay Mode

Replay Mode is a product feature, not a fallback hack. With no
`ANTHROPIC_API_KEY` the application starts, the engineering view works,
benchmarks render, and the six example interactions replay from
`data/replays/`. Live submission reports plainly that live inference is
unavailable.

Replay results are labelled **Replay**; live results are labelled **Live**. A
replay is never presented as a live model call. The current fixtures are
explicitly authored examples and carry no judge scores, so the demo shows
"evaluation unavailable" rather than an authored quality score.

Public live inference additionally requires `LIVE_DEMO_ENABLED=true`; it is
off by default so a deployed portfolio site cannot quietly spend credit.

## Deployment

Deployment is an external action, disabled for automation by default
(`ALLOW_DEPLOY=false`). The production build passes; deployment is the only
outstanding blocker.

To deploy to Vercel:

1. Create a Vercel project from this repository. The framework preset is
   Next.js and no build override is needed.
2. Set the environment variables from `.env.example` in the Vercel project.
   `ANTHROPIC_API_KEY` is server-side only and must never be exposed to
   browser code.
3. Leave `LIVE_DEMO_ENABLED=false` for a first deploy; the site is fully
   usable in Replay Mode. Enable it deliberately, with
   `LIVE_DEMO_REQUESTS_PER_HOUR`, `LIVE_DEMO_GLOBAL_DAILY_LIMIT` and
   `RATE_LIMIT_SALT` set.
4. Verify `GET /api/health` reports the mode you expect.

Note that the current rate limiter and usage store are process-local. On a
multi-instance serverless deployment they cannot enforce a true global daily
cap; implement a persistent `UsageStore` backed by `DATABASE_URL` before
enabling public live inference at scale, or leave live inference disabled.

## Trade-offs and limitations

- **LLM judges are fallible.** The rubric judge is a model scoring another
  model. It is inconsistent at the margins and can be wrong in both
  directions.
- **Synthetic tests do not replace human evaluation.** Generated cases inherit
  the generator's blind spots.
- **Automated guardrails cannot guarantee safety.** The deterministic checks
  catch high-confidence phrasings of known failures. Novel phrasings pass.
- **Eval datasets can be overfit.** Optimising prompts against a fixed dataset
  will eventually tune for that dataset rather than for real users.
- **Benchmark quality depends on dataset quality.** A clean 100% on a weak
  dataset means very little.
- **Model behaviour can change.** Results are tied to specific model versions
  and are not stable over time.
- **This application performs no real support actions.** There are no
  customers, subscriptions, transactions or payment systems behind it.
- **No benchmark has been run.** Every number that would appear in the
  engineering view has to come from a real run; none has happened yet.
