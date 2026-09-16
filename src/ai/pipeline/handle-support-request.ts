import { createModelClient } from "@/src/ai/client/anthropic";
import { judgeResponse } from "@/src/ai/evaluators/rubric-judge";
import { calculateQualityScore } from "@/src/ai/evaluators/quality-score";
import { generateSupportResponse } from "@/src/ai/generation/generate-support-response";
import { assessInjection } from "@/src/ai/guardrails/injection";
import { runOutputGuardrails } from "@/src/ai/guardrails/output-checks";
import { ACTIVE_SUPPORT_PROMPT } from "@/src/ai/prompts/support";
import { hasLiveJudgeCredentials } from "@/src/config/env";
import type { EvaluationState, RespondResult } from "./types";

export type HandleOptions = {
  message: string;
  /** Injected for tests; defaults to the configured clients. */
  createClient?: typeof createModelClient;
  now?: () => number;
};

/**
 * Orchestrates the live request pipeline. Every stage runs in order:
 * input guardrails, generation, structured-output validation, output
 * guardrails, evaluation. No stage is silently skipped.
 */
export async function handleSupportRequest(
  options: HandleOptions,
): Promise<RespondResult> {
  const { message } = options;
  const createClient = options.createClient ?? createModelClient;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const injection = assessInjection(message);

  const generation = await generateSupportResponse({
    message,
    prompt: ACTIVE_SUPPORT_PROMPT,
    client: createClient("generation"),
  });

  const outputChecks = runOutputGuardrails(generation.output);

  let evaluation: EvaluationState = {
    available: false,
    reason: "No judge model is configured.",
  };
  let judgeModel: string | undefined;

  if (hasLiveJudgeCredentials()) {
    try {
      const judged = await judgeResponse({
        message,
        output: generation.output,
        client: createClient("judge"),
      });
      judgeModel = judged.judgeModel;
      evaluation = {
        available: true,
        rubric: judged.rubric,
        automatedQualityScore: calculateQualityScore(judged.rubric),
      };
    } catch (error) {
      // Judge failure never fabricates scores and never discards a valid
      // support response.
      console.error("[evallab] judge evaluation failed", {
        kind: error instanceof Error ? error.name : "unknown",
      });
      evaluation = { available: false, reason: "Judge evaluation failed." };
    }
  }

  return {
    response: generation.output,
    guardrails: { injection, outputChecks },
    evaluation,
    metadata: {
      promptId: generation.promptId,
      generationModel: generation.model,
      judgeModel,
      latencyMs: now() - startedAt,
      source: "live",
    },
  };
}
