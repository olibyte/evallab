import { createModelClient, type ModelRole } from "@/src/ai/client/anthropic";
import { runDeterministicEvaluators } from "@/src/ai/evaluators/deterministic";
import { calculateQualityScore } from "@/src/ai/evaluators/quality-score";
import { judgeResponse } from "@/src/ai/evaluators/rubric-judge";
import { generateSupportResponse } from "@/src/ai/generation/generate-support-response";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { hasLiveJudgeCredentials } from "@/src/config/env";
import type { EvalCase } from "@/src/schemas/eval-case";
import { generateOfflineResponse } from "./offline-generator";
import { assertPaidEvalsAllowed, UsageTracker } from "./paid-guard";
import {
  buildRunId,
  type CaseResult,
  type ExperimentRun,
} from "./results";

export type RunMode = "live" | "offline";

export type RunExperimentOptions = {
  cases: EvalCase[];
  datasetId: string;
  datasetFiles: string[];
  prompt: PromptDefinition;
  promptSource?: "registry" | "candidate";
  candidateId?: string;
  mode: RunMode;
  maxCases?: number;
  maxSpendUsd?: number;
  judge?: boolean;
  createClient?: (role: ModelRole) => ReturnType<typeof createModelClient>;
  onProgress?: (done: number, total: number, caseId: string) => void;
  now?: () => number;
};

/**
 * Runs every case through the full evaluation pipeline and returns an
 * immutable run record. Live mode is a paid batch operation and refuses to
 * start unless ALLOW_PAID_EVALS=true.
 */
export async function runExperiment(
  options: RunExperimentOptions,
): Promise<ExperimentRun> {
  const {
    prompt,
    mode,
    datasetId,
    datasetFiles,
    createClient = createModelClient,
    now = () => Date.now(),
  } = options;

  if (mode === "live") assertPaidEvalsAllowed("eval:run --mode live");

  const selected =
    options.maxCases === undefined
      ? options.cases
      : options.cases.slice(0, options.maxCases);

  const usage = new UsageTracker(options.maxSpendUsd);
  const startedAt = new Date().toISOString();

  const judgeEnabled =
    mode === "live" && (options.judge ?? true) && hasLiveJudgeCredentials();

  const generationClient = mode === "live" ? createClient("generation") : undefined;
  const judgeClient = judgeEnabled ? createClient("judge") : undefined;

  const results: CaseResult[] = [];

  for (const [index, evalCase] of selected.entries()) {
    usage.assertWithinBudget();
    const startedMs = now();

    let output: CaseResult["output"];
    let error: string | undefined;
    let caseInputTokens = 0;
    let caseOutputTokens = 0;

    try {
      if (generationClient) {
        const generated = await generateSupportResponse({
          message: evalCase.input,
          prompt,
          client: generationClient,
        });
        output = generated.output;
        caseInputTokens = generated.inputTokens;
        caseOutputTokens = generated.outputTokens;
        usage.record(generated.model, generated.inputTokens, generated.outputTokens);
      } else {
        output = generateOfflineResponse(evalCase);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Generation failed.";
    }

    const deterministic = output
      ? await runDeterministicEvaluators(evalCase, output)
      : [];

    let rubric: CaseResult["rubric"];
    let automatedQualityScore: number | undefined;

    if (output && judgeClient) {
      try {
        const judged = await judgeResponse({
          message: evalCase.input,
          output,
          client: judgeClient,
        });
        rubric = judged.rubric;
        automatedQualityScore = calculateQualityScore(judged.rubric);
      } catch {
        // Judge failure leaves the case unjudged rather than fabricating scores.
      }
    }

    results.push({
      caseId: evalCase.id,
      category: evalCase.category,
      adversarial: evalCase.adversarial,
      difficulty: evalCase.difficulty,
      input: evalCase.input,
      output,
      error,
      deterministic,
      rubric,
      automatedQualityScore,
      latencyMs: now() - startedMs,
      inputTokens: caseInputTokens,
      outputTokens: caseOutputTokens,
    });

    options.onProgress?.(index + 1, selected.length, evalCase.id);
  }

  return {
    runId: buildRunId(options.candidateId ?? prompt.id, datasetId),
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      datasetId,
      datasetFiles,
      datasetSize: selected.length,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptSource: options.promptSource ?? "registry",
      candidateId: options.candidateId,
      mode,
      generationModel: generationClient?.model ?? "offline-deterministic-stub",
      judgeModel: judgeClient?.model,
      maxCases: options.maxCases,
    },
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
    },
    cases: results,
  };
}
