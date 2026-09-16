import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { ACTIVE_SUPPORT_PROMPT } from "@/src/ai/prompts/support";
import { loadDatasets } from "@/src/evals/dataset";
import { computeMetrics, evaluateGates } from "@/src/evals/metrics";
import { resolveCaseLimit } from "@/src/evals/paid-guard";
import { runExperiment } from "@/src/evals/run-experiment";
import { selectRepresentative } from "@/src/evals/splits";
import { parseArgs, numberArg } from "./lib/args";
import { printGates, printMetrics } from "./lib/report";

const DEFAULT_CASES = 24;

/**
 * Representative subset covering every category and both adversarial and
 * ordinary cases, chosen deterministically so CI results are stable.
 */
function selectSmokeCases(limit: number) {
  return selectRepresentative(loadDatasets(["seed.jsonl", "adversarial.jsonl"]), limit);
}

async function main() {
  const args = parseArgs();
  const live = args.values.get("mode") === "live";
  const limit = resolveCaseLimit(numberArg(args, "max-cases") ?? DEFAULT_CASES) ?? DEFAULT_CASES;

  const cases = selectSmokeCases(limit);
  console.log(
    `Eval smoke test: ${cases.length} representative case(s), ${live ? "live" : "offline deterministic"} mode.`,
  );

  const run = await runExperiment({
    cases,
    datasetId: "smoke",
    datasetFiles: ["seed.jsonl", "adversarial.jsonl"],
    split: "all",
    prompt: ACTIVE_SUPPORT_PROMPT,
    mode: live ? "live" : "offline",
  });

  const metrics = computeMetrics(run);
  printMetrics(metrics);

  // Offline runs exercise the pipeline with a deterministic stub, so only the
  // deterministic gates are meaningful; rubric gates are reported, not enforced.
  const gates = evaluateGates(metrics);
  printGates(gates);

  const enforced = live
    ? gates
    : gates.filter((gate) =>
        [
          "unauthorized-action-pass-rate",
          "injection-adversarial-pass-rate",
          "generation-success-rate",
        ].includes(gate.id),
      );
  const failed = enforced.filter((gate) => !gate.passed);

  if (run.cases.some((c) => c.error)) {
    console.error("\nSmoke test failed: one or more cases errored.");
    process.exitCode = 1;
    return;
  }
  if (failed.length > 0) {
    console.error(
      `\nSmoke test failed: ${failed.map((g) => g.id).join(", ")} below threshold.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("\nSmoke test passed.");
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
