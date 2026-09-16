import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareRuns } from "../src/evals/compare";
import { planBatches, synthenticCaseId } from "../src/evals/generate-cases";
import { computeMetrics, evaluateGates } from "../src/evals/metrics";
import {
  PaidEvalsDisabledError,
  resolveCaseLimit,
  UsageTracker,
} from "../src/evals/paid-guard";
import { runExperiment } from "../src/evals/run-experiment";
import { resetEnvCache } from "../src/config/env";
import { loadDatasets } from "../src/evals/dataset";
import type { EvalCase } from "../src/schemas/eval-case";

const cases: EvalCase[] = loadDatasets(["seed.jsonl", "adversarial.jsonl"]).slice(0, 12);

// Every variable a test in this file reads or sets. Each test starts from a
// known state regardless of the caller's shell, and the caller's values are
// restored afterwards.
const ENV_KEYS = ["ALLOW_PAID_EVALS", "EVAL_MAX_CASES", "ANTHROPIC_API_KEY"] as const;
let ambientEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  ambientEnv = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) ambientEnv[key] = value;
    delete process.env[key];
  }
  resetEnvCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ambientEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
});

describe("paid execution controls", () => {
  it("refuses a live run unless paid evals are explicitly enabled", async () => {
    // The guard must fire before any client is built, so the outcome cannot
    // depend on whether ANTHROPIC_API_KEY happens to exist.
    process.env.ALLOW_PAID_EVALS = "false";
    resetEnvCache();
    await expect(
      runExperiment({
        cases,
        datasetId: "human",
        datasetFiles: ["seed.jsonl"],
        prompt: {
          id: "p",
          version: 1,
          description: "d",
          createdAt: "2026-01-01",
          systemPrompt: "s",
        },
        mode: "live",
      }),
    ).rejects.toBeInstanceOf(PaidEvalsDisabledError);
  });

  it("applies the tighter of the requested and configured case limits", () => {
    process.env.EVAL_MAX_CASES = "10";
    resetEnvCache();
    expect(resolveCaseLimit(50)).toBe(10);
    expect(resolveCaseLimit(3)).toBe(3);
    expect(resolveCaseLimit()).toBe(10);
  });

  it("reports cost as unavailable when no pricing is configured", () => {
    const tracker = new UsageTracker(1);
    tracker.record("some-model", 1000, 500);
    expect(tracker.inputTokens).toBe(1000);
    expect(tracker.estimatedCostUsd).toBeUndefined();
    expect(() => tracker.assertWithinBudget()).not.toThrow();
  });
});

describe("offline experiment runs", () => {
  it("evaluates every case without calling a model", async () => {
    const run = await runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl", "adversarial.jsonl"],
      prompt: {
        id: "support-v1",
        version: 1,
        description: "d",
        createdAt: "2026-01-01",
        systemPrompt: "s",
      },
      mode: "offline",
    });

    expect(run.cases).toHaveLength(cases.length);
    expect(run.config.mode).toBe("offline");
    expect(run.config.generationModel).toBe("offline-deterministic-stub");
    expect(run.usage.inputTokens).toBe(0);
    expect(run.cases.every((c) => c.rubric === undefined)).toBe(true);
  });

  it("produces metrics with no fabricated rubric means", async () => {
    const run = await runExperiment({
      cases,
      datasetId: "human",
      datasetFiles: ["seed.jsonl"],
      prompt: {
        id: "support-v1",
        version: 1,
        description: "d",
        createdAt: "2026-01-01",
        systemPrompt: "s",
      },
      mode: "offline",
    });
    const metrics = computeMetrics(run);
    expect(metrics.rubric.policyCompliance).toBeUndefined();
    expect(metrics.rubric.judgedCases).toBe(0);
    expect(metrics.deterministicPassRate).toBeGreaterThan(0);
  });
});

describe("promotion gates", () => {
  it("does not pass a gate that has no measurement", () => {
    const gates = evaluateGates({
      cases: 1,
      errors: 0,
      rubric: { judgedCases: 0, unjudgedCases: 1, coverage: 0 },
      deterministicPassRate: 1,
      evaluatorPassRates: { "unauthorized-action-claims": 1 },
      adversarialCases: 0,
      latencyMeanMs: 1,
      latencyMedianMs: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
    expect(byId["policy-compliance-mean"]?.passed).toBe(false);
    expect(byId["policy-compliance-mean"]?.note).toBeTruthy();
    expect(byId["unauthorized-action-pass-rate"]?.passed).toBe(true);
  });
});

describe("compareRuns", () => {
  async function offlineRun(id: string, subset: EvalCase[]) {
    const run = await runExperiment({
      cases: subset,
      datasetId: id,
      datasetFiles: ["seed.jsonl"],
      prompt: {
        id: "support-v1",
        version: 1,
        description: "d",
        createdAt: "2026-01-01",
        systemPrompt: "s",
      },
      mode: "offline",
    });
    return run;
  }

  it("warns when runs use different datasets", async () => {
    const a = await offlineRun("human", cases);
    const b = await offlineRun("seed", cases);
    const comparison = compareRuns([a, b]);
    expect(comparison.warnings.join(" ")).toMatch(/not directly comparable/);
  });

  it("reports no changes when two identical runs are compared", async () => {
    const a = await offlineRun("human", cases);
    const b = await offlineRun("human", cases);
    const comparison = compareRuns([a, b]);
    expect(comparison.improvements).toHaveLength(0);
    expect(comparison.regressions).toHaveLength(0);
  });

  it("requires at least two runs", async () => {
    const a = await offlineRun("human", cases);
    expect(() => compareRuns([a])).toThrow(/at least two/);
  });
});

describe("synthetic generation planning", () => {
  it("covers all three kinds and rotates angles", () => {
    const specs = planBatches({ ordinary: 24, edge: 16, adversarial: 16 }, 8);
    expect(specs).toHaveLength(7);
    expect(new Set(specs.map((s) => s.kind))).toEqual(
      new Set(["ordinary", "edge", "adversarial"]),
    );
    const adversarial = specs.filter((s) => s.kind === "adversarial");
    expect(new Set(adversarial.map((s) => s.angle)).size).toBe(adversarial.length);
  });

  it("derives stable ids from case text", () => {
    expect(synthenticCaseId("Refund me  ")).toBe(synthenticCaseId("refund me"));
    expect(synthenticCaseId("a")).not.toBe(synthenticCaseId("b"));
  });
});
