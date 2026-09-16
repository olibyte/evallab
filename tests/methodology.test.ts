import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../src/config/env";
import { buildBenchmark, BenchmarkNotComparableError } from "../src/evals/benchmarks";
import { compareRuns, RUBRIC_REGRESSION_THRESHOLD } from "../src/evals/compare";
import { computeMetrics, evaluateGates } from "../src/evals/metrics";
import {
  assertBaselineUsable,
  detectCaseLeakage,
  proposeCandidates,
} from "../src/evals/optimize";
import { UsageTracker } from "../src/evals/paid-guard";
import type { CaseResult, ExperimentRun } from "../src/evals/results";
import { runExperiment } from "../src/evals/run-experiment";
import type { EvalCase } from "../src/schemas/eval-case";
import { fakeModelClient } from "./helpers/fake-model-client";

const GOOD_OUTPUT = {
  response: "I can't issue refunds myself, but I can pass this to a human for review.",
  escalationRequired: true,
  escalationReason: "Requires human review.",
  policyReferences: ["Refunds"],
};

const RUBRIC = {
  policyCompliance: { rationale: "Respects boundaries.", score: 5 as const },
  groundedness: { rationale: "Grounded.", score: 5 as const },
  helpfulness: { rationale: "Clear.", score: 4 as const },
  tone: { rationale: "Professional.", score: 5 as const },
};

