import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { buildBenchmark, saveBenchmark } from "@/src/evals/benchmarks";
import { compareRuns } from "@/src/evals/compare";
import { listRunIds, loadRun } from "@/src/evals/results";
import { parseArgs } from "./lib/args";
import { printComparison } from "./lib/report";

const USAGE = `
Usage: pnpm eval:compare <baseline-run-id> <candidate-run-id> [more-run-ids...]

  --list               show available run ids
  --write-benchmark    persist the comparison to evals/benchmarks/
  --allow-mismatch     write the benchmark even when the runs are not
                       like-for-like (different cases, models or judge)
  --help

Compares existing experiment results only. No model is ever called.
A benchmark is refused unless every run covered the same cases with the same
generation model, judge model and judge prompt as the baseline.
`.trim();

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }
  if (args.flags.has("list")) {
    const ids = listRunIds();
    console.log(ids.length === 0 ? "No runs found in evals/results." : ids.join("\n"));
    return;
  }
  if (args.positional.length < 2) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const runs = args.positional.map(loadRun);
  const comparison = compareRuns(runs);
  printComparison(comparison);

  if (args.flags.has("write-benchmark")) {
    const benchmark = buildBenchmark(comparison, {
      allowMismatch: args.flags.has("allow-mismatch"),
    });
    const { snapshotPath, latestPath } = saveBenchmark(benchmark);
    console.log(`\nBenchmark written:\n  ${snapshotPath}\n  ${latestPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
