import { describe, expect, it } from "vitest";
import {
  generateSyntheticCases,
  generateSyntheticCasesBatch,
  planBatches,
} from "../src/evals/generate-cases";
import { fakeBatchClient } from "./helpers/fake-batch-client";
import { UsageTracker } from "../src/evals/paid-guard";
import {
  assertBaselineUsable,
  buildRecommendation,
  OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS,
  OPTIMIZER_PROPOSAL_TIMEOUT_MS,
  PROPOSAL_TRUNCATED_MESSAGE,
  proposeCandidates,
} from "../src/evals/optimize";
import type { RunMetrics } from "../src/evals/metrics";
import type { CaseResult, ExperimentRun } from "../src/evals/results";
import type { EvalCase } from "../src/schemas/eval-case";
import { generateSupportResponse } from "../src/ai/generation/generate-support-response";
import { fakeModelClient, type Recorded } from "./helpers/fake-model-client";

function batchResponse(inputs: string[]) {
  return JSON.stringify({
    cases: inputs.map((input) => ({
      input,
      expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
    })),
  });
}

describe("generateSyntheticCases", () => {
  const specs = planBatches({ ordinary: 2, edge: 0, adversarial: 0 }, 2);

  it("accepts valid cases and assigns deterministic ids", async () => {
    const report = await generateSyntheticCases({
      client: fakeModelClient("generation", [batchResponse(["First message", "Second message"])]),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });
    expect(report.accepted).toHaveLength(2);
    expect(report.accepted[0]?.id).toMatch(/^gen-[0-9a-f]{12}$/);
    expect(report.accepted.every((c) => c.source === "synthetic")).toBe(true);
  });

  it("drops duplicates of existing cases", async () => {
    const first = await generateSyntheticCases({
      client: fakeModelClient("generation", [batchResponse(["Repeated message", "Unique one"])]),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });
    const second = await generateSyntheticCases({
      client: fakeModelClient("generation", [batchResponse(["  repeated MESSAGE ", "Another"])]),
      specs,
      existing: first.accepted,
      usage: new UsageTracker(),
    });
    expect(second.duplicates).toBe(1);
    expect(second.accepted).toHaveLength(1);
  });

  it("rejects rows that fail validation instead of writing them", async () => {
    const report = await generateSyntheticCases({
      client: fakeModelClient("generation", [
        JSON.stringify({ cases: [{ input: "no expected block" }, { nope: true }] }),
      ]),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });
    expect(report.accepted).toHaveLength(0);
    expect(report.rejected).toBe(2);
  });

  it("stops at the configured case cap", async () => {
    const report = await generateSyntheticCases({
      client: fakeModelClient("generation", [batchResponse(["One", "Two"])]),
      specs,
      existing: [],
      usage: new UsageTracker(),
      maxCases: 1,
    });
    expect(report.accepted).toHaveLength(1);
  });
});

describe("generateSyntheticCasesBatch", () => {
  const specs = planBatches({ ordinary: 6, edge: 0, adversarial: 0 }, 2);

  it("submits every spec in one batch and validates the results", async () => {
    let n = 0;
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => {
        n += 1;
        return { text: batchResponse([`Message ${n}a`, `Message ${n}b`]) };
      }),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });

    expect(specs).toHaveLength(3);
    expect(report.batchId).toBe("batch_generation_1");
    expect(report.accepted).toHaveLength(6);
    expect(new Set(report.accepted.map((c) => c.id)).size).toBe(6);
  });

  it("counts a failed batch request in requests, not as rejected candidates", async () => {
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", (request) =>
        request.customId === "spec-1"
          ? { error: "Batch request errored." }
          : {
              text: batchResponse([
                `${request.customId} first`,
                `${request.customId} second`,
              ]),
            },
      ),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });

    expect(report.accepted).toHaveLength(4);
    // A request that never returned produced no candidate to reject. Adding
    // its planned count to `rejected` is what turned 36 unusable replies into
    // "288 rejected candidates" in the 2026-09-16 run.
    expect(report.rejected).toBe(0);
    expect(report.diagnostics.requestOutcomes["request-failed"]).toBe(1);
    expect(report.diagnostics.casesReturned).toBe(4);
    expect(report.diagnostics.casesNeverReturned).toBe(2);
  });

  it("applies the same validation as the sequential path", async () => {
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({
        text: JSON.stringify({ cases: [{ input: "missing expected block" }] }),
      })),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });

    expect(report.accepted).toHaveLength(0);
    expect(report.rejected).toBe(3);
  });
});

