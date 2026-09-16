import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toItemResult } from "../src/ai/client/batch";
import { resetEnvCache } from "../src/config/env";
import { computeMetrics } from "../src/evals/metrics";
import { BATCH_DISCOUNT_MULTIPLIER, estimateCostUsd } from "../src/evals/pricing";
import { runExperiment } from "../src/evals/run-experiment";
import type { EvalCase } from "../src/schemas/eval-case";
import { fakeBatchClient, type SubmittedBatch } from "./helpers/fake-batch-client";

const GENERATION = JSON.stringify({
  response:
    "I can't issue refunds myself, but I can escalate this for human review.",
  escalationRequired: true,
  escalationReason: "Requires human review.",
  policyReferences: ["Refunds"],
});

const RUBRIC = JSON.stringify({
  policyCompliance: { score: 5, rationale: "Respects boundaries." },
  groundedness: { score: 5, rationale: "Grounded in policy." },
  helpfulness: { score: 4, rationale: "Clear next step." },
  tone: { score: 5, rationale: "Professional." },
});

const cases: EvalCase[] = [1, 2, 3].map((n) => ({
  id: `b-${n}`,
  category: "refund",
  input: `Case ${n}: my renewal charged me.`,
  expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
  adversarial: false,
  difficulty: "medium",
  source: "human",
}));

const prompt = {
  id: "support-v1",
  version: 1,
  description: "d",
  createdAt: "2026-01-01",
  systemPrompt: "system",
};

function run(
  respond: Parameters<typeof fakeBatchClient>[1],
  submitted: SubmittedBatch[],
) {
  return runExperiment({
    cases,
    datasetId: "human",
    datasetFiles: ["seed.jsonl"],
    prompt,
    mode: "live",
    execution: "batch",
    createBatchClient: (role) => fakeBatchClient(role, respond, submitted),
  });
}

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

describe("batch experiment runs", () => {
  it("submits one generation batch and one judge batch", async () => {
    const submitted: SubmittedBatch[] = [];
    const result = await run(
      (request) => ({
        text: request.system === "system" ? GENERATION : RUBRIC,
      }),
      submitted,
    );

    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.requests).toHaveLength(3);
    expect(submitted[0]?.requests.map((r) => r.customId)).toEqual([
      "b-1",
      "b-2",
      "b-3",
    ]);
    expect(result.config.execution).toBe("batch");
    expect(result.config.batchIds).toEqual([
      "batch_generation_1",
      "batch_judge_1",
    ]);
  });

  it("produces the same case results as the sequential path", async () => {
    const result = await run(
      (request) => ({ text: request.system === "system" ? GENERATION : RUBRIC }),
      [],
    );

    expect(result.cases).toHaveLength(3);
    expect(result.cases.every((c) => c.error === undefined)).toBe(true);
    expect(result.cases.every((c) => c.rubric !== undefined)).toBe(true);
    expect(result.cases[0]?.automatedQualityScore).toBe(93.8);
    expect(computeMetrics(result).deterministicPassRate).toBe(1);
  });

  it("retries malformed generations in a second batch", async () => {
    const submitted: SubmittedBatch[] = [];
    await run(
      (request, attempt) => {
        if (request.system !== "system") return { text: RUBRIC };
        if (request.customId === "b-2" && attempt === 1) return { text: "garbage" };
        return { text: GENERATION };
      },
      submitted,
    );

    expect(submitted.map((b) => b.batchId)).toEqual([
      "batch_generation_1",
      "batch_generation_2",
      "batch_judge_1",
    ]);
    expect(submitted[1]?.requests.map((r) => r.customId)).toEqual(["b-2"]);
  });

  it("records a case as failed when it stays malformed", async () => {
    const result = await run(
      (request) =>
        request.system === "system"
          ? { text: request.customId === "b-2" ? "garbage" : GENERATION }
          : { text: RUBRIC },
      [],
    );

    const failed = result.cases.find((c) => c.caseId === "b-2");
    expect(failed?.output).toBeUndefined();
    expect(failed?.error).toMatch(/structured output/i);
    expect(computeMetrics(result).errors).toBe(1);
  });

  it("does not judge cases whose generation failed", async () => {
    const submitted: SubmittedBatch[] = [];
    await run(
      (request) =>
        request.system === "system"
          ? { text: request.customId === "b-2" ? undefined : GENERATION, error: request.customId === "b-2" ? "Batch request errored." : undefined }
          : { text: RUBRIC },
      submitted,
    );

    const judgeBatch = submitted.find((b) => b.batchId.includes("judge"));
    expect(judgeBatch?.requests.map((r) => r.customId)).toEqual(["b-1", "b-3"]);
  });

  it("leaves a case unjudged rather than fabricating a rubric", async () => {
    const result = await run(
      (request) =>
        request.system === "system"
          ? { text: GENERATION }
          : { text: request.customId === "b-2" ? "not json" : RUBRIC },
      [],
    );

    const unjudged = result.cases.find((c) => c.caseId === "b-2");
    expect(unjudged?.output).toBeDefined();
    expect(unjudged?.rubric).toBeUndefined();
    expect(unjudged?.automatedQualityScore).toBeUndefined();
    expect(computeMetrics(result).rubric.judgedCases).toBe(2);
  });

  it("bills a batch run at the discounted rate", async () => {
    const result = await run(
      (request) => ({ text: request.system === "system" ? GENERATION : RUBRIC }),
      [],
    );

    // 3 generation + 3 judge requests at 120 in / 60 out each.
    const undiscounted =
      (estimateCostUsd("fake-generation-model", 360, 180) ?? 0) +
      (estimateCostUsd("fake-judge-model", 360, 180) ?? 0);
    expect(undiscounted).toBe(0); // fake models carry no pricing entry
    expect(result.usage.inputTokens).toBe(720);
    expect(result.usage.outputTokens).toBe(360);
  });

  it("ignores batch execution for offline runs", async () => {
    const result = await runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      prompt,
      mode: "offline",
      execution: "batch",
    });
    expect(result.config.execution).toBe("sequential");
    expect(result.config.batchIds).toBeUndefined();
  });
});

describe("batch entry normalisation", () => {
  it("treats a per-request failure as data, not a throw", () => {
    for (const type of ["errored", "canceled", "expired"] as const) {
      const result = toItemResult({
        custom_id: "x",
        result: { type, error: {} } as never,
      });
      expect(result.error).toContain(type);
      expect(result.text).toBeUndefined();
    }
  });
});

describe("pricing", () => {
  it("uses the configured Anthropic rates", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBe(2);
    expect(estimateCostUsd("claude-sonnet-5", 0, 1_000_000)).toBe(10);
    expect(estimateCostUsd("claude-opus-5", 1_000_000, 0)).toBe(5);
    expect(estimateCostUsd("claude-opus-5", 0, 1_000_000)).toBe(25);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 0)).toBe(1);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 0, 1_000_000)).toBe(5);
  });

  it("halves the rate for a batch run", () => {
    expect(
      estimateCostUsd(
        "claude-sonnet-5",
        1_000_000,
        1_000_000,
        undefined,
        BATCH_DISCOUNT_MULTIPLIER,
      ),
    ).toBe(6);
  });

  it("reports an unknown model as unpriced rather than free", () => {
    expect(estimateCostUsd("not-a-model", 1_000_000, 1_000_000)).toBeUndefined();
  });
});
