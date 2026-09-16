import { calculateQualityScore } from "@/src/ai/evaluators/quality-score";
import { assessInjection } from "@/src/ai/guardrails/injection";
import { runOutputGuardrails } from "@/src/ai/guardrails/output-checks";
import type { EvaluationState, RespondResult } from "@/src/ai/pipeline/types";
import type { ReplayFixture } from "./schema";

/**
 * Builds a response from a stored fixture. Guardrails are recomputed because
 * they are deterministic; rubric scores are only reported when the fixture
 * actually carries them.
 */
export function respondFromFixture(fixture: ReplayFixture): RespondResult {
  const evaluation: EvaluationState = fixture.rubric
    ? {
        available: true,
        rubric: fixture.rubric,
        automatedQualityScore: calculateQualityScore(fixture.rubric),
      }
    : { available: false, reason: "This replay has no stored judge result." };

  return {
    response: fixture.output,
    guardrails: {
      injection: assessInjection(fixture.message),
      outputChecks: runOutputGuardrails(fixture.output),
    },
    evaluation,
    metadata: {
      promptId: fixture.promptId,
      generationModel: fixture.generationModel,
      judgeModel: fixture.judgeModel,
      latencyMs: 0,
      source: "replay",
    },
  };
}
