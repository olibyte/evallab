# TASKS

Shared implementation checklist. Tasks map to `PROJECT_SPEC.md` requirements.

## Phase 0 - Repository agent setup
- [ ] Create `AGENTS.md`, `CLAUDE.md`
- [ ] Create `docs/BUILD_STATE.md`, `docs/DECISIONS.md`, `docs/TASKS.md`

## Phase 1 - Application scaffold
- [ ] Next.js + TypeScript + Tailwind + pnpm scaffold
- [ ] Environment validation module
- [ ] `GET /api/health`
- [ ] Basic homepage
- [ ] lint / typecheck / test / build pass

## Phase 2 - Generation pipeline
- [ ] `src/domain/support-policy.md`
- [ ] Versioned support prompts + registry
- [ ] Anthropic server client (generation + judge boundaries)
- [ ] Structured `SupportResponse` output with Zod
- [ ] `POST /api/respond` orchestration

## Phase 3 - Evaluation foundation
- [ ] Eval case schema + loader
- [ ] Seed dataset (human-authored)
- [ ] Adversarial dataset
- [ ] Deterministic evaluators
- [ ] Rubric judge
- [ ] Automated quality score

## Phase 4 - Durable eval assets
- [ ] `pnpm eval:generate`
- [ ] `pnpm eval:run`
- [ ] `pnpm eval:compare`
- [ ] `pnpm prompt:optimize`
- [ ] Real benchmark artifacts (BLOCKED: needs credentials + `ALLOW_PAID_EVALS=true`)

## Phase 5 - Guardrails
- [ ] Input validation
- [ ] Injection heuristics
- [ ] PII redaction
- [ ] Output authority/leakage checks

## Phase 6 - Observability
- [ ] Langfuse abstraction + no-op fallback
- [ ] Spans for guardrails/generation/evaluation
- [ ] Token, latency, cost metadata

## Phase 7 - Public demo UI
- [ ] Homepage demo experience

## Phase 8 - Engineering View
- [ ] `/engineering` dashboard

## Phase 9 - Replay and cost controls
- [ ] Replay Mode + fixtures
- [ ] Rate limits, daily global limit, live-mode switch, timeouts, token caps

## Phase 10 - Test and CI hardening
- [ ] Unit + integration tests
- [ ] Playwright E2E
- [ ] GitHub Actions CI
- [ ] Offline eval smoke test

## Phase 11 - Documentation and deployment
- [ ] README
- [ ] Deployment documentation
- [ ] Vercel deploy (BLOCKED: requires `ALLOW_DEPLOY=true` + credentials)
