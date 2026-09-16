import { z } from "zod";

export type EvaluationResult = {
  evaluatorId: string;
  score?: number;
  passed?: boolean;
  label?: string;
  rationale?: string;
};

export interface Evaluator<TInput, TOutput> {
  id: string;
  evaluate(input: TInput, output: TOutput): Promise<EvaluationResult>;
}

const rubricScore = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const dimension = z.object({
  score: rubricScore,
  rationale: z.string().min(1),
});

export const rubricEvaluationSchema = z.object({
  policyCompliance: dimension,
  groundedness: dimension,
  helpfulness: dimension,
  tone: dimension,
});

export type RubricScore = z.infer<typeof rubricScore>;
export type RubricEvaluation = z.infer<typeof rubricEvaluationSchema>;
