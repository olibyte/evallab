import { createModelClient } from "@/src/ai/client/anthropic";
import { judgeResponse } from "@/src/ai/evaluators/rubric-judge";
import { calculateQualityScore } from "@/src/ai/evaluators/quality-score";
import { generateSupportResponse } from "@/src/ai/generation/generate-support-response";
import { assessInjection } from "@/src/ai/guardrails/injection";
import { runOutputGuardrails } from "@/src/ai/guardrails/output-checks";
import { redactSensitiveText } from "@/src/ai/guardrails/redact";
import { ACTIVE_SUPPORT_PROMPT } from "@/src/ai/prompts/support";
import { hasLiveJudgeCredentials } from "@/src/config/env";
import { estimateCostUsd } from "@/src/evals/pricing";
import { getObservability } from "@/src/observability";
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

  // Trace metadata gets the redacted message; the model gets the original.
  const observability = getObservability();
  const trace = observability.trace("support-request", {
    message: redactSensitiveText(message),
  });

  try {
    const guardrailSpan = trace.span("input-guardrails");
    const injection = assessInjection(message);
    guardrailSpan.end({ injection });

    const generationSpan = trace.span("generate-response", {
      promptId: ACTIVE_SUPPORT_PROMPT.id,
    });
    let generation;
    try {
      generation = await generateSupportResponse({
        message,
        prompt: ACTIVE_SUPPORT_PROMPT,
        client: createClient("generation"),
      });
    } catch (error) {
      generationSpan.fail(error);
      throw error;
    }
    generationSpan.end({
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      escalationRequired: generation.output.escalationRequired,
    });

    const outputSpan = trace.span("output-guardrails");
    const outputChecks = runOutputGuardrails(generation.output);
    outputSpan.end({ outputChecks });

    let evaluation: EvaluationState = {
      available: false,
      reason: "No judge model is configured.",
    };
    let judgeModel: string | undefined;

    if (hasLiveJudgeCredentials()) {
      const evaluationSpan = trace.span("live-evaluation");
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
        evaluationSpan.end({ rubric: judged.rubric });
      } catch (error) {
        // Judge failure never fabricates scores and never discards a valid
        // support response.
        evaluationSpan.fail(error);
        console.error("[evallab] judge evaluation failed", {
          kind: error instanceof Error ? error.name : "unknown",
        });
        evaluation = { available: false, reason: "Judge evaluation failed." };
      }
    }

    const latencyMs = now() - startedAt;

    trace.update({
      promptId: generation.promptId,
      generationModel: generation.model,
      judgeModel,
      latencyMs,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      estimatedCostUsd: estimateCostUsd(
        generation.model,
        generation.inputTokens,
        generation.outputTokens,
      ),
      guardrailFailure: outputChecks.some((check) => check.passed === false),
    });
    trace.end({ escalationRequired: generation.output.escalationRequired });

    return {
      response: generation.output,
      guardrails: { injection, outputChecks },
      evaluation,
      metadata: {
        promptId: generation.promptId,
        generationModel: generation.model,
        judgeModel,
        latencyMs,
        traceId: trace.id,
        source: "live",
      },
    };
  } finally {
    void observability.flush();
  }
}
