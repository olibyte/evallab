import type {
  BatchItemResult,
  BatchModelClient,
  PollOptions,
} from "@/src/ai/client/batch";
import { buildGenerationUserContent } from "@/src/ai/generation/generate-support-response";
import { extractJsonObject } from "@/src/ai/generation/json";
import { buildJudgeUserContent } from "@/src/ai/evaluators/rubric-judge";
import { rubricJudgePromptV1 } from "@/src/ai/prompts/judges/rubric-v1";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import {
  rubricEvaluationSchema,
  type RubricEvaluation,
} from "@/src/schemas/evaluation";
import type { EvalCase } from "@/src/schemas/eval-case";
import { supportResponseSchema, type SupportResponse } from "@/src/schemas/support";
import type { UsageTracker } from "./paid-guard";

export type BatchGenerationOutcome = {
  output?: SupportResponse;
  error?: string;
  inputTokens: number;
  outputTokens: number;
};

export type BatchProgress = (
  stage: "generation" | "generation-retry" | "judge",
  status: string,
  counts: Record<string, number>,
) => void;

export type BatchRunOptions = {
  cases: EvalCase[];
  prompt: PromptDefinition;
  generationClient: BatchModelClient;
  judgeClient?: BatchModelClient;
  usage: UsageTracker;
  poll?: PollOptions;
  onProgress?: BatchProgress;
};

export type BatchRunResult = {
  generation: Map<string, BatchGenerationOutcome>;
  rubric: Map<string, RubricEvaluation>;
  batchIds: string[];
};

async function runBatch(
  client: BatchModelClient,
  requests: Parameters<BatchModelClient["submit"]>[0],
  usage: UsageTracker,
  poll: PollOptions | undefined,
  onPoll: PollOptions["onPoll"],
): Promise<{ batchId: string; results: BatchItemResult[] }> {
  const batchId = await client.submit(requests);
  const results = await client.collect(batchId, { ...poll, onPoll });
  for (const result of results) {
    usage.record(client.model, result.inputTokens, result.outputTokens);
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

/**
 * Executes a whole experiment through the Message Batches API: one batch for
 * generation, one retry batch for anything malformed (mirroring the
 * sequential path's single retry), then one batch for judging.
 *
 * Batches bill at half the standard rate but are not real-time, so this is
 * only ever used offline.
 */
export async function executeBatchRun(
  options: BatchRunOptions,
): Promise<BatchRunResult> {
  const { cases, prompt, generationClient, usage } = options;
  const batchIds: string[] = [];

  const generationRequests = cases.map((evalCase) => ({
    customId: evalCase.id,
    system: prompt.systemPrompt,
    userContent: buildGenerationUserContent(evalCase.input),
  }));

  const first = await runBatch(
    generationClient,
    generationRequests,
    usage,
    options.poll,
    (status, counts) => options.onProgress?.("generation", status, counts),
  );
  batchIds.push(first.batchId);

  const generation = new Map<string, BatchGenerationOutcome>();
  for (const result of first.results) {
    generation.set(result.customId, parseGeneration(result));
  }

  const retryIds = [...generation.entries()]
    .filter(([, outcome]) => outcome.error !== undefined)
    .map(([caseId]) => caseId);

  if (retryIds.length > 0) {
    const retry = await runBatch(
      generationClient,
      generationRequests.filter((request) => retryIds.includes(request.customId)),
      usage,
      options.poll,
      (status, counts) => options.onProgress?.("generation-retry", status, counts),
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

  const rubric = new Map<string, RubricEvaluation>();
  if (!options.judgeClient) return { generation, rubric, batchIds };

  const judgeRequests = cases
    .map((evalCase) => ({ evalCase, outcome: generation.get(evalCase.id) }))
    .filter(
      (entry): entry is { evalCase: EvalCase; outcome: BatchGenerationOutcome } =>
        entry.outcome?.output !== undefined,
    )
    .map(({ evalCase, outcome }) => ({
      customId: evalCase.id,
      system: rubricJudgePromptV1.systemPrompt,
      userContent: buildJudgeUserContent(evalCase.input, outcome.output!),
      maxOutputTokens: 800,
    }));

  if (judgeRequests.length === 0) return { generation, rubric, batchIds };

  const judged = await runBatch(
    options.judgeClient,
    judgeRequests,
    usage,
    options.poll,
    (status, counts) => options.onProgress?.("judge", status, counts),
  );
  batchIds.push(judged.batchId);

  for (const result of judged.results) {
    if (result.error !== undefined || result.text === undefined) continue;
    const parsed = rubricEvaluationSchema.safeParse(extractJsonObject(result.text));
    // A judge failure leaves the case unjudged rather than fabricating scores.
    if (parsed.success) rubric.set(result.customId, parsed.data);
  }

  return { generation, rubric, batchIds };
}
