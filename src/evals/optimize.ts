import { z } from "zod";
import type { ModelClient } from "@/src/ai/client/anthropic";
import { ModelError } from "@/src/ai/client/errors";
import { extractJsonObject } from "@/src/ai/generation/json";
import { promptOptimizerPromptV1 } from "@/src/ai/prompts/judges/prompt-optimizer-v1";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { caseVerdict } from "./compare";
import type { PromptCandidate } from "./candidates";
import { evaluateGates, type RunMetrics } from "./metrics";
import type { ExperimentRun } from "./results";
import type { UsageTracker } from "./paid-guard";

const proposalSchema = z.object({
  candidates: z
    .array(
      z.object({
        description: z.string().min(1),
        systemPrompt: z.string().min(200),
      }),
    )
    .min(1),
});

/** Failed cases from a baseline run, most informative first. */
export function selectFailures(run: ExperimentRun, limit = 12) {
  return run.cases
    .filter((c) => caseVerdict(c) !== "pass")
    .sort((a, b) => Number(b.adversarial) - Number(a.adversarial))
    .slice(0, limit);
}

export function buildOptimizerUserContent(
  prompt: PromptDefinition,
  failures: ReturnType<typeof selectFailures>,
  candidateCount: number,
): string {
  const failureText = failures
    .map((failure, index) =>
      [
        `Failure ${index + 1} (${failure.category}, adversarial=${failure.adversarial})`,
        `  customer message: ${failure.input}`,
        `  assistant response: ${failure.output?.response ?? "(generation failed)"}`,
        `  failed checks: ${failure.deterministic
          .filter((r) => r.passed === false)
          .map((r) => `${r.evaluatorId} - ${r.rationale ?? ""}`)
          .join("; ") || failure.error || "unknown"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "<current_system_prompt>",
    prompt.systemPrompt,
    "</current_system_prompt>",
    "",
    "<observed_failures>",
    failureText || "(no deterministic failures were recorded in this run)",
    "</observed_failures>",
    "",
    `Propose exactly ${candidateCount} candidates.`,
    "Reply with a single JSON object and nothing else:",
    '{ "candidates": [ { "description": string, "systemPrompt": string } ] }',
  ].join("\n");
}

export type ProposeOptions = {
  client: ModelClient;
  prompt: PromptDefinition;
  baseline: ExperimentRun;
  optimizationRunId: string;
  candidateCount: number;
  usage: UsageTracker;
};

/** Proposes candidates. Never touches ACTIVE_SUPPORT_PROMPT. */
export async function proposeCandidates(
  options: ProposeOptions,
): Promise<PromptCandidate[]> {
  const failures = selectFailures(options.baseline);
  const result = await options.client.complete({
    system: promptOptimizerPromptV1.systemPrompt,
    userContent: buildOptimizerUserContent(
      options.prompt,
      failures,
      options.candidateCount,
    ),
    maxOutputTokens: 8000,
    temperature: 1,
  });
  options.usage.record(result.model, result.inputTokens, result.outputTokens);

  const parsed = proposalSchema.safeParse(extractJsonObject(result.text));
  if (!parsed.success) {
    throw new ModelError(
      "malformed-output",
      "Prompt optimizer did not return valid candidate proposals.",
      { cause: parsed.error },
    );
  }

  const createdAt = new Date().toISOString();
  return parsed.data.candidates
    .slice(0, options.candidateCount)
    .map((candidate, index) => ({
      candidateId: `${options.optimizationRunId}-c${index + 1}`,
      parentPromptId: options.prompt.id,
      optimizationRunId: options.optimizationRunId,
      description: candidate.description,
      createdAt,
      systemPrompt: candidate.systemPrompt,
    }));
}

export type Recommendation = {
  candidateId?: string;
  promote: false;
  summary: string;
  detail: string[];
};

/**
 * Produces a recommendation, never an automatic promotion: a candidate is
 * only ever *recommended* for a manual source-code change.
 */
export function buildRecommendation(
  baseline: { metrics: RunMetrics },
  candidates: { candidateId: string; metrics: RunMetrics }[],
): Recommendation {
  const detail: string[] = [];

  const eligible = candidates.filter((candidate) => {
    const gates = evaluateGates(candidate.metrics);
    const failed = gates.filter((gate) => !gate.passed);
    if (failed.length > 0) {
      detail.push(
        `${candidate.candidateId}: blocked by ${failed.map((g) => g.id).join(", ")}.`,
      );
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return {
      promote: false,
      summary: "No candidate passed every hard gate. Keep the current prompt.",
      detail,
    };
  }

  const scored = eligible
    .map((candidate) => ({
      candidate,
      score: candidate.metrics.rubric.automatedQualityScore ?? -1,
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const baselineScore = baseline.metrics.rubric.automatedQualityScore;

  if (baselineScore !== undefined && best.score <= baselineScore) {
    detail.push(
      `Best candidate scored ${best.score.toFixed(1)} against a baseline of ${baselineScore.toFixed(1)}.`,
    );
    return {
      promote: false,
      summary: "No candidate beat the baseline. Keep the current prompt.",
      detail,
    };
  }

  detail.push(
    `${best.candidate.candidateId} passed all gates with an automated quality score of ${best.score.toFixed(1)}.`,
  );
  return {
    candidateId: best.candidate.candidateId,
    promote: false,
    summary: `${best.candidate.candidateId} is recommended for review. Promotion requires a manual source change: add a new immutable prompt version and update ACTIVE_SUPPORT_PROMPT.`,
    detail,
  };
}
