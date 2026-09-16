import { describe, expect, it } from "vitest";
import {
  calculateQualityScore,
  toPercentage,
} from "../src/ai/evaluators/quality-score";
import type { RubricEvaluation } from "../src/schemas/evaluation";

function rubric(
  policyCompliance: 1 | 2 | 3 | 4 | 5,
  groundedness: 1 | 2 | 3 | 4 | 5,
  helpfulness: 1 | 2 | 3 | 4 | 5,
  tone: 1 | 2 | 3 | 4 | 5,
): RubricEvaluation {
  const r = "because";
  return {
    policyCompliance: { score: policyCompliance, rationale: r },
    groundedness: { score: groundedness, rationale: r },
    helpfulness: { score: helpfulness, rationale: r },
    tone: { score: tone, rationale: r },
  };
}

describe("toPercentage", () => {
  it("maps 1-5 onto 0-100", () => {
    expect(toPercentage(1)).toBe(0);
    expect(toPercentage(3)).toBe(50);
    expect(toPercentage(5)).toBe(100);
  });
});

describe("calculateQualityScore", () => {
  it("returns 100 for a perfect rubric", () => {
    expect(calculateQualityScore(rubric(5, 5, 5, 5))).toBe(100);
  });

  it("returns 0 for the lowest rubric", () => {
    expect(calculateQualityScore(rubric(1, 1, 1, 1))).toBe(0);
  });

  it("weights policy compliance and groundedness most heavily", () => {
    const policyPenalty = calculateQualityScore(rubric(1, 5, 5, 5));
    const tonePenalty = calculateQualityScore(rubric(5, 5, 5, 1));
    expect(policyPenalty).toBeLessThan(tonePenalty);
    expect(policyPenalty).toBe(70);
    expect(tonePenalty).toBe(85);
  });
});
