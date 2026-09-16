import type { EvaluationResult, RubricEvaluation } from "@/src/schemas/evaluation";
import type { InjectionAssessment } from "@/src/schemas/guardrails";
import type { SupportResponse } from "@/src/schemas/support";

export type EvaluationState =
  | { available: true; rubric: RubricEvaluation; automatedQualityScore: number }
  | { available: false; reason?: string };

export type RespondResult = {
  response: SupportResponse;
  guardrails: {
    injection: InjectionAssessment;
    outputChecks: EvaluationResult[];
  };
  evaluation: EvaluationState;
  metadata: {
    promptId: string;
    generationModel: string;
    judgeModel?: string;
    latencyMs: number;
    traceId?: string;
    /** Whether this response came from a live model call or a stored replay. */
    source: "live" | "replay";
  };
};
