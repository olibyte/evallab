import type { RubricEvaluation } from "@/src/schemas/evaluation";

export const QUALITY_SCORE_LABEL = "Automated quality score";
export const GUARDRAIL_FAILURE_LABEL = "Guardrail failure";

export const RUBRIC_WEIGHTS = {
  policyCompliance: 0.3,
  groundedness: 0.3,
  helpfulness: 0.25,
  tone: 0.15,
} as const;

/** Converts a 1-5 rubric score to a 0-100 scale. */
export function toPercentage(score: number): number {
  return ((score - 1) / 4) * 100;
}

/**
 * Weighted automated quality score, 0-100. Not objective ground truth, and
 * never a substitute for a deterministic guardrail failure.
 */
export function calculateQualityScore(rubric: RubricEvaluation): number {
  const weighted =
    toPercentage(rubric.policyCompliance.score) * RUBRIC_WEIGHTS.policyCompliance +
    toPercentage(rubric.groundedness.score) * RUBRIC_WEIGHTS.groundedness +
    toPercentage(rubric.helpfulness.score) * RUBRIC_WEIGHTS.helpfulness +
    toPercentage(rubric.tone.score) * RUBRIC_WEIGHTS.tone;

  return Math.round(weighted * 10) / 10;
}
