import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_TRUNCATED_MESSAGE,
  JudgeOutputError,
  JudgeTruncatedError,
  judgeResponse,
  parseJudgeOutput,
} from "../src/ai/evaluators/rubric-judge";
import { resetEnvCache } from "../src/config/env";
import { computeMetrics, evaluateGates } from "../src/evals/metrics";
import { runExperiment } from "../src/evals/run-experiment";
import type { EvalCase } from "../src/schemas/eval-case";
import { fakeModelClient, type Recorded } from "./helpers/fake-model-client";

const RUBRIC = JSON.stringify({
  policyCompliance: { rationale: "r", score: 5 },
  groundedness: { rationale: "r", score: 5 },
  helpfulness: { rationale: "r", score: 5 },
  tone: { rationale: "r", score: 5 },
});

const GENERATION = JSON.stringify({
  response: "I can't issue refunds myself, but I can escalate this for human review.",
  escalationRequired: true,
  escalationReason: "Requires human review.",
  policyReferences: ["Refunds"],
});

const output = JSON.parse(GENERATION);

const usage = { model: "fake-judge-model", inputTokens: 100, outputTokens: 1600 };

/**
 * In the first dev baseline (2026-09-17) 44 of 229 judge replies stopped on
 * `max_tokens` at the old 800-token ceiling and were reported as malformed.
 * A truncated reply is a judge failure in its own right: named as such,
 * never salvaged, never scored, and counted against judge coverage.
 */
describe("judge truncation", () => {
  it("raises the output ceiling to 1600 tokens", () => {
    expect(JUDGE_MAX_OUTPUT_TOKENS).toBe(1600);
  });

  it("refuses a reply that stopped on max_tokens even when its text parses", () => {
    expect(() => parseJudgeOutput(RUBRIC, { ...usage, stopReason: "max_tokens" })).toThrow(
      JudgeTruncatedError,
    );
    expect(() => parseJudgeOutput(RUBRIC, { ...usage, stopReason: "max_tokens" })).toThrow(
      JUDGE_TRUNCATED_MESSAGE,
    );
  });

  it("does not salvage a rubric from a reply cut off mid-JSON", () => {
    const cut = RUBRIC.slice(0, RUBRIC.length - 20);
    expect(() => parseJudgeOutput(cut, { ...usage, stopReason: "max_tokens" })).toThrow(
      JudgeTruncatedError,
    );
  });

  it("still parses a complete reply that ended normally", () => {
    expect(parseJudgeOutput(RUBRIC, { ...usage, stopReason: "end_turn" }).tone.score).toBe(5);
    expect(parseJudgeOutput(RUBRIC, usage).tone.score).toBe(5);
  });

  it("keeps a malformed reply distinct from a truncated one", () => {
    let caught: unknown;
    try {
      parseJudgeOutput("not json", { ...usage, stopReason: "end_turn" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JudgeOutputError);
    expect(caught).not.toBeInstanceOf(JudgeTruncatedError);
  });

  it("carries the spent tokens on the truncation error so the run can bill them", () => {
    let caught: unknown;
    try {
      parseJudgeOutput(RUBRIC, { ...usage, stopReason: "max_tokens" });
    } catch (error) {
      caught = error;
    }
    const error = caught as JudgeTruncatedError;
    expect(error).toBeInstanceOf(JudgeOutputError);
    expect(error.judgeModel).toBe("fake-judge-model");
    expect(error.outputTokens).toBe(1600);
  });

  it("sequential judgeResponse sends the 1600 ceiling and surfaces truncation", async () => {
    const recorded: Recorded[] = [];
    const client = fakeModelClient("judge", [{ text: RUBRIC, stopReason: "max_tokens" }], recorded);
    await expect(judgeResponse({ message: "hi", output, client })).rejects.toThrow(
      JudgeTruncatedError,
    );
    expect(recorded[0]?.maxOutputTokens).toBe(1600);
  });
});

describe("truncated judge inside a sequential live run", () => {
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

  const cases: EvalCase[] = [1, 2].map((n) => ({
    id: `t-${n}`,
    category: "refund",
    input: `Case ${n}: my renewal charged me.`,
    expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
    adversarial: false,
    difficulty: "medium",
    source: "human",
  }));

  it("leaves the case unjudged, names truncation, and fails judge coverage", async () => {
    const recorded: Recorded[] = [];
    const run = await runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      prompt: { id: "p", version: 1, description: "d", createdAt: "2026-01-01", systemPrompt: "s" },
      mode: "live",
      execution: "sequential",
      createClient: (role) =>
        role === "generation"
          ? fakeModelClient("generation", [GENERATION, GENERATION], recorded)
          : fakeModelClient(
              "judge",
              [{ text: RUBRIC, stopReason: "end_turn" }, { text: RUBRIC, stopReason: "max_tokens" }],
              recorded,
            ),
    });

    const truncated = run.cases.find((c) => c.caseId === "t-2");
    expect(truncated?.output).toBeDefined();
    expect(truncated?.rubric).toBeUndefined();
    expect(truncated?.automatedQualityScore).toBeUndefined();
    expect(truncated?.judgeError).toBe(JUDGE_TRUNCATED_MESSAGE);
    // The truncated reply still cost tokens: generation 50 + judge 50.
    expect(truncated?.outputTokens).toBe(100);

    const metrics = computeMetrics(run);
    expect(metrics.rubric.judgedCases).toBe(1);
    expect(metrics.rubric.unjudgedCases).toBe(1);
    expect(metrics.rubric.coverage).toBe(0.5);
    const gates = evaluateGates(metrics);
    expect(gates.find((g) => g.id === "judge-coverage")?.passed).toBe(false);
    expect(gates.find((g) => g.id === "policy-compliance-mean")?.passed).toBe(false);

    const judgeCalls = recorded.filter((r) => r.role === "judge");
    expect(judgeCalls).toHaveLength(2);
    for (const call of judgeCalls) expect(call.maxOutputTokens).toBe(1600);
  });
});
