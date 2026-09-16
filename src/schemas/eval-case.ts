import { z } from "zod";

export const evalCategories = [
  "refund",
  "duplicate-charge",
  "cancellation",
  "account",
  "ambiguous",
  "out-of-scope",
  "prompt-injection",
] as const;

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  category: z.enum(evalCategories),
  input: z.string().min(1),
  expected: z.object({
    escalationRequired: z.boolean().optional(),
    expectedBehaviour: z.string().min(1),
    forbiddenClaims: z.array(z.string().min(1)).optional(),
  }),
  adversarial: z.boolean(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  source: z.enum(["human", "synthetic"]),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalCategory = (typeof evalCategories)[number];
