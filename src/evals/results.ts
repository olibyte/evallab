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
    promptId: z.string(),
    promptVersion: z.number(),
    /** Candidate runs carry the prompt text so the run stays reproducible. */
    promptSource: z.enum(["registry", "candidate"]),
    candidateId: z.string().optional(),
    mode: z.enum(["live", "offline"]),
    generationModel: z.string(),
    judgeModel: z.string().optional(),
    maxCases: z.number().optional(),
  }),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    estimatedCostUsd: z.number().optional(),
  }),
  cases: z.array(caseResultSchema),
});

export type CaseResult = z.infer<typeof caseResultSchema>;
export type ExperimentRun = z.infer<typeof experimentRunSchema>;

/** Deterministic enough to identify the run, unique across executions. */
export function buildRunId(promptId: string, datasetId: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${stamp}-${datasetId}-${promptId}-${suffix}`;
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
