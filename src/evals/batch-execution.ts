import type {
  BatchItemResult,
  BatchModelClient,
  PollOptions,
} from "@/src/ai/client/batch";
import { DETERMINISTIC_TEMPERATURE } from "@/src/ai/client/anthropic";
import { buildGenerationUserContent } from "@/src/ai/generation/generate-support-response";
import { extractJsonObject } from "@/src/ai/generation/json";
import {
  buildJudgeUserContent,
  JUDGE_MAX_OUTPUT_TOKENS,
} from "@/src/ai/evaluators/rubric-judge";
import { ACTIVE_JUDGE_PROMPT } from "@/src/ai/prompts/judges";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import {
  rubricEvaluationSchema,
  type RubricEvaluation,
} from "@/src/schemas/evaluation";
import type { EvalCase } from "@/src/schemas/eval-case";
import { supportResponseSchema, type SupportResponse } from "@/src/schemas/support";
import type { UsageTracker } from "./paid-guard";
import type { BatchStages } from "./pending";
import { BATCH_DISCOUNT_MULTIPLIER } from "./pricing";

export type BatchGenerationOutcome = {
  output?: SupportResponse;
  error?: string;
  inputTokens: number;
  outputTokens: number;
};

export type BatchJudgeOutcome = {
  rubric?: RubricEvaluation;
  error?: string;
  inputTokens: number;
  outputTokens: number;
};

export type BatchStage = "generation" | "generation-retry" | "judge";

export type BatchProgress = (
  stage: BatchStage,
  status: string,
  counts: Record<string, number>,
) => void;

export type BatchRunOptions = {
  cases: EvalCase[];
  prompt: PromptDefinition;
  judgePrompt?: PromptDefinition;
  generationClient: BatchModelClient;
  judgeClient?: BatchModelClient;
  usage: UsageTracker;
  poll?: PollOptions;
  onProgress?: BatchProgress;
  /**
   * Batch ids already submitted by an earlier attempt at this run. A stage
   * with a recorded id is collected, never resubmitted.
   */
  resume?: BatchStages;
  /** Called the moment a stage is submitted, before polling starts. */
  onStageSubmitted?: (stages: BatchStages) => void;
};

export type BatchRunResult = {
  generation: Map<string, BatchGenerationOutcome>;
  judge: Map<string, BatchJudgeOutcome>;
  stages: BatchStages;
  batchIds: string[];
};

async function runStage(
  client: BatchModelClient,
  requests: Parameters<BatchModelClient["submit"]>[0],
  usage: UsageTracker,
  poll: PollOptions | undefined,
  onPoll: PollOptions["onPoll"],
  existingBatchId: string | undefined,
  onSubmitted: (batchId: string) => void,
): Promise<{ batchId: string; results: BatchItemResult[] }> {
  let batchId = existingBatchId;
  if (batchId === undefined) {
    batchId = await client.submit(requests);
    onSubmitted(batchId);
  }
  const results = await client.collect(batchId, { ...poll, onPoll });
  for (const result of results) {
    usage.record(
      client.model,
      result.inputTokens,
      result.outputTokens,
      BATCH_DISCOUNT_MULTIPLIER,
    );
  }
  return { batchId, results };
}

