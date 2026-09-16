import { createModelClient, type ModelRole } from "@/src/ai/client/anthropic";
import {
  createBatchModelClient,
  type BatchModelClient,
  type PollOptions,
} from "@/src/ai/client/batch";
import { runDeterministicEvaluators } from "@/src/ai/evaluators/deterministic";
import { calculateQualityScore } from "@/src/ai/evaluators/quality-score";
import { judgeResponse } from "@/src/ai/evaluators/rubric-judge";
import { generateSupportResponse } from "@/src/ai/generation/generate-support-response";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { hasLiveJudgeCredentials } from "@/src/config/env";
import type { EvalCase } from "@/src/schemas/eval-case";
import {
  executeBatchRun,
  type BatchGenerationOutcome,
  type BatchProgress,
} from "./batch-execution";
import { generateOfflineResponse } from "./offline-generator";
import { assertPaidEvalsAllowed, UsageTracker } from "./paid-guard";
import { BATCH_DISCOUNT_MULTIPLIER } from "./pricing";
import {
  buildRunId,
  type CaseResult,
  type ExperimentRun,
} from "./results";

export type RunMode = "live" | "offline";

/**
 * "batch" routes a live run through the Message Batches API: half the cost,
 * but not real-time. Offline runs ignore it — there is nothing to batch.
 */
export type RunExecution = "sequential" | "batch";

export type RunExperimentOptions = {
  cases: EvalCase[];
  datasetId: string;
  datasetFiles: string[];
  prompt: PromptDefinition;
  promptSource?: "registry" | "candidate";
  candidateId?: string;
  mode: RunMode;
  execution?: RunExecution;
  maxCases?: number;
  maxSpendUsd?: number;
  judge?: boolean;
  createClient?: (role: ModelRole) => ReturnType<typeof createModelClient>;
  createBatchClient?: (role: ModelRole) => BatchModelClient;
  onProgress?: (done: number, total: number, caseId: string) => void;
  onBatchProgress?: BatchProgress;
  poll?: PollOptions;
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

  const execution: RunExecution =
    mode === "live" ? (options.execution ?? "sequential") : "sequential";

  const usage = new UsageTracker(
    options.maxSpendUsd,
    execution === "batch" ? BATCH_DISCOUNT_MULTIPLIER : 1,
  );
  const startedAt = new Date().toISOString();

  const judgeEnabled =
    mode === "live" && (options.judge ?? true) && hasLiveJudgeCredentials();

  const live = mode === "live";
  const useBatch = live && execution === "batch";
  const createBatchClient = options.createBatchClient ?? createBatchModelClient;

  const generationClient =
    live && !useBatch ? createClient("generation") : undefined;
  const judgeClient = judgeEnabled && !useBatch ? createClient("judge") : undefined;

  const batchGenerationClient = useBatch ? createBatchClient("generation") : undefined;
  const batchJudgeClient =
    useBatch && judgeEnabled ? createBatchClient("judge") : undefined;

  // The batch path resolves every case up front, then the loop below scores
  // them exactly as the sequential path does.
  let batchGeneration: Map<string, BatchGenerationOutcome> | undefined;
  let batchRubric: Map<string, NonNullable<CaseResult["rubric"]>> | undefined;
  let batchIds: string[] | undefined;

  if (batchGenerationClient) {
    const batchRun = await executeBatchRun({
      cases: selected,
      prompt,
      generationClient: batchGenerationClient,
      judgeClient: batchJudgeClient,
      usage,
      poll: options.poll,
      onProgress: options.onBatchProgress,
    });
    batchGeneration = batchRun.generation;
    batchRubric = batchRun.rubric;
    batchIds = batchRun.batchIds;
    usage.assertWithinBudget();
  }

  const results: CaseResult[] = [];

  for (const [index, evalCase] of selected.entries()) {
    usage.assertWithinBudget();
    const startedMs = now();

    let output: CaseResult["output"];
    let error: string | undefined;
    let caseInputTokens = 0;
    let caseOutputTokens = 0;

    try {
      if (batchGeneration) {
        const outcome = batchGeneration.get(evalCase.id);
        if (!outcome) {
          error = "No batch result was returned for this case.";
        } else {
          output = outcome.output;
          error = outcome.error;
          caseInputTokens = outcome.inputTokens;
          caseOutputTokens = outcome.outputTokens;
        }
      } else if (generationClient) {
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

    if (output && batchRubric) {
      rubric = batchRubric.get(evalCase.id);
      if (rubric) automatedQualityScore = calculateQualityScore(rubric);
    } else if (output && judgeClient) {
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
      execution,
      batchIds,
      generationModel:
        generationClient?.model ??
        batchGenerationClient?.model ??
        "offline-deterministic-stub",
      judgeModel: judgeClient?.model ?? batchJudgeClient?.model,
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
