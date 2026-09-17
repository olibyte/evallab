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

/**
 * Output ceiling for one judge call, on both the sequential and the Batch
 * API paths. `judge-rubric-v2` writes a rationale before every score, and
 * on Claude 5 judges adaptive thinking counts against the same ceiling. At
 * 800 tokens 44 of 229 replies in the first dev baseline (2026-09-17)
 * stopped on `max_tokens`; at 1600, 1 to 3 replies per 229-case run still
 * did, and each one failed the judge-coverage gate for the whole run.
 * Truncation is a judge failure, never a partial score: see
 * `parseJudgeOutput`.
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 4096;

/** The stop reason the API reports when a reply hit the output ceiling. */
export const TRUNCATED_STOP_REASON = "max_tokens";

export const JUDGE_TRUNCATED_MESSAGE =
  "Judge reply was truncated at the output ceiling (stop_reason=max_tokens); no rubric was scored.";

export const JUDGE_MALFORMED_MESSAGE = "Judge did not return a valid rubric evaluation.";

export function isTruncated(stopReason: string | undefined): boolean {
  return stopReason === TRUNCATED_STOP_REASON;
}

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
    message: string = JUDGE_MALFORMED_MESSAGE,
  ) {
    super("malformed-output", message, { cause });
    this.name = "JudgeOutputError";
  }
}

/**
 * A reply cut off by the output ceiling. It is reported separately from a
 * malformed reply because the fix is different (raise the ceiling, not the
 * prompt), and it is never parsed: whatever JSON survived the cut is not
 * the judge's verdict.
 */
export class JudgeTruncatedError extends JudgeOutputError {
  constructor(judgeModel: string, inputTokens: number, outputTokens: number) {
    super(undefined, judgeModel, inputTokens, outputTokens, JUDGE_TRUNCATED_MESSAGE);
    this.name = "JudgeTruncatedError";
  }
}

/**
 * Parses judge text; a malformed reply is a failure, never a default score.
 * A reply that stopped on `max_tokens` is refused before parsing, even when
 * the text happens to parse, so a truncated rationale can never be scored.
 */
export function parseJudgeOutput(
  text: string,
  usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    stopReason?: string;
  } = {
    model: "unknown",
    inputTokens: 0,
    outputTokens: 0,
  },
): RubricEvaluation {
  if (isTruncated(usage.stopReason)) {
    throw new JudgeTruncatedError(usage.model, usage.inputTokens, usage.outputTokens);
  }
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
