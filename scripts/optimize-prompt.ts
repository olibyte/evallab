import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { createModelClient } from "@/src/ai/client/anthropic";
import { ACTIVE_SUPPORT_PROMPT, getSupportPromptById } from "@/src/ai/prompts/support";
import { getEnv } from "@/src/config/env";
import { saveCandidate } from "@/src/evals/candidates";
import { compareRuns } from "@/src/evals/compare";
import { loadDatasets } from "@/src/evals/dataset";
import { resolveDataset } from "@/src/evals/datasets-config";
import { computeMetrics } from "@/src/evals/metrics";
import {
  assertBaselineUsable,
  buildRecommendation,
  OPTIMIZATION_SPLIT,
  proposeCandidates,
} from "@/src/evals/optimize";
import {
  assertPaidEvalsAllowed,
  resolveCaseLimit,
  UsageTracker,
} from "@/src/evals/paid-guard";
import { loadRun, saveRun } from "@/src/evals/results";
import { runExperiment } from "@/src/evals/run-experiment";
import { selectRepresentative, selectSplit } from "@/src/evals/splits";
import { numberArg, parseArgs } from "./lib/args";
import { printComparison } from "./lib/report";

const USAGE = `
Usage: pnpm prompt:optimize [options]

  --dataset <name>    dataset files to draw from            (default: human)
  --prompt <id>       parent prompt id                      (default: active prompt)
  --baseline <runId>  reuse an existing dev-split baseline run
  --candidates <n>    candidates to propose, 3-5            (default: 4)
  --execution <how>   sequential | batch                    (default: sequential)
  --max-cases <n>     cap cases per run
  --help

This is a paid batch operation: it requires ALLOW_PAID_EVALS=true.
It never modifies the active production prompt.

Optimization reads ONLY the "${OPTIMIZATION_SPLIT}" split. There is no flag to
change that: the held-out and adversarial-holdout splits exist so that the
final benchmark measures cases the optimizer never saw. Candidates that
quote dev-case text are rejected. EVAL_MAX_SPEND_USD bounds the whole
optimization (baseline + proposal + every candidate run), not each run.
`.trim();

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }
  if (args.values.has("split")) {
    throw new Error(
      `prompt:optimize always uses the "${OPTIMIZATION_SPLIT}" split; --split is not accepted.`,
    );
  }

  assertPaidEvalsAllowed("prompt:optimize");

  const env = getEnv();
  const promptId = args.values.get("prompt");
  const prompt = promptId ? getSupportPromptById(promptId) : ACTIVE_SUPPORT_PROMPT;
  if (!prompt) throw new Error(`Unknown support prompt id "${promptId}".`);

  const { datasetId, files } = resolveDataset(args.values.get("dataset") ?? "human");
  const maxCases = resolveCaseLimit(numberArg(args, "max-cases"));
  const devCases = selectSplit(loadDatasets(files), OPTIMIZATION_SPLIT);
  const cases = selectRepresentative(devCases, maxCases);
  if (cases.length === 0) {
    throw new Error(`Dataset "${datasetId}" has no cases in the ${OPTIMIZATION_SPLIT} split.`);
  }
  const candidateCount = Math.min(
    5,
    Math.max(3, numberArg(args, "candidates") ?? 4),
  );

  const requestedExecution = args.values.get("execution");
  const execution: "sequential" | "batch" =
    requestedExecution === "batch" ||
    (requestedExecution === undefined && env.EVAL_USE_BATCH_API)
      ? "batch"
      : "sequential";

  // One budget for the whole optimization; each run reports its own usage.
  const budget = new UsageTracker(env.EVAL_MAX_SPEND_USD);
  const runConfig = {
    cases,
    datasetId,
    datasetFiles: files,
    split: OPTIMIZATION_SPLIT,
    mode: "live" as const,
    execution,
    budget,
    onBatchProgress: (stage: string, status: string, counts: Record<string, number>) =>
      console.log(
        `  [${stage}] ${status} - ${Object.entries(counts)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}`,
      ),
  };

  const baselineRunId = args.values.get("baseline");
  const baseline = baselineRunId
    ? loadRun(baselineRunId)
    : await (async () => {
        console.log(
          `Running baseline for ${prompt.id} on ${cases.length} ${OPTIMIZATION_SPLIT} case(s) (${execution})...`,
        );
        const run = await runExperiment({ ...runConfig, prompt });
        saveRun(run);
        return run;
      })();
  assertBaselineUsable(baseline, prompt, cases);

  const optimizationRunId = `opt-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

  console.log(`\nProposing ${candidateCount} candidate(s) from ${baseline.runId}...`);
  const proposal = await proposeCandidates({
    client: createModelClient("generation"),
    prompt,
    baseline,
    cases,
    optimizationRunId,
    candidateCount,
    usage: budget,
  });
  budget.assertWithinBudget();

  for (const rejected of proposal.rejected) {
    console.log(
      `  rejected "${rejected.description}": quotes dev case(s) ${rejected.hits.map((h) => h.caseId).join(", ")}`,
    );
  }
  if (proposal.candidates.length === 0) {
    throw new Error("Every proposed candidate quoted dev-case text; nothing to evaluate.");
  }

  for (const candidate of proposal.candidates) {
    console.log(`  ${candidate.candidateId}: ${candidate.description}`);
    console.log(`    ${saveCandidate(candidate)}`);
  }

  const candidateRuns = [];
  for (const candidate of proposal.candidates) {
    console.log(`\nEvaluating ${candidate.candidateId} on the ${OPTIMIZATION_SPLIT} split...`);
    const run = await runExperiment({
      ...runConfig,
      prompt: {
        id: prompt.id,
        version: prompt.version,
        description: candidate.description,
        createdAt: candidate.createdAt,
        systemPrompt: candidate.systemPrompt,
      },
      promptSource: "candidate",
      candidateId: candidate.candidateId,
    });
    saveRun(run);
    candidateRuns.push(run);
  }

  console.log("\n=== Comparison (dev split) ===\n");
  printComparison(compareRuns([baseline, ...candidateRuns]));

  const recommendation = buildRecommendation(
    { metrics: computeMetrics(baseline) },
    candidateRuns.map((run) => ({
      candidateId: run.config.candidateId!,
      metrics: computeMetrics(run),
    })),
  );

  console.log("\n=== Recommendation ===\n");
  console.log(recommendation.summary);
  for (const line of recommendation.detail) console.log(`  ${line}`);
  console.log(
    `\nOptimization spend: ${budget.estimatedCostUsd === undefined ? `tracked $${budget.trackedSpendUsd.toFixed(4)} (incomplete: unpriced ${budget.unpricedModels.join(", ") || "none"})` : `$${budget.estimatedCostUsd.toFixed(4)}`}`,
  );
  console.log(
    "\nCandidates are never promoted automatically. To promote, add a new immutable prompt version under src/ai/prompts/support/, update ACTIVE_SUPPORT_PROMPT, record the decision in docs/DECISIONS.md and rerun the regression suite.",
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
