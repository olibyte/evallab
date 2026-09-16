import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Comparison } from "./compare";

export const BENCHMARKS_DIR = path.join(process.cwd(), "evals", "benchmarks");
export const LATEST_BENCHMARK_PATH = path.join(BENCHMARKS_DIR, "latest.json");

export const benchmarkSchema = z.object({
  runDate: z.string().min(1),
  datasetId: z.string().min(1),
  datasetSize: z.number(),
  promptIds: z.array(z.string()),
  /** "offline" snapshots come from the deterministic stub, not a model. */
  mode: z.enum(["live", "offline"]),
  runIds: z.array(z.string()),
  warnings: z.array(z.string()),
  metrics: z.unknown(),
  improvements: z.array(z.unknown()),
  regressions: z.array(z.unknown()),
});

export type Benchmark = z.infer<typeof benchmarkSchema>;

export function buildBenchmark(comparison: Comparison): Benchmark {
  const entries = [comparison.baseline, ...comparison.candidates];
  return {
    runDate: new Date().toISOString(),
    datasetId: comparison.baseline.datasetId,
    datasetSize: comparison.baseline.datasetSize,
    promptIds: entries.map((entry) => entry.candidateId ?? entry.promptId),
    mode: comparison.baseline.mode,
    runIds: entries.map((entry) => entry.runId),
    warnings: comparison.warnings,
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
    `${day}-${benchmark.promptIds.join("-vs-")}.json`,
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