function metrics(quality: number, policy = 5, ground = 5, injection = 1): RunMetrics {
  return {
    cases: 10,
    errors: 0,
    rubric: {
      policyCompliance: policy,
      groundedness: ground,
      helpfulness: 4,
      tone: 4,
      automatedQualityScore: quality,
      judgedCases: 10,
      unjudgedCases: 0,
      coverage: 1,
    },
    deterministicPassRate: 1,
    evaluatorPassRates: { "unauthorized-action-claims": 1 },
    adversarialPassRate: injection,
    adversarialCases: 4,
    latencyMeanMs: 100,
    latencyMedianMs: 100,
    inputTokens: 0,
    outputTokens: 0,
  };
}

describe("buildRecommendation", () => {
  it("never promotes automatically", () => {
    const result = buildRecommendation({ metrics: metrics(70) }, [
      { candidateId: "c1", metrics: metrics(90) },
    ]);
    expect(result.promote).toBe(false);
    expect(result.candidateId).toBe("c1");
    expect(result.summary).toMatch(/manual source change/i);
  });

  it("blocks a candidate that fails a hard gate despite a higher score", () => {
    const result = buildRecommendation({ metrics: metrics(70) }, [
      { candidateId: "c1", metrics: metrics(99, 5, 5, 0.5) },
    ]);
    expect(result.candidateId).toBeUndefined();
    expect(result.detail.join(" ")).toMatch(/injection-adversarial-pass-rate/);
  });

  it("keeps the current prompt when no candidate beats the baseline", () => {
    const result = buildRecommendation({ metrics: metrics(90) }, [
      { candidateId: "c1", metrics: metrics(85) },
    ]);
    expect(result.candidateId).toBeUndefined();
    expect(result.summary).toMatch(/beat the baseline/);
  });
});

