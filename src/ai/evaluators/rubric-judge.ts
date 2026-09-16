import type { ModelClient } from "@/src/ai/client/anthropic";
import { ModelError } from "@/src/ai/client/errors";
import { extractJsonObject } from "@/src/ai/generation/json";
import { rubricJudgePromptV1 } from "@/src/ai/prompts/judges/rubric-v1";
import {
  rubricEvaluationSchema,
  type RubricEvaluation,
} from "@/src/schemas/evaluation";
import type { SupportResponse } from "@/src/schemas/support";

const OUTPUT_CONTRACT = [
  "Reply with a single JSON object and nothing else:",
  "{",
  '  "policyCompliance": { "score": 1-5, "rationale": string },',
  '  "groundedness":     { "score": 1-5, "rationale": string },',
  '  "helpfulness":      { "score": 1-5, "rationale": string },',
  '  "tone":             { "score": 1-5, "rationale": string }',
  "}",
].join("\n");

export type JudgeRequest = {
  message: string;
  output: SupportResponse;
  client: ModelClient;
  timeoutMs?: number;
};

export type JudgeOutcome = {
  rubric: RubricEvaluation;
  judgeModel: string;
  judgePromptId: string;
};

export function buildJudgeUserContent(
  message: string,
  output: SupportResponse,
): string {
  return [
    "<customer_message>",
    message,
    "</customer_message>",
    "",
    "<assistant_response>",
    JSON.stringify(output, null, 2),
    "</assistant_response>",
    "",
    OUTPUT_CONTRACT,
  ].join("\n");
}

/**
 * One consolidated judge call. Throws on failure; callers report evaluation
 * as unavailable rather than fabricating scores.
 */
export async function judgeResponse(
  request: JudgeRequest,
): Promise<JudgeOutcome> {
  const result = await request.client.complete({
    system: rubricJudgePromptV1.systemPrompt,
    userContent: buildJudgeUserContent(request.message, request.output),
    maxOutputTokens: 800,
    timeoutMs: request.timeoutMs,
  });

  const parsed = rubricEvaluationSchema.safeParse(
    extractJsonObject(result.text),
  );

  if (!parsed.success) {
    throw new ModelError(
      "malformed-output",
      "Judge did not return a valid rubric evaluation.",
      { cause: parsed.error },
    );
  }

  return {
    rubric: parsed.data,
    judgeModel: result.model,
    judgePromptId: rubricJudgePromptV1.id,
  };
}
