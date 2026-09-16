import {
  createModelClient,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DETERMINISTIC_TEMPERATURE,
  type ModelRole,
} from "@/src/ai/client/anthropic";
import { samplingParamsFor } from "@/src/ai/client/model-capabilities";
import {
  createBatchModelClient,
  type BatchModelClient,
  type PollOptions,
} from "@/src/ai/client/batch";
import {
  runDeterministicEvaluators,
  structuredOutputFailure,
} from "@/src/ai/evaluators/deterministic";
import { calculateQualityScore } from "@/src/ai/evaluators/quality-score";
import {
  JUDGE_MAX_OUTPUT_TOKENS,
  JudgeOutputError,
  judgeResponse,
} from "@/src/ai/evaluators/rubric-judge";
import {
  GenerationOutputError,
  generateSupportResponse,
} from "@/src/ai/generation/generate-support-response";
import { ACTIVE_JUDGE_PROMPT } from "@/src/ai/prompts/judges";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { hasLiveJudgeCredentials } from "@/src/config/env";
import type { EvalCase } from "@/src/schemas/eval-case";
import {
  executeBatchRun,
  type BatchGenerationOutcome,
  type BatchJudgeOutcome,
  type BatchProgress,
} from "./batch-execution";
import { generateOfflineResponse } from "./offline-generator";
import { assertPaidEvalsAllowed, UsageTracker } from "./paid-guard";
import {
  FilePendingRunStore,
  type BatchStages,
  type PendingRun,
  type PendingRunStore,
} from "./pending";
import { currentGitCommit, datasetFingerprint, hashText } from "./provenance";
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
  /** Which split the cases came from; recorded, and checked by comparisons. */
  split?: string;
  prompt: PromptDefinition;
  promptSource?: "registry" | "candidate";
  candidateId?: string;
  mode: RunMode;
  execution?: RunExecution;
  maxCases?: number;
  maxSpendUsd?: number;
  /** A shared budget, so a multi-run workflow cannot spend the cap per run. */
  budget?: UsageTracker;
  judge?: boolean;
  judgePrompt?: PromptDefinition;
  createClient?: (role: ModelRole) => ReturnType<typeof createModelClient>;
  createBatchClient?: (role: ModelRole) => BatchModelClient;
  onProgress?: (done: number, total: number, caseId: string) => void;
  onBatchProgress?: BatchProgress;
  poll?: PollOptions;
  now?: () => number;
  /**
   * Batch runs record their submitted batch ids here so a later process can
   * finish them. `resume` supplies a previously recorded run to continue.
   */
  pendingStore?: PendingRunStore;
  resume?: PendingRun;
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
  const split = options.split ?? "all";
  const judgePrompt = options.judgePrompt ?? ACTIVE_JUDGE_PROMPT;

  if (mode === "live") assertPaidEvalsAllowed("eval:run --mode live");

  const selected =
    options.maxCases === undefined
      ? options.cases
      : options.cases.slice(0, options.maxCases);

  const execution: RunExecution =
    mode === "live" ? (options.execution ?? "sequential") : "sequential";

  const usage = new UsageTracker(options.maxSpendUsd, options.budget);
  const runId = options.resume?.runId ?? buildRunId(options.candidateId ?? prompt.id, datasetId, split);
  const startedAt = options.resume?.startedAt ?? new Date().toISOString();

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
  let batchJudge: Map<string, BatchJudgeOutcome> | undefined;
  let batchIds: string[] | undefined;

  if (batchGenerationClient) {
    const pendingStore = options.pendingStore ?? new FilePendingRunStore();
    const pending: PendingRun = options.resume ?? {
      runId,
      startedAt,
      datasetId,
      datasetFiles,
      split,
      maxCases: options.maxCases,
      maxSpendUsd: options.maxSpendUsd,
      judge: judgeEnabled,
      promptSource: options.promptSource ?? "registry",
      candidateId: options.candidateId,
      prompt: {
        id: prompt.id,
        version: prompt.version,
        description: prompt.description,
        createdAt: prompt.createdAt,
        systemPrompt: prompt.systemPrompt,
      },
      judgePromptId: judgePrompt.id,
      cases: selected,
      stages: {},
    };
    pendingStore.save(pending);

    const batchRun = await executeBatchRun({
      cases: selected,
      prompt,
      judgePrompt,
      generationClient: batchGenerationClient,
      judgeClient: batchJudgeClient,
      usage,
      poll: options.poll,
      onProgress: options.onBatchProgress,
      resume: pending.stages,
      onStageSubmitted: (stages: BatchStages) =>
        pendingStore.save({ ...pending, stages }),
    });
    batchGeneration = batchRun.generation;
    batchJudge = batchRun.judge;
    batchIds = batchRun.batchIds;
    usage.assertWithinBudget();
    pendingStore.remove(runId);
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
          temperature: DETERMINISTIC_TEMPERATURE,
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
      if (caught instanceof GenerationOutputError) {
        caseInputTokens = caught.inputTokens;
        caseOutputTokens = caught.outputTokens;
        usage.record(caught.generationModel, caught.inputTokens, caught.outputTokens);
      }
    }

    // A case with no valid output still gets a verdict, and a failing one:
    // it must stay in every denominator rather than vanish from the run.
    const deterministic = output
      ? await runDeterministicEvaluators(evalCase, output)
      : [structuredOutputFailure(error ?? "generation produced no output")];

    let rubric: CaseResult["rubric"];
    let judgeError: string | undefined;
    let automatedQualityScore: number | undefined;

    if (output && batchJudge) {
      const outcome = batchJudge.get(evalCase.id);
      rubric = outcome?.rubric;
      judgeError = outcome?.error;
      if (rubric) automatedQualityScore = calculateQualityScore(rubric);
      caseInputTokens += outcome?.inputTokens ?? 0;
      caseOutputTokens += outcome?.outputTokens ?? 0;
    } else if (output && judgeClient) {
      try {
        const judged = await judgeResponse({
          message: evalCase.input,
          output,
          client: judgeClient,
          judgePrompt,
          temperature: DETERMINISTIC_TEMPERATURE,
        });
        rubric = judged.rubric;
        automatedQualityScore = calculateQualityScore(judged.rubric);
        caseInputTokens += judged.inputTokens;
        caseOutputTokens += judged.outputTokens;
        usage.record(judged.judgeModel, judged.inputTokens, judged.outputTokens);
      } catch (caught) {
        // Judge failure leaves the case unjudged, and says why, rather than
        // fabricating scores. A malformed reply still cost tokens.
        judgeError = caught instanceof Error ? caught.message : "Judge failed.";
        if (caught instanceof JudgeOutputError) {
          caseInputTokens += caught.inputTokens;
          caseOutputTokens += caught.outputTokens;
          usage.record(caught.judgeModel, caught.inputTokens, caught.outputTokens);
        }
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
      judgeError,
      automatedQualityScore,
      latencyMs: now() - startedMs,
      inputTokens: caseInputTokens,
      outputTokens: caseOutputTokens,
    });

    options.onProgress?.(index + 1, selected.length, evalCase.id);
  }

  const judgeModel = judgeClient?.model ?? batchJudgeClient?.model;
  const generationModel =
    generationClient?.model ??
    batchGenerationClient?.model ??
    "offline-deterministic-stub";

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      datasetId,
      datasetFiles,
      datasetSize: selected.length,
      split,
      datasetHash: datasetFingerprint(selected),
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptHash: hashText(prompt.systemPrompt),
      promptSource: options.promptSource ?? "registry",
      candidateId: options.candidateId,
      judgePromptId: judgeModel ? judgePrompt.id : undefined,
      judgePromptHash: judgeModel ? hashText(judgePrompt.systemPrompt) : undefined,
      // What was actually sent, not what was asked for: on a model that has
      // removed `temperature` the field is dropped, and a run record that
      // still claimed `temperature: 0` would misdescribe the experiment.
      generationParams: live
        ? {
            ...samplingParamsFor(generationModel, {
              temperature: DETERMINISTIC_TEMPERATURE,
            }),
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          }
        : undefined,
      judgeParams: judgeModel
        ? {
            ...samplingParamsFor(judgeModel, {
              temperature: DETERMINISTIC_TEMPERATURE,
            }),
            maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
          }
        : undefined,
      gitCommit: currentGitCommit(),
      mode,
      execution,
      batchIds,
      generationModel,
      judgeModel,
      maxCases: options.maxCases,
    },
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      unpricedModels: usage.unpricedModels,
      pricing: usage.pricingSnapshot,
    },
    cases: results,
  };
}
