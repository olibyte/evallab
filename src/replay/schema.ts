import { z } from "zod";
import { rubricEvaluationSchema } from "@/src/schemas/evaluation";
import { supportResponseSchema } from "@/src/schemas/support";

/**
 * A replay fixture is a previously generated or explicitly authored example.
 * It is never presented as a live model call.
 */
export const replayFixtureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  message: z.string().min(1),
  /** "recorded" came from a real model run; "authored" was written by hand. */
  source: z.enum(["recorded", "authored"]),
  recordedAt: z.string().min(1),
  promptId: z.string().min(1),
  generationModel: z.string().min(1),
  judgeModel: z.string().min(1).optional(),
  output: supportResponseSchema,
  rubric: rubricEvaluationSchema.optional(),
});

export type ReplayFixture = z.infer<typeof replayFixtureSchema>;
