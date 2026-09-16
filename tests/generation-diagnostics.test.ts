import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { salvageJsonArrayItems } from "../src/ai/generation/json";
import {
  generateSyntheticCasesBatch,
  outputTokenBudget,
  planBatches,
  plannedCaseCount,
  trimPlanToCaseLimit,
} from "../src/evals/generate-cases";
import { UsageTracker } from "../src/evals/paid-guard";
import { fakeBatchClient } from "./helpers/fake-batch-client";
import type { EvalCase } from "../src/schemas/eval-case";

/**
 * Regression cover for the 2026-09-16 synthetic generation run, which paid
 * for 400 planned cases and kept 60. Each test below pins one of the causes.
 */

// The synthetic corpus when it is present, else the tracked human seed, so
// this file runs in CI before any generated corpus is committed.
const corpusPath = existsSync("evals/datasets/generated.jsonl")
  ? "evals/datasets/generated.jsonl"
  : "evals/datasets/seed.jsonl";

const corpus: EvalCase[] = readFileSync(corpusPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as EvalCase);

/** A reply in the shape the model actually returns, from real case text. */
function reply(cases: EvalCase[]): string {
  return JSON.stringify(
    { cases: cases.map((c) => ({ input: c.input, expected: c.expected })) },
    null,
    2,
  );
}

describe("truncated generation replies", () => {
  it("keeps the complete cases when a reply is cut off mid-case", () => {
    const full = reply(corpus.slice(0, 8));
    const cut = full.slice(0, Math.floor(full.length * 0.8));

    // The old all-or-nothing parse lost all eight to one unterminated case.
    const salvage = salvageJsonArrayItems(cut, "cases");
    expect(salvage.truncated).toBe(true);
    expect(salvage.items.length).toBeGreaterThan(3);
    expect(salvage.items.length).toBeLessThan(8);
  });

  it("reports truncation as a request outcome and still validates each case", async () => {
    const full = reply(corpus.slice(0, 8));
    const specs = planBatches({ ordinary: 8, edge: 0, adversarial: 0 }, 8);

    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({
        text: full.slice(0, Math.floor(full.length * 0.8)),
        stopReason: "max_tokens",
      })),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });

    expect(report.diagnostics.requestOutcomes["truncated-salvaged"]).toBe(1);
    expect(report.accepted.length).toBe(report.diagnostics.casesReturned);
    expect(report.accepted.length).toBeGreaterThan(0);
    expect(report.diagnostics.casesNeverReturned).toBe(
      8 - report.accepted.length,
    );
  });

  it("treats max_tokens as truncation even when the text happens to parse", async () => {
    const specs = planBatches({ ordinary: 8, edge: 0, adversarial: 0 }, 8);
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({
        text: reply(corpus.slice(0, 2)),
        stopReason: "max_tokens",
      })),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });
    expect(report.diagnostics.requestOutcomes["truncated-salvaged"]).toBe(1);
    expect(report.diagnostics.requestOutcomes.complete).toBe(0);
  });

  it("budgets enough output tokens for a full batch of real cases", () => {
    const [spec] = planBatches({ ordinary: 8, edge: 0, adversarial: 0 }, 8);
    const longest = [...corpus]
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)
      .slice(0, 8);
    // ~3.6 characters per token is a deliberately pessimistic ratio for JSON.
    const needed = reply(longest).length / 3.6;
    expect(outputTokenBudget(spec!)).toBeGreaterThan(needed * 1.3);
  });
});