describe("proposeCandidates call settings", () => {
  const prompt = {
    id: "support-v1",
    version: 1,
    description: "d",
    createdAt: "2026-01-01",
    systemPrompt: "You are a support assistant.",
  };

  const baseline: ExperimentRun = {
    runId: "baseline-run",
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: "2026-09-17T00:01:00.000Z",
    config: {
      datasetId: "all",
      datasetFiles: ["seed.jsonl"],
      datasetSize: 0,
      split: "dev",
      promptId: prompt.id,
      promptVersion: 1,
      promptSource: "registry",
      mode: "live",
      execution: "batch",
      generationModel: "fake-generation-model",
    },
    usage: { inputTokens: 0, outputTokens: 0, unpricedModels: [] },
    cases: [],
  };

  const proposal = JSON.stringify({
    candidates: [
      {
        description: "Tighter escalation rule",
        systemPrompt: "You are a support assistant. ".repeat(12),
      },
    ],
  });

  it("uses the 600 s proposal timeout and the 16000-token ceiling, on the proposal call only", async () => {
    const recorded: Recorded[] = [];
    const result = await proposeCandidates({
      client: fakeModelClient("generation", [proposal], recorded),
      prompt,
      baseline,
      cases: [],
      optimizationRunId: "opt-test",
      candidateCount: 1,
      usage: new UsageTracker(),
      save: false,
    });

    expect(result.candidates).toHaveLength(1);
    expect(OPTIMIZER_PROPOSAL_TIMEOUT_MS).toBe(600_000);
    expect(OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS).toBe(16_000);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.timeoutMs).toBe(OPTIMIZER_PROPOSAL_TIMEOUT_MS);
    expect(recorded[0]?.maxOutputTokens).toBe(OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS);
  });

  it("does not leak the long timeout into ordinary generation", async () => {
    const recorded: Recorded[] = [];
    await generateSupportResponse({
      message: "hi",
      prompt,
      client: fakeModelClient(
        "generation",
        [
          JSON.stringify({
            response: "I can help with that.",
            escalationRequired: false,
            policyReferences: [],
          }),
        ],
        recorded,
      ),
    });
    // Unset here means the client applies its own 30 s default.
    expect(recorded[0]?.timeoutMs).toBeUndefined();
  });

  it("refuses a proposal that stopped on max_tokens even when its text parses", async () => {
    const usage = new UsageTracker();
    await expect(
      proposeCandidates({
        client: fakeModelClient("generation", [{ text: proposal, stopReason: "max_tokens" }]),
        prompt,
        baseline,
        cases: [],
        optimizationRunId: "opt-test",
        candidateCount: 1,
        usage,
        save: false,
      }),
    ).rejects.toThrow(PROPOSAL_TRUNCATED_MESSAGE);
    // The tokens were still spent and count against the optimization budget.
    expect(usage.outputTokens).toBe(50);
  });

  it("names the schema problem and stop reason on a malformed proposal", async () => {
    await expect(
      proposeCandidates({
        client: fakeModelClient("generation", [
          { text: JSON.stringify({ candidates: [{ description: "x", systemPrompt: "short" }] }), stopReason: "end_turn" },
        ]),
        prompt,
        baseline,
        cases: [],
        optimizationRunId: "opt-test",
        candidateCount: 1,
        usage: new UsageTracker(),
        save: false,
      }),
    ).rejects.toThrow(/candidates\.0\.systemPrompt.*stop_reason=end_turn/);
  });
});

/**
 * Reusing a baseline with `--baseline` must be refused unless every dev
 * case was generated and judged. The 2026-09-17 runs are the reference
 * points: the first baseline judged 185 of 229 (44 truncated at 800), the
 * second 226 of 229 (2 truncated at 1600, 1 generation failure). Neither
 * can anchor a candidate comparison, because a mean over a subset is not
 * the metric the gates are defined on. Quality is deliberately not checked.
 */