function caseResult(overrides: Partial<CaseResult> & { caseId: string }): CaseResult {
  return {
    category: "refund",
    adversarial: false,
    difficulty: "easy",
    input: "x",
    output: GOOD_OUTPUT,
    deterministic: [
      { evaluatorId: "unauthorized-action-claims", passed: true },
      { evaluatorId: "prompt-leakage", passed: true },
    ],
    latencyMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function run(cases: CaseResult[], config: Partial<ExperimentRun["config"]> = {}): ExperimentRun {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: "2026-09-16T00:00:00Z",
    finishedAt: "2026-09-16T00:00:01Z",
    config: {
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      datasetSize: cases.length,
      split: "holdout",
      promptId: "support-v1",
      promptVersion: 1,
      promptSource: "registry",
      mode: "live",
      execution: "sequential",
      generationModel: "gen-model",
      judgeModel: "judge-model",
      judgePromptId: "judge-rubric-v2",
      ...config,
    },
    usage: { inputTokens: 0, outputTokens: 0, unpricedModels: [] },
    cases,
  };
}

describe("denominators", () => {
  it("counts an errored case as a failure in every pass rate", () => {
    const metrics = computeMetrics(
      run([
        caseResult({ caseId: "a", adversarial: true }),
        caseResult({
          caseId: "b",
          adversarial: true,
          output: undefined,
          error: "Generation failed.",
          deterministic: [{ evaluatorId: "structured-output-validity", passed: false }],
        }),
      ]),
    );
    expect(metrics.errors).toBe(1);
    expect(metrics.deterministicPassRate).toBe(0.5);
    expect(metrics.adversarialPassRate).toBe(0.5);
    expect(metrics.evaluatorPassRates["unauthorized-action-claims"]).toBe(0.5);
  });

  it("scores adversarial cases per case, not per verdict", () => {
    const metrics = computeMetrics(
      run([
        caseResult({
          caseId: "leak",
          adversarial: true,
          deterministic: [
            { evaluatorId: "unauthorized-action-claims", passed: true },
            { evaluatorId: "prompt-leakage", passed: false },
            { evaluatorId: "forbidden-claim-detection", passed: true },
            { evaluatorId: "expected-escalation-match", passed: true },
          ],
        }),
      ]),
    );
    // Three of four verdicts passed, but the case leaked: it failed.
    expect(metrics.adversarialPassRate).toBe(0);
    expect(metrics.deterministicPassRate).toBe(0);
  });

  it("reports no measurement rather than a pass when an evaluator never ran", () => {
    const metrics = computeMetrics(run([caseResult({ caseId: "a", deterministic: [] })]));
    expect(metrics.evaluatorPassRates["unauthorized-action-claims"]).toBeUndefined();
    const gate = evaluateGates(metrics).find((g) => g.id === "unauthorized-action-pass-rate");
    expect(gate?.passed).toBe(false);
  });

  it("does not let an unjudged case lift the rubric mean past a gate", () => {
    const metrics = computeMetrics(
      run([
        caseResult({ caseId: "judged", rubric: RUBRIC, automatedQualityScore: 93.8 }),
        caseResult({ caseId: "skipped", judgeError: "Judge did not return a valid rubric evaluation." }),
      ]),
    );
    expect(metrics.rubric.policyCompliance).toBe(5);
    expect(metrics.rubric.judgedCases).toBe(1);
    expect(metrics.rubric.unjudgedCases).toBe(1);
    expect(metrics.rubric.coverage).toBe(0.5);

    const gates = Object.fromEntries(evaluateGates(metrics).map((g) => [g.id, g]));
    expect(gates["policy-compliance-mean"]?.passed).toBe(false);
    expect(gates["policy-compliance-mean"]?.note).toMatch(/Judged 1 of 2/);
    expect(gates["judge-coverage"]?.passed).toBe(false);
    expect(gates["generation-success-rate"]?.passed).toBe(true);
  });

  it("passes every gate only for a fully generated, fully judged, clean run", () => {
    const metrics = computeMetrics(
      run([
        caseResult({ caseId: "a", adversarial: true, rubric: RUBRIC, automatedQualityScore: 93.8 }),
        caseResult({ caseId: "b", rubric: RUBRIC, automatedQualityScore: 93.8 }),
      ]),
    );
    expect(evaluateGates(metrics).every((g) => g.passed)).toBe(true);
  });
});

describe("comparison identity", () => {
  const base = [caseResult({ caseId: "a" }), caseResult({ caseId: "b" })];

  it("is not comparable when the case sets differ, even with the same dataset id and size", () => {
    const comparison = compareRuns([
      run(base),
      run([caseResult({ caseId: "a" }), caseResult({ caseId: "c" })]),
    ]);
    expect(comparison.comparable).toBe(false);
    expect(comparison.warnings.join(" ")).toMatch(/1 missing, 1 extra/);
  });

  it("is not comparable across judge models or judge prompts", () => {
    expect(compareRuns([run(base), run(base, { judgeModel: "other" })]).comparable).toBe(false);
    expect(
      compareRuns([run(base), run(base, { judgePromptId: "judge-rubric-v1" })]).comparable,
    ).toBe(false);
    expect(compareRuns([run(base), run(base, { generationModel: "other" })]).comparable).toBe(false);
    expect(compareRuns([run(base), run(base, { split: "dev" })]).comparable).toBe(false);
  });

  it("is comparable for like-for-like runs and flags identical prompt text", () => {
    const comparison = compareRuns([run(base, { promptHash: "h" }), run(base, { promptHash: "h" })]);
    expect(comparison.comparable).toBe(true);
    expect(comparison.warnings.join(" ")).toMatch(/exactly the same prompt text/);
  });

  it("reports a rubric collapse as a regression even when every deterministic check passes", () => {
    const comparison = compareRuns([
      run([caseResult({ caseId: "a", rubric: RUBRIC, automatedQualityScore: 90 })]),
      run([
        caseResult({
          caseId: "a",
          rubric: RUBRIC,
          automatedQualityScore: 90 - RUBRIC_REGRESSION_THRESHOLD,
        }),
      ]),
    ]);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]?.reason).toBe("rubric");
  });

  it("refuses to write a benchmark from non-comparable runs unless overridden", () => {
    const comparison = compareRuns([run(base), run(base, { judgeModel: "other" })]);
    expect(() => buildBenchmark(comparison)).toThrow(BenchmarkNotComparableError);
    const forced = buildBenchmark(comparison, { allowMismatch: true });
    expect(forced.comparable).toBe(false);
    expect(forced.warnings.length).toBeGreaterThan(0);
  });

  it("carries full provenance for every run and warns when the split is dev", () => {
    const comparison = compareRuns([
      run(base, { split: "dev", promptHash: "abc" }),
      run(base, { split: "dev", promptHash: "def", promptSource: "candidate", candidateId: "opt-1-c1" }),
    ]);
    const benchmark = buildBenchmark(comparison);
    expect(benchmark.split).toBe("dev");
    expect(benchmark.warnings.join(" ")).toMatch(/Held-out results are needed/);
    expect(benchmark.runs).toHaveLength(2);
    expect(benchmark.runs[1]).toMatchObject({
      label: "opt-1-c1",
      generationModel: "gen-model",
      judgeModel: "judge-model",
      judgePromptId: "judge-rubric-v2",
      promptHash: "def",
    });
    expect(benchmark.runs[0]?.gates.length).toBeGreaterThan(0);
  });
});

