import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rubricEvaluationSchema } from "@/src/schemas/evaluation";
import { supportResponseSchema } from "@/src/schemas/support";

export const RESULTS_DIR = path.join(process.cwd(), "evals", "results");

const evaluationResultSchema = z.object({
  evaluatorId: z.string(),
  score: z.number().optional(),
  passed: z.boolean().optional(),
  label: z.string().optional(),
  rationale: z.string().optional(),
});

export const caseResultSchema = z.object({
  caseId: z.string(),
  category: z.string(),
  adversarial: z.boolean(),
  difficulty: z.string(),
  input: z.string(),
  output: supportResponseSchema.optional(),
  /** Set when generation failed; the case counts as a failure, not a skip. */
  error: z.string().optional(),
  deterministic: z.array(evaluationResultSchema),
  rubric: rubricEvaluationSchema.optional(),
  /** Why the judge produced no rubric for a case that had valid output. */
  judgeError: z.string().optional(),
  automatedQualityScore: z.number().optional(),
  latencyMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const experimentRunSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  config: z.object({
    datasetId: z.string(),
    datasetFiles: z.array(z.string()),
    datasetSize: z.number(),
    /** dev | heldout | adversarial-holdout | holdout | all (see splits.ts). */
    split: z.string().default("all"),
    /** sha256 over the exact cases run; equal hashes mean an identical test. */
    datasetHash: z.string().optional(),
    promptId: z.string(),
    promptVersion: z.number(),
    /** sha256 of the system prompt text actually sent. */
    promptHash: z.string().optional(),
    promptSource: z.enum(["registry", "candidate"]),
    candidateId: z.string().optional(),
    judgePromptId: z.string().optional(),
    judgePromptHash: z.string().optional(),
    generationParams: z
      .object({ temperature: z.number(), maxOutputTokens: z.number() })
      .optional(),
    judgeParams: z
      .object({ temperature: z.number(), maxOutputTokens: z.number() })
      .optional(),
    gitCommit: z.string().optional(),
    mode: z.enum(["live", "offline"]),
    execution: z.enum(["sequential", "batch"]).default("sequential"),
    /** Message Batches ids, when the run went through the Batch API. */
    batchIds: z.array(z.string()).optional(),
    generationModel: z.string(),
    judgeModel: z.string().optional(),
    maxCases: z.number().optional(),
  }),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    /** Absent when any model used in the run had no configured price. */
    estimatedCostUsd: z.number().optional(),
    unpricedModels: z.array(z.string()).default([]),
    /** The per-million-token rates the estimate was computed from. */
    pricing: z
      .record(
        z.string(),
        z.object({
          inputUsdPerMillionTokens: z.number(),
          outputUsdPerMillionTokens: z.number(),
          discountMultiplier: z.number(),
        }),
      )
      .optional(),
  }),
  cases: z.array(caseResultSchema),
});

export type CaseResult = z.infer<typeof caseResultSchema>;
export type ExperimentRun = z.infer<typeof experimentRunSchema>;

/** Deterministic enough to identify the run, unique across executions. */
export function buildRunId(
  promptId: string,
  datasetId: string,
  split = "all",
  at = new Date(),
): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${stamp}-${datasetId}-${split}-${promptId}-${suffix}`;
}

export function saveRun(run: ExperimentRun): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${run.runId}.json`);
  writeFileSync(filePath, JSON.stringify(run, null, 2) + "\n", "utf8");
  return filePath;
}

export class CorruptRunError extends Error {
  constructor(file: string, detail: string) {
    super(`Run file ${file} is not a valid experiment result: ${detail}`);
    this.name = "CorruptRunError";
  }
}

export function loadRun(runIdOrPath: string): ExperimentRun {
  const filePath = runIdOrPath.endsWith(".json")
    ? path.resolve(runIdOrPath)
    : path.join(RESULTS_DIR, `${runIdOrPath}.json`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new CorruptRunError(filePath, (error as Error).message);
  }
  const parsed = experimentRunSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CorruptRunError(filePath, parsed.error.issues[0]?.message ?? "unknown");
  }
  return parsed.data;
}

export function listRunIds(): string[] {
  try {
    return readdirSync(RESULTS_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}
