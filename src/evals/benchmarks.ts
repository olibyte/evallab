import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Comparison, ComparisonEntry } from "./compare";

export const BENCHMARKS_DIR = path.join(process.cwd(), "evals", "benchmarks");
export const LATEST_BENCHMARK_PATH = path.join(BENCHMARKS_DIR, "latest.json");

const benchmarkRunSchema = z.object({
  runId: z.string(),
  label: z.string(),
  promptId: z.string(),
  promptVersion: z.number(),
  promptHash: z.string().optional(),
  promptSource: z.enum(["registry", "candidate"]),
  candidateId: z.string().optional(),
  generationModel: z.string(),
  judgeModel: z.string().optional(),
  judgePromptId: z.string().optional(),
  execution: z.enum(["sequential", "batch"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    estimatedCostUsd: z.number().optional(),
    unpricedModels: z.array(z.string()).default([]),
    pricing: z.unknown().optional(),
  }),
  metrics: z.unknown(),
  gates: z.array(
    z.object({
      id: z.string(),
      threshold: z.number(),
      actual: z.number().optional(),
      passed: z.boolean(),
      note: z.string().optional(),
    }),
  ),
});

export const benchmarkSchema = z.object({
  runDate: z.string().min(1),
  datasetId: z.string().min(1),
  datasetSize: z.number(),
  /** Which split the runs covered; a credible benchmark is "holdout". */
  split: z.string().default("all"),
  datasetHash: z.string().optional(),
  promptIds: z.array(z.string()),
  /** "offline" snapshots come from the deterministic stub, not a model. */
  mode: z.enum(["live", "offline"]),
  runIds: z.array(z.string()),
  /** Full per-run provenance: models, prompts, usage, pricing, gates. */
  runs: z.array(benchmarkRunSchema).default([]),
  comparable: z.boolean().default(true),
  warnings: z.array(z.string()),
  metrics: z.unknown(),
  improvements: z.array(z.unknown()),
  regressions: z.array(z.unknown()),
});

export type Benchmark = z.infer<typeof benchmarkSchema>;

function toBenchmarkRun(entry: ComparisonEntry): Benchmark["runs"][number] {
  return {
    runId: entry.runId,
    label: entry.candidateId ?? entry.promptId,
    promptId: entry.promptId,
    promptVersion: entry.promptVersion,
    promptHash: entry.promptHash,
    promptSource: entry.promptSource,
    candidateId: entry.candidateId,
    generationModel: entry.generationModel,
    judgeModel: entry.judgeModel,
    judgePromptId: entry.judgePromptId,
    execution: entry.execution,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    usage: entry.usage,
    metrics: entry.metrics,
    gates: entry.gates,
  };
}

export class BenchmarkNotComparableError extends Error {
  constructor(warnings: string[]) {
    super(
      `Refusing to write a benchmark from runs that are not like-for-like:\n  - ${warnings.join("\n  - ")}\nPass --allow-mismatch to write it anyway; the warnings are stored in the snapshot.`,
    );
    this.name = "BenchmarkNotComparableError";
  }
}

export function buildBenchmark(
  comparison: Comparison,
  options: { allowMismatch?: boolean } = {},
): Benchmark {
  if (!comparison.comparable && !options.allowMismatch) {
    throw new BenchmarkNotComparableError(comparison.warnings);
  }
  const entries = [comparison.baseline, ...comparison.candidates];
  const warnings = [...comparison.warnings];
  if (comparison.baseline.split === "dev" || comparison.baseline.split === "all") {
    warnings.push(
      `This benchmark covers the "${comparison.baseline.split}" split, which includes cases prompt optimization may have seen. Held-out results are needed before a promotion decision.`,
    );
  }
  return {
    runDate: new Date().toISOString(),
    datasetId: comparison.baseline.datasetId,
    datasetSize: comparison.baseline.datasetSize,
    split: comparison.baseline.split,
    datasetHash: comparison.baseline.datasetHash,
    promptIds: entries.map((entry) => entry.candidateId ?? entry.promptId),
    mode: comparison.baseline.mode,
    runIds: entries.map((entry) => entry.runId),
    runs: entries.map(toBenchmarkRun),
    comparable: comparison.comparable,
    warnings,
    metrics: Object.fromEntries(
      entries.map((entry) => [entry.candidateId ?? entry.runId, entry.metrics]),
    ),
    improvements: comparison.improvements,
    regressions: comparison.regressions,
  };
}

/** Writes an immutable snapshot and refreshes the dashboard-facing latest. */
export function saveBenchmark(benchmark: Benchmark): {
  snapshotPath: string;
  latestPath: string;
} {
  mkdirSync(BENCHMARKS_DIR, { recursive: true });
  const day = benchmark.runDate.slice(0, 10);
  const snapshotPath = path.join(
    BENCHMARKS_DIR,
    `${day}-${benchmark.split}-${benchmark.promptIds.join("-vs-")}.json`,
  );
  const contents = JSON.stringify(benchmark, null, 2) + "\n";
  writeFileSync(snapshotPath, contents, "utf8");
  writeFileSync(LATEST_BENCHMARK_PATH, contents, "utf8");
  return { snapshotPath, latestPath: LATEST_BENCHMARK_PATH };
}

/**
 * Returns the latest benchmark, or undefined when none has been produced.
 * A corrupt file is reported and treated as absent; placeholder numbers are
 * never substituted.
 */
export function loadLatestBenchmark(): Benchmark | undefined {
  if (!existsSync(LATEST_BENCHMARK_PATH)) return undefined;
  try {
    const parsed = benchmarkSchema.safeParse(
      JSON.parse(readFileSync(LATEST_BENCHMARK_PATH, "utf8")),
    );
    if (!parsed.success) {
      console.error("[evallab] evals/benchmarks/latest.json failed validation");
      return undefined;
    }
    return parsed.data;
  } catch {
    console.error("[evallab] evals/benchmarks/latest.json is not valid JSON");
    return undefined;
  }
}
