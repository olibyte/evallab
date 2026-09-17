import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENERATION_MAX_OUTPUT_TOKENS,
  GENERATION_TRUNCATED_MESSAGE,
  generateSupportResponse,
  GenerationOutputError,
  GenerationTruncatedError,
} from "../src/ai/generation/generate-support-response";
import { resetEnvCache } from "../src/config/env";
import { computeMetrics, evaluateGates } from "../src/evals/metrics";
import { runExperiment } from "../src/evals/run-experiment";
import type { EvalCase } from "../src/schemas/eval-case";
import { fakeBatchClient, type SubmittedBatch } from "./helpers/fake-batch-client";
import { fakeModelClient, type Recorded } from "./helpers/fake-model-client";

const GENERATION = JSON.stringify({
  response: "I can't issue refunds myself, but I can escalate this for human review.",
  escalationRequired: true,
  escalationReason: "Requires human review.",
  policyReferences: ["Refunds"],
});

const RUBRIC = JSON.stringify({
  policyCompliance: { rationale: "r", score: 5 },
  groundedness: { rationale: "r", score: 5 },
  helpfulness: { rationale: "r", score: 5 },
  tone: { rationale: "r", score: 5 },
});

const prompt = { id: "p", version: 1, description: "d", createdAt: "2026-01-01", systemPrompt: "system" };

/**
 * In the 2026-09-17 dev baseline `gen-733f267984ea` stopped on `max_tokens`
 * on both attempts at the 1024-token ceiling, with 181 and 210 characters
 * of visible text, and was reported as "did not return valid structured
 * output". Truncation is now named, refused before parsing, retried once
 * like a malformed reply, and counted as a generation failure.
 */