describe("assertBaselineUsable measurement completeness", () => {
  const prompt = {
    id: "support-v1",
    version: 1,
    description: "d",
    createdAt: "2026-01-01",
    systemPrompt: "You are a support assistant.",
  };

  const devCases: EvalCase[] = Array.from({ length: 229 }, (_, i) => ({
    id: `dev-${i}`,
    category: "refund",
    input: `Case ${i}`,
    expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
    adversarial: i % 5 === 0,
    difficulty: "medium",
    source: "synthetic",
  }));

  type Score = 1 | 2 | 3 | 4 | 5;
  const rubric = (score: Score) => ({
    policyCompliance: { rationale: "r", score },
    groundedness: { rationale: "r", score },
    helpfulness: { rationale: "r", score },
    tone: { rationale: "r", score },
  });

  function caseResult(
    evalCase: EvalCase,
    shape: { generated: boolean; judged: boolean; score?: Score },
  ): CaseResult {
    const score: Score = shape.score ?? 5;
    return {
      caseId: evalCase.id,
      category: evalCase.category,
      adversarial: evalCase.adversarial,
      difficulty: evalCase.difficulty,
      input: evalCase.input,
      output: shape.generated
        ? { response: "I can escalate this for review.", escalationRequired: true, policyReferences: [] }
        : undefined,
      error: shape.generated ? undefined : "Generation did not return valid structured output.",
      deterministic: [
        {
          evaluatorId: "structured-output-validity",
          passed: shape.generated,
          rationale: shape.generated ? "ok" : "No valid structured output",
        },
      ],
      rubric: shape.generated && shape.judged ? rubric(score) : undefined,
      judgeError:
        shape.generated && !shape.judged
          ? "Judge reply was truncated at the output ceiling (stop_reason=max_tokens); no rubric was scored."
          : undefined,
      automatedQualityScore: shape.generated && shape.judged ? score * 20 : undefined,
      latencyMs: 1,
      inputTokens: 10,
      outputTokens: 10,
    };
  }

  function run(
    shapes: (index: number) => { generated: boolean; judged: boolean; score?: Score },
    runId = "baseline-run",
  ): ExperimentRun {
    return {
      runId,
      startedAt: "2026-09-17T00:00:00.000Z",
      finishedAt: "2026-09-17T00:01:00.000Z",
      config: {
        datasetId: "all",
        datasetFiles: ["seed.jsonl", "adversarial.jsonl", "generated.jsonl"],
        datasetSize: devCases.length,
        split: "dev",
        promptId: prompt.id,
        promptVersion: 1,
        promptSource: "registry",
        mode: "live",
        execution: "batch",
        generationModel: "claude-sonnet-5",
        judgeModel: "claude-sonnet-5",
      },
      usage: { inputTokens: 0, outputTokens: 0, unpricedModels: [] },
      cases: devCases.map((c, i) => caseResult(c, shapes(i))),
    };
  }

  it("rejects the first 2026-09-17 baseline shape: 185 of 229 judged", () => {
    const baseline = run((i) => ({ generated: true, judged: i >= 44 }), "20260917T040103Z-all-dev-support-v1-d0rbl");
    expect(() => assertBaselineUsable(baseline, prompt, devCases)).toThrow(
      /judge coverage is 0\.808 \(185 of 229/,
    );
  });

  it("rejects the second 2026-09-17 baseline shape: 226 of 229 judged, 1 generation failure", () => {
    const baseline = run(
      (i) => ({ generated: i !== 0, judged: i !== 1 && i !== 2 }),
      "20260917T044437Z-all-dev-support-v1-leqx2",
    );
    let message = "";
    try {
      assertBaselineUsable(baseline, prompt, devCases);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/generation success rate is 0\.996 \(1 of 229/);
    expect(message).toMatch(/judge coverage is 0\.987 \(226 of 229/);
  });

  it("rejects a single truncated judge reply", () => {
    const baseline = run((i) => ({ generated: true, judged: i !== 100 }));
    expect(() => assertBaselineUsable(baseline, prompt, devCases)).toThrow(/judge coverage is 0\.996/);
  });

  it("rejects a single generation failure even when every output was judged", () => {
    const baseline = run((i) => ({ generated: i !== 7, judged: true }));
    expect(() => assertBaselineUsable(baseline, prompt, devCases)).toThrow(/generation success rate is 0\.996/);
  });

  it("accepts a completely measured baseline", () => {
    expect(() => assertBaselineUsable(run(() => ({ generated: true, judged: true })), prompt, devCases)).not.toThrow();
  });

  it("accepts a completely measured baseline that fails every quality gate", () => {
    // Policy and groundedness means of 1, every adversarial case scored 1:
    // a poor prompt, fully measured, is a legitimate starting point.
    const poor = run(() => ({ generated: true, judged: true, score: 1 }));
    expect(() => assertBaselineUsable(poor, prompt, devCases)).not.toThrow();
  });

  it("still rejects the wrong split, prompt, mode and case set", () => {
    const complete = run(() => ({ generated: true, judged: true }));
    expect(() =>
      assertBaselineUsable({ ...complete, config: { ...complete.config, split: "heldout" } }, prompt, devCases),
    ).toThrow(/ran on split "heldout"/);
    expect(() =>
      assertBaselineUsable({ ...complete, config: { ...complete.config, mode: "offline" } }, prompt, devCases),
    ).toThrow(/offline run/);
    expect(() =>
      assertBaselineUsable(complete, { ...prompt, id: "support-v2" }, devCases),
    ).toThrow(/evaluated support-v1, not support-v2/);
    expect(() => assertBaselineUsable(complete, prompt, devCases.slice(0, 200))).toThrow(
      /different case set \(0 missing, 29 extra\)/,
    );
  });
});
