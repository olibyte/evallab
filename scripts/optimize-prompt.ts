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
import { buildRecommendation, proposeCandidates } from "@/src/evals/optimize";
import {
  assertPaidEvalsAllowed,
  resolveCaseLimit,
  UsageTracker,
} from "@/src/evals/paid-guard";
import { loadRun, saveRun } from "@/src/evals/results";
import { runExperiment } from "@/src/evals/run-experiment";
import { numberArg, parseArgs } from "./lib/args";
import { printComparison } from "./lib/report";

const USAGE = `
Usage: pnpm prompt:optimize [options]

  --dataset <name>    dataset to optimise against       (default: human)
  --prompt <id>       parent prompt id                  (default: active prompt)
  --baseline <runId>  reuse an existing baseline run instead of running one
  --candidates <n>    candidates to propose, 3-5        (default: 4)
  --max-cases <n>     cap cases per run
  --help

This is a paid batch operation: it requires ALLOW_PAID_EVALS=true.
It never modifies the active production prompt.
`.trim();

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  assertPaidEvalsAllowed("prompt:optimize");

  const env = getEnv();
  const promptId = args.values.get("prompt");
  const prompt = promptId ? getSupportPromptById(promptId) : ACTIVE_SUPPORT_PROMPT;
  if (!prompt) throw new Error(`Unknown support prompt id "${promptId}".`);

  const { datasetId, files } = resolveDataset(args.values.get("dataset") ?? "human");
  const cases = loadDatasets(files);
  const maxCases = resolveCaseLimit(numberArg(args, "max-cases"));
  const candidateCount = Math.min(
    5,
    Math.max(3, numberArg(args, "candidates") ?? 4),
  );

  const usage = new UsageTracker(env.EVAL_MAX_SPEND_USD);
  const runConfig = {
    cases,
    datasetId,
    datasetFiles: files,
    mode: "live" as const,
    maxCases,
    maxSpendUsd: env.EVAL_MAX_SPEND_USD,
  };

  const baselineRunId = args.values.get("baseline");
  const baseline = baselineRunId
    ? loadRun(baselineRunId)
    : await (async () => {
        console.log(`Running baseline for ${prompt.id}...`);
        const run = await runExperiment({ ...runConfig, prompt });
        saveRun(run);
        return run;
      })();

  const optimizationRunId = `opt-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

  console.log(`\nProposing ${candidateCount} candidate(s) from ${baseline.runId}...`);
  const candidates = await proposeCandidates({
    client: createModelClient("generation"),
    prompt,
    baseline,
    optimizationRunId,
    candidateCount,
    usage,
  });

  for (const candidate of candidates) {
    console.log(`  ${candidate.candidateId}: ${candidate.description}`);
    console.log(`    ${saveCandidate(candidate)}`);
  }

  const candidateRuns = [];
  for (const candidate of candidates) {
    console.log(`\nEvaluating ${candidate.candidateId}...`);
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

  console.log("\n=== Comparison ===\n");
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
    "\nCandidates are never promoted automatically. To promote, add a new immutable prompt version under src/ai/prompts/support/, update ACTIVE_SUPPORT_PROMPT, record the decision in docs/DECISIONS.md and rerun the regression suite.",
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
