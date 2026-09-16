import type { ModelClient } from "@/src/ai/client/anthropic";
import { ModelError } from "@/src/ai/client/errors";
import { extractJsonObject } from "@/src/ai/generation/json";
import { ACTIVE_JUDGE_PROMPT } from "@/src/ai/prompts/judges";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { wrapUntrusted } from "@/src/ai/prompts/untrusted";
import {
  rubricEvaluationSchema,
  type RubricEvaluation,
} from "@/src/schemas/evaluation";
import type { SupportResponse } from "@/src/schemas/support";

export const JUDGE_MAX_OUTPUT_TOKENS = 800;

/**
 * Rationale precedes score in every dimension so the score is produced
 * after the evidence, not justified after the fact.
 */
const OUTPUT_CONTRACT = [
  "Reply with a single JSON object and nothing else. Write each rationale",
  "before its score:",
  "{",
  '  "policyCompliance": { "rationale": string, "score": 1-5 },',
  '  "groundedness":     { "rationale": string, "score": 1-5 },',
  '  "helpfulness":      { "rationale": string, "score": 1-5 },',
  '  "tone":             { "rationale": string, "score": 1-5 }',
  "}",
].join("\n");

export type JudgeRequest = {
  message: string;
  output: SupportResponse;
  client: ModelClient;
  timeoutMs?: number;
  /** Dropped by the client for models that have removed sampling params. */
  temperature?: number;
  /** Defaults to the active judge prompt; runs record which one was used. */
  judgePrompt?: PromptDefinition;
};

export type JudgeOutcome = {
  rubric: RubricEvaluation;
  judgeModel: string;
  judgePromptId: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Both blocks are untrusted. Delimiter look-alikes inside them are escaped
 * so neither the customer nor the response under test can close its own
 * block and address the judge directly.
 */
export function buildJudgeUserContent(
  message: string,
  output: SupportResponse,
): string {
  return [
    wrapUntrusted("customer_message", message),
    "",
    wrapUntrusted("assistant_response", JSON.stringify(output, null, 2)),
    "",
    OUTPUT_CONTRACT,
  ].join("\n");
}

export class JudgeOutputError extends ModelError {
  constructor(
    cause: unknown,
    readonly judgeModel: string,
    readonly inputTokens: number,
    readonly outputTokens: number,
  ) {
    super("malformed-output", "Judge did not return a valid rubric evaluation.", { cause });
    this.name = "JudgeOutputError";
  }
}

/** Parses judge text; a malformed reply is a failure, never a default score. */
export function parseJudgeOutput(
  text: string,
  usage: { model: string; inputTokens: number; outputTokens: number } = {
    model: "unknown",
    inputTokens: 0,
    outputTokens: 0,
  },
): RubricEvaluation {
  const parsed = rubricEvaluationSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    // The tokens were spent even though the reply is unusable; callers that
    // track spend read them off the error.
    throw new JudgeOutputError(parsed.error, usage.model, usage.inputTokens, usage.outputTokens);
  }
  return parsed.data;
}

/**
 * One consolidated judge call. Throws on failure; callers report evaluation
 * as unavailable rather than fabricating scores.
 */
export async function judgeResponse(
  request: JudgeRequest,
): Promise<JudgeOutcome> {
  const judgePrompt = request.judgePrompt ?? ACTIVE_JUDGE_PROMPT;
  const result = await request.client.complete({
    system: judgePrompt.systemPrompt,
    userContent: buildJudgeUserContent(request.message, request.output),
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    timeoutMs: request.timeoutMs,
    temperature: request.temperature,
  });

  return {
    rubric: parseJudgeOutput(result.text, result),
    judgeModel: result.model,
    judgePromptId: judgePrompt.id,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