describe("generation rejection accounting", () => {
  const specs = planBatches({ ordinary: 4, edge: 0, adversarial: 0 }, 4);

  it("does not invent rejected candidates for a reply it never parsed", async () => {
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({ text: "I cannot help with that." })),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });
    expect(report.diagnostics.requestOutcomes.unparseable).toBe(1);
    expect(report.rejected).toBe(0);
    expect(report.diagnostics.casesReturned).toBe(0);
    expect(report.diagnostics.casesNeverReturned).toBe(4);
  });

  it("attributes schema failures to the field that failed", async () => {
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({
        text: JSON.stringify({
          cases: [
            { input: "no expected block" },
            { input: "empty behaviour", expected: { expectedBehaviour: "" } },
            { nope: true },
          ],
        }),
      })),
      specs,
      existing: [],
      usage: new UsageTracker(),
    });

    expect(report.accepted).toHaveLength(0);
    expect(report.diagnostics.caseRejections["schema-invalid"]).toBe(2);
    expect(report.diagnostics.caseRejections["missing-input-field"]).toBe(1);
    expect(Object.keys(report.diagnostics.schemaIssues).join(" ")).toContain(
      "expected",
    );
  });

  it("counts cases discarded by the case cap instead of dropping them silently", async () => {
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({ text: reply(corpus.slice(0, 4)) })),
      specs,
      existing: [],
      usage: new UsageTracker(),
      maxCases: 2,
    });

    expect(report.accepted).toHaveLength(2);
    expect(report.diagnostics.caseRejections["case-cap-reached"]).toBe(2);
  });

  it("separates duplicates of the corpus from duplicates within the run", async () => {
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", () => ({
        text: reply([corpus[0]!, corpus[1]!, corpus[1]!, corpus[2]!]),
      })),
      specs,
      existing: [corpus[0]!],
      usage: new UsageTracker(),
    });

    expect(report.diagnostics.caseRejections["duplicate-of-existing"]).toBe(1);
    expect(report.diagnostics.caseRejections["duplicate-within-run"]).toBe(1);
    expect(report.accepted).toHaveLength(2);
  });

  it("accounts for every planned case exactly once", async () => {
    const plan = planBatches({ ordinary: 8, edge: 8, adversarial: 8 }, 4);
    let n = 0;
    const report = await generateSyntheticCasesBatch({
      client: fakeBatchClient("generation", (request) => {
        n += 1;
        if (n === 1) return { error: "Batch request errored." };
        if (n === 2) return { text: "sorry, no JSON here" };
        return {
          text: reply(corpus.slice((n * 4) % 40, ((n * 4) % 40) + 4)),
        };
      }),
      specs: plan,
      existing: [],
      usage: new UsageTracker(),
    });

    const d = report.diagnostics;
    const rejectedOrDropped = Object.values(d.caseRejections).reduce(
      (a, b) => a + b,
      0,
    );
    expect(d.plannedCases).toBe(plannedCaseCount(plan));
    expect(
      report.accepted.length + rejectedOrDropped + d.casesNeverReturned,
    ).toBe(d.plannedCases);
  });
});

describe("case cap is applied to the plan", () => {
  it("trims the plan rather than paying for cases it will discard", () => {
    const plan = planBatches({ ordinary: 200, edge: 100, adversarial: 100 }, 8);
    expect(plannedCaseCount(plan)).toBe(400);
    expect(plan).toHaveLength(51);

    // What EVAL_MAX_CASES=60 should have done to the 2026-09-16 run.
    const trimmed = trimPlanToCaseLimit(plan, 60);
    expect(plannedCaseCount(trimmed)).toBe(60);
    expect(trimmed.length).toBeLessThanOrEqual(8);
  });

  it("leaves an uncapped plan alone", () => {
    const plan = planBatches({ ordinary: 16, edge: 0, adversarial: 0 }, 8);
    expect(trimPlanToCaseLimit(plan, undefined)).toEqual(plan);
  });
});

describe("batch plan diversity", () => {
  const plan = planBatches({ ordinary: 200, edge: 100, adversarial: 100 }, 8);

  it("does not repeat the same category/difficulty/angle triple", () => {
    // Indexing category, angle and difficulty off one counter made all three
    // periodic on 6, so 25 ordinary batches asked 6 distinct questions.
    const ordinary = plan.filter((s) => s.kind === "ordinary");
    const triples = new Set(
      ordinary.map((s) => `${s.category}|${s.difficulty}|${s.angle}`),
    );
    expect(triples.size).toBe(ordinary.length);
  });

  it("reaches every category, at more than one difficulty", () => {
    for (const kind of ["ordinary", "edge"] as const) {
      const subset = plan.filter((s) => s.kind === kind);
      expect(new Set(subset.map((s) => s.category)).size).toBe(6);
      expect(new Set(subset.map((s) => s.difficulty)).size).toBe(2);
    }
    // Adversarial batches alternate with prompt-injection and must still
    // reach the other six categories, not only every second one.
    const adversarial = plan.filter((s) => s.kind === "adversarial");
    expect(new Set(adversarial.map((s) => s.category)).size).toBe(7);
  });
});