function parseGeneration(result: BatchItemResult): BatchGenerationOutcome {
  if (result.error !== undefined || result.text === undefined) {
    return {
      error: result.error ?? "Batch request returned no content.",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
  const parsed = supportResponseSchema.safeParse(extractJsonObject(result.text));
  return parsed.success
    ? {
        output: parsed.data,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      }
    : {
        error: "Generation did not return valid structured output.",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
}

function parseJudge(result: BatchItemResult): BatchJudgeOutcome {
  if (result.error !== undefined || result.text === undefined) {
    return {
      error: result.error ?? "Judge batch request returned no content.",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
  const parsed = rubricEvaluationSchema.safeParse(extractJsonObject(result.text));
  return parsed.success
    ? { rubric: parsed.data, inputTokens: result.inputTokens, outputTokens: result.outputTokens }
    : {
        error: "Judge did not return a valid rubric evaluation.",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
}

/**
 * Executes a whole experiment through the Message Batches API: one batch for
 * generation, one retry batch for anything malformed (mirroring the
 * sequential path's single retry), then one batch for judging.
 *
 * Every stage's batch id is reported as soon as it is submitted, and a stage
 * whose id is supplied in `resume` is collected instead of resubmitted, so a
 * run can be finished by a later process without paying twice.
 */
export async function executeBatchRun(
  options: BatchRunOptions,
): Promise<BatchRunResult> {
  const { cases, prompt, generationClient, usage } = options;
  const judgePrompt = options.judgePrompt ?? ACTIVE_JUDGE_PROMPT;
  const stages: BatchStages = { ...options.resume };
  const batchIds: string[] = [];

  const submitted = (stage: keyof BatchStages) => (batchId: string) => {
    stages[stage] = batchId;
    options.onStageSubmitted?.({ ...stages });
  };

  const generationRequests = cases.map((evalCase) => ({
    customId: evalCase.id,
    system: prompt.systemPrompt,
    userContent: buildGenerationUserContent(evalCase.input),
    temperature: DETERMINISTIC_TEMPERATURE,
  }));

  const first = await runStage(
    generationClient,
    generationRequests,
    usage,
    options.poll,
    (status, counts) => options.onProgress?.("generation", status, counts),
    stages.generation,
    submitted("generation"),
  );
  batchIds.push(first.batchId);

  const generation = new Map<string, BatchGenerationOutcome>();
  for (const result of first.results) {
    generation.set(result.customId, parseGeneration(result));
  }
  for (const evalCase of cases) {
    if (!generation.has(evalCase.id)) {
      generation.set(evalCase.id, {
        error: "No batch result was returned for this case.",
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  }

  const retryIds = [...generation.entries()]
    .filter(([, outcome]) => outcome.error !== undefined)
    .map(([caseId]) => caseId);

  if (retryIds.length > 0 || stages.generationRetry) {
    const retry = await runStage(
      generationClient,
      generationRequests.filter((request) => retryIds.includes(request.customId)),
      usage,
      options.poll,
      (status, counts) => options.onProgress?.("generation-retry", status, counts),
      stages.generationRetry,
      submitted("generationRetry"),
    );
    batchIds.push(retry.batchId);

    for (const result of retry.results) {
      const parsed = parseGeneration(result);
      const previous = generation.get(result.customId);
      // Keep the tokens already spent on the first attempt.
      generation.set(result.customId, {
        ...parsed,
        inputTokens: (previous?.inputTokens ?? 0) + parsed.inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + parsed.outputTokens,
      });
    }
  }

  const judge = new Map<string, BatchJudgeOutcome>();
  if (!options.judgeClient) return { generation, judge, stages, batchIds };

  const judgeRequests = cases
    .map((evalCase) => ({ evalCase, outcome: generation.get(evalCase.id) }))
    .filter(
      (entry): entry is { evalCase: EvalCase; outcome: BatchGenerationOutcome } =>
        entry.outcome?.output !== undefined,
    )
    .map(({ evalCase, outcome }) => ({
      customId: evalCase.id,
      system: judgePrompt.systemPrompt,
      userContent: buildJudgeUserContent(evalCase.input, outcome.output!),
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      temperature: DETERMINISTIC_TEMPERATURE,
    }));

  if (judgeRequests.length === 0 && !stages.judge) {
    return { generation, judge, stages, batchIds };
  }

  const judged = await runStage(
    options.judgeClient,
    judgeRequests,
    usage,
    options.poll,
    (status, counts) => options.onProgress?.("judge", status, counts),
    stages.judge,
    submitted("judge"),
  );
  batchIds.push(judged.batchId);

  for (const result of judged.results) {
    judge.set(result.customId, parseJudge(result));
  }
  for (const request of judgeRequests) {
    if (!judge.has(request.customId)) {
      judge.set(request.customId, {
        error: "No judge batch result was returned for this case.",
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  }

  return { generation, judge, stages, batchIds };
}