describe("generation truncation on the sequential path", () => {
  it("sets the ceiling to 2048 and sends it on every attempt", async () => {
    expect(GENERATION_MAX_OUTPUT_TOKENS).toBe(2048);
    const recorded: Recorded[] = [];
    await expect(
      generateSupportResponse({
        message: "hi",
        prompt,
        client: fakeModelClient(
          "generation",
          [{ text: GENERATION, stopReason: "max_tokens" }, { text: GENERATION, stopReason: "max_tokens" }],
          recorded,
        ),
      }),
    ).rejects.toThrow(GenerationTruncatedError);
    expect(recorded).toHaveLength(2);
    for (const call of recorded) expect(call.maxOutputTokens).toBe(2048);
  });

  it("refuses a truncated reply even when its text parses, and never salvages a cut one", async () => {
    for (const text of [GENERATION, GENERATION.slice(0, 60)]) {
      const client = fakeModelClient("generation", [
        { text, stopReason: "max_tokens" },
        { text, stopReason: "max_tokens" },
      ]);
      let caught: unknown;
      try {
        await generateSupportResponse({ message: "hi", prompt, client });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GenerationTruncatedError);
      expect((caught as Error).message).toContain("truncated at the output ceiling");
      // Both attempts' tokens are carried so the run can bill them.
      expect((caught as GenerationTruncatedError).outputTokens).toBe(100);
    }
  });

  it("keeps a malformed reply distinct from a truncated one", async () => {
    let caught: unknown;
    try {
      await generateSupportResponse({
        message: "hi",
        prompt,
        client: fakeModelClient("generation", [
          { text: "not json", stopReason: "end_turn" },
          { text: "{\"response\": 1}", stopReason: "end_turn" },
        ]),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GenerationOutputError);
    expect(caught).not.toBeInstanceOf(GenerationTruncatedError);
    expect((caught as Error).message).toMatch(/did not return valid structured output/);
  });

  it("classifies by the last attempt: truncated then malformed is malformed, malformed then truncated is truncated", async () => {
    const run = (replies: { text: string; stopReason: string }[]) =>
      generateSupportResponse({ message: "hi", prompt, client: fakeModelClient("generation", replies) });
    await expect(
      run([{ text: GENERATION, stopReason: "max_tokens" }, { text: "garbage", stopReason: "end_turn" }]),
    ).rejects.toThrow(/did not return valid structured output/);
    await expect(
      run([{ text: "garbage", stopReason: "end_turn" }, { text: GENERATION, stopReason: "max_tokens" }]),
    ).rejects.toThrow(GenerationTruncatedError);
  });

  it("preserves the single retry: a truncated first attempt followed by a complete reply succeeds", async () => {
    const recorded: Recorded[] = [];
    const result = await generateSupportResponse({
      message: "hi",
      prompt,
      client: fakeModelClient(
        "generation",
        [{ text: GENERATION, stopReason: "max_tokens" }, { text: GENERATION, stopReason: "end_turn" }],
        recorded,
      ),
    });
    expect(result.output.escalationRequired).toBe(true);
    expect(recorded).toHaveLength(2);
    expect(result.outputTokens).toBe(100);
  });

  it("still parses a complete reply that ended normally, and one with no stop reason", async () => {
    for (const reply of [{ text: GENERATION, stopReason: "end_turn" }, GENERATION]) {
      const result = await generateSupportResponse({
        message: "hi",
        prompt,
        client: fakeModelClient("generation", [reply]),
      });
      expect(result.output.policyReferences).toEqual(["Refunds"]);
    }
  });
});

describe("generation truncation inside experiment runs", () => {
  const ENV_KEYS = ["ALLOW_PAID_EVALS", "ANTHROPIC_API_KEY", "EVAL_MAX_CASES"] as const;
  let ambient: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    ambient = {};
    for (const key of ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) ambient[key] = value;
      delete process.env[key];
    }
    process.env.ALLOW_PAID_EVALS = "true";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    resetEnvCache();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = ambient[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  });

  const cases: EvalCase[] = [1, 2, 3].map((n) => ({
    id: `t-${n}`,
    category: "refund",
    input: `Case ${n}: my renewal charged me.`,
    expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
    adversarial: false,
    difficulty: "medium",
    source: "human",
  }));

  it("sequential: a case truncated twice has no output, names truncation, and fails generation success", async () => {
    const run = await runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      prompt,
      mode: "live",
      execution: "sequential",
      createClient: (role) =>
        role === "generation"
          ? fakeModelClient("generation", [
              GENERATION,
              { text: GENERATION, stopReason: "max_tokens" },
              { text: GENERATION, stopReason: "max_tokens" },
              GENERATION,
            ])
          : fakeModelClient("judge", [RUBRIC, RUBRIC]),
    });

    const truncated = run.cases.find((c) => c.caseId === "t-2");
    expect(truncated?.output).toBeUndefined();
    expect(truncated?.error).toMatch(/truncated at the output ceiling \(stop_reason=max_tokens\)/);
    expect(truncated?.rubric).toBeUndefined();
    expect(truncated?.deterministic.find((d) => d.evaluatorId === "structured-output-validity")?.passed).toBe(false);
    expect(truncated?.outputTokens).toBe(100);
    expect(run.config.generationParams?.maxOutputTokens).toBe(2048);

    const metrics = computeMetrics(run);
    expect(metrics.errors).toBe(1);
    expect(evaluateGates(metrics).find((g) => g.id === "generation-success-rate")?.passed).toBe(false);
  });

  function batchRun(
    respond: Parameters<typeof fakeBatchClient>[1],
    submitted: SubmittedBatch[],
    progress: string[] = [],
  ) {
    return runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      prompt,
      mode: "live",
      execution: "batch",
      createBatchClient: (role) => fakeBatchClient(role, respond, submitted),
      onBatchProgress: (stage, status, counts) =>
        progress.push(
          `${stage} ${status} ${Object.entries(counts)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")}`,
        ),
    });
  }

  it("batch: sends the 2048 ceiling on every generation request, retries a truncated reply once, then records truncation", async () => {
    const submitted: SubmittedBatch[] = [];
    const progress: string[] = [];
    const run = await batchRun(
      (request) =>
        request.system !== "system"
          ? { text: RUBRIC }
          : request.customId === "t-2"
            ? { text: GENERATION.slice(0, 40), stopReason: "max_tokens" }
            : { text: GENERATION, stopReason: "end_turn" },
      submitted,
      progress,
    );

    expect(submitted.map((b) => b.batchId)).toEqual(["batch_generation_1", "batch_generation_2", "batch_judge_1"]);
    expect(submitted[1]?.requests.map((r) => r.customId)).toEqual(["t-2"]);
    for (const batch of submitted.slice(0, 2)) {
      for (const request of batch.requests) expect(request.maxOutputTokens).toBe(2048);
    }
    const truncated = run.cases.find((c) => c.caseId === "t-2");
    expect(truncated?.output).toBeUndefined();
    expect(truncated?.error).toBe(GENERATION_TRUNCATED_MESSAGE);
    expect(truncated?.outputTokens).toBe(120);
    expect(submitted[2]?.requests.map((r) => r.customId)).toEqual(["t-1", "t-3"]);
    expect(computeMetrics(run).errors).toBe(1);

    // API completion and parsed outcome are reported as separate lines.
    expect(progress).toContain("generation api ended succeeded=3 errored=0");
    expect(progress).toContain("generation parsed valid_output=2 truncated=1 malformed=0 request_error=0");
    expect(progress).toContain("generation-retry parsed valid_output=0 truncated=1 malformed=0 request_error=0");
    expect(progress).toContain("generation final valid_output=2 truncated=1 malformed=0 request_error=0");
    expect(progress).toContain("judge parsed scored=2 truncated=0 malformed=0 request_error=0");
  });

  it("batch: a truncated first attempt followed by a complete retry is a valid case", async () => {
    const submitted: SubmittedBatch[] = [];
    const run = await batchRun(
      (request, attempt) =>
        request.system !== "system"
          ? { text: RUBRIC }
          : request.customId === "t-2" && attempt === 1
            ? { text: GENERATION, stopReason: "max_tokens" }
            : { text: GENERATION, stopReason: "end_turn" },
      submitted,
    );
    const retried = run.cases.find((c) => c.caseId === "t-2");
    expect(retried?.output?.escalationRequired).toBe(true);
    expect(retried?.error).toBeUndefined();
    expect(computeMetrics(run).errors).toBe(0);
  });

  it("batch: truncated and malformed replies are tallied apart", async () => {
    const progress: string[] = [];
    await batchRun(
      (request) =>
        request.system !== "system"
          ? { text: RUBRIC }
          : request.customId === "t-2"
            ? { text: GENERATION, stopReason: "max_tokens" }
            : request.customId === "t-3"
              ? { text: "garbage", stopReason: "end_turn" }
              : { text: GENERATION, stopReason: "end_turn" },
      [],
      progress,
    );
    expect(progress).toContain("generation final valid_output=1 truncated=1 malformed=1 request_error=0");
  });
});
