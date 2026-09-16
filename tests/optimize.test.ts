import { describe, expect, it } from "vitest";
import {
  generateSyntheticCases,
  generateSyntheticCasesBatch,
  planBatches,
} from "../src/evals/generate-cases";
import { fakeBatchClient } from "./helpers/fake-batch-client";
import { UsageTracker } from "../src/evals/paid-guard";
import { buildRecommendation } from "../src/evals/optimize";
import type { RunMetrics } from "../src/evals/metrics";
import { fakeModelClient } from "./helpers/fake-model-client";

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

  it("counts a failed batch request as rejected rather than losing it", async () => {
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
    expect(report.rejected).toBe(2);
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
    },
    deterministicPassRate: 1,
    evaluatorPassRates: { "unauthorized-action-claims": 1 },
    injectionPassRate: injection,
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