describe("optimizer isolation", () => {
  const devCases: EvalCase[] = [
    {
      id: "dev-1",
      category: "refund",
      input: "I bought AcmeCloud Pro three days ago and it isn't what I expected. Can I get my money back?",
      expected: { expectedBehaviour: "Escalates." },
      adversarial: false,
      difficulty: "easy",
      source: "human",
    },
  ];
  const prompt = { id: "support-v1", version: 1, description: "d", createdAt: "x", systemPrompt: "s" };

  it("rejects a baseline that ran on anything but the dev split", () => {
    const baseline = run([caseResult({ caseId: "dev-1" })], { split: "holdout" });
    expect(() => assertBaselineUsable(baseline, prompt, devCases)).toThrow(/may only read "dev"/);
  });

  it("rejects a baseline whose case set differs from the selected dev cases", () => {
    const baseline = run([caseResult({ caseId: "held-9" })], { split: "dev" });
    expect(() => assertBaselineUsable(baseline, prompt, devCases)).toThrow(/different case set/);
  });

  it("accepts a live dev-split baseline of the same prompt over the same cases", () => {
    const baseline = run([caseResult({ caseId: "dev-1" })], { split: "dev" });
    expect(() => assertBaselineUsable(baseline, prompt, devCases)).not.toThrow();
  });

  it("detects a candidate prompt that quotes a dev case", () => {
    const leaking = `You are the assistant. If a customer says "it isn't what I expected. Can I get my money back?" then escalate.`;
    expect(detectCaseLeakage(leaking, devCases)).toHaveLength(1);
    expect(detectCaseLeakage("You are the assistant. Escalate refund requests.", devCases)).toHaveLength(0);
  });

  it("drops leaking proposals and keeps the rest", async () => {
    const generic = "You are the AcmeCloud support assistant. ".repeat(8);
    const client = fakeModelClient("generation", [
      JSON.stringify({
        candidates: [
          { description: "memorises", systemPrompt: `${generic} When asked "Can I get my money back?" after "three days ago and it isn't what I expected" escalate.` },
          { description: "generalises", systemPrompt: `${generic} Always escalate refund requests for human review.` },
        ],
      }),
    ]);
    const result = await proposeCandidates({
      client,
      prompt,
      baseline: run([caseResult({ caseId: "dev-1" })], { split: "dev" }),
      cases: devCases,
      optimizationRunId: "opt-test",
      candidateCount: 2,
      usage: new UsageTracker(),
    });
    expect(result.rejected.map((r) => r.description)).toEqual(["memorises"]);
    expect(result.candidates.map((c) => c.candidateId)).toEqual(["opt-test-c1"]);
  });
});

describe("spend tracking", () => {
  it("reports cost as unavailable when any model used is unpriced", () => {
    const tracker = new UsageTracker();
    tracker.record("claude-sonnet-5", 1_000_000, 0);
    expect(tracker.estimatedCostUsd).toBe(2);
    tracker.record("mystery-model", 10, 10);
    expect(tracker.estimatedCostUsd).toBeUndefined();
    expect(tracker.unpricedModels).toEqual(["mystery-model"]);
  });

  it("enforces one shared budget across runs", () => {
    const budget = new UsageTracker(3);
    const first = new UsageTracker(undefined, budget);
    const second = new UsageTracker(undefined, budget);
    first.record("claude-sonnet-5", 1_000_000, 0); // $2
    expect(() => second.assertWithinBudget()).not.toThrow();
    second.record("claude-sonnet-5", 1_000_000, 0); // $4 total
    expect(() => second.assertWithinBudget()).toThrow(/Spend limit/);
    expect(first.estimatedCostUsd).toBe(2);
    expect(budget.estimatedCostUsd).toBe(4);
  });
});

describe("live sequential run records", () => {
  beforeEach(() => {
    process.env.ALLOW_PAID_EVALS = "true";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    resetEnvCache();
  });
  afterEach(() => {
    delete process.env.ALLOW_PAID_EVALS;
    delete process.env.ANTHROPIC_API_KEY;
    resetEnvCache();
  });

  const cases: EvalCase[] = ["a", "b"].map((id) => ({
    id,
    category: "refund",
    input: `Case ${id}`,
    expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
    adversarial: false,
    difficulty: "easy",
    source: "human",
  }));

  it("records a failing structured-output verdict, the judge error and full provenance", async () => {
    const generation = fakeModelClient("generation", [
      JSON.stringify(GOOD_OUTPUT),
      "garbage",
      "still garbage",
    ]);
    const judge = fakeModelClient("judge", ["not json"]);
    const result = await runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      split: "holdout",
      prompt: { id: "support-v1", version: 1, description: "d", createdAt: "x", systemPrompt: "sys" },
      mode: "live",
      createClient: (role) => (role === "generation" ? generation : judge),
    });

    const [first, second] = result.cases;
    expect(first?.rubric).toBeUndefined();
    expect(first?.judgeError).toMatch(/valid rubric/);
    expect(second?.error).toMatch(/structured output/);
    expect(second?.deterministic).toEqual([
      expect.objectContaining({ evaluatorId: "structured-output-validity", passed: false }),
    ]);

    expect(result.runId).toContain("-human-holdout-support-v1-");
    expect(result.config).toMatchObject({
      split: "holdout",
      judgePromptId: "judge-rubric-v2",
      // The fake models are not models that accept `temperature`, so the
      // run record must not claim one was sent. See tests/model-compat.
      generationParams: { maxOutputTokens: 1024 },
      judgeParams: { maxOutputTokens: 800 },
    });
    expect(result.config.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.config.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.config.judgePromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.usage.unpricedModels).toEqual(["fake-generation-model", "fake-judge-model"]);
    // 3 generation attempts + 1 judge call, all at 100 in / 50 out.
    expect(result.usage.inputTokens).toBe(400);
    expect(second?.inputTokens).toBe(200);

    const metrics = computeMetrics(result);
    expect(metrics.errors).toBe(1);
    expect(metrics.deterministicPassRate).toBe(0.5);
    expect(metrics.rubric.coverage).toBe(0);
  });
});
