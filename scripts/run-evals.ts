import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { ACTIVE_SUPPORT_PROMPT, getSupportPromptById } from "@/src/ai/prompts/support";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { getEnv } from "@/src/config/env";
import { loadCandidate } from "@/src/evals/candidates";
import { loadDatasets } from "@/src/evals/dataset";
import { resolveDataset } from "@/src/evals/datasets-config";
import { computeMetrics, evaluateGates } from "@/src/evals/metrics";
import { resolveCaseLimit } from "@/src/evals/paid-guard";
import { saveRun } from "@/src/evals/results";
import { runExperiment } from "@/src/evals/run-experiment";
import { numberArg, parseArgs } from "./lib/args";
import { printGates, printMetrics } from "./lib/report";

const USAGE = `
Usage: pnpm eval:run [options]

  --dataset <name>     seed | adversarial | human | generated | all  (default: human)
  --prompt <id>        support prompt id from the registry (default: active prompt)
  --candidate <id>     evaluate a stored candidate prompt instead
  --mode <mode>        offline | live                                (default: offline)
  --execution <how>    sequential | batch                            (default: sequential)
  --max-cases <n>      cap the number of cases
  --no-judge           skip rubric evaluation in live mode
  --help

Live mode makes paid Anthropic calls and requires ALLOW_PAID_EVALS=true.
Batch execution routes the run through the Message Batches API: half the
cost, but it is queued rather than real-time. EVAL_USE_BATCH_API=true makes
it the default for live runs.
`.trim();

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  const datasetName = args.values.get("dataset") ?? "human";
  const { datasetId, files } = resolveDataset(datasetName);
  const cases = loadDatasets(files);
  if (cases.length === 0) {
    throw new Error(`Dataset "${datasetId}" contains no cases.`);
  }

  const candidateId = args.values.get("candidate");
  let prompt: PromptDefinition;
  let promptSource: "registry" | "candidate" = "registry";

  if (candidateId) {
    const candidate = loadCandidate(candidateId);
    prompt = {
      id: candidate.parentPromptId,
      version: 0,
      description: candidate.description,
      createdAt: candidate.createdAt,
      systemPrompt: candidate.systemPrompt,
    };
    promptSource = "candidate";
  } else {
    const promptId = args.values.get("prompt");
    const resolved = promptId ? getSupportPromptById(promptId) : ACTIVE_SUPPORT_PROMPT;
    if (!resolved) throw new Error(`Unknown support prompt id "${promptId}".`);
    prompt = resolved;
  }

  const mode = args.values.get("mode") === "live" ? "live" : "offline";
  const maxCases = resolveCaseLimit(numberArg(args, "max-cases"));

  const requestedExecution = args.values.get("execution");
  const execution: "sequential" | "batch" =
    requestedExecution === "batch" ||
    (requestedExecution === undefined && getEnv().EVAL_USE_BATCH_API)
      ? "batch"
      : "sequential";

  console.log(
    `Running ${maxCases ?? cases.length} case(s) from "${datasetId}" against ${candidateId ?? prompt.id} in ${mode} mode (${execution}).`,
  );

  const run = await runExperiment({
    cases,
    datasetId,
    datasetFiles: files,
    prompt,
    promptSource,
    candidateId,
    mode,
    execution,
    maxCases,
    maxSpendUsd: getEnv().EVAL_MAX_SPEND_USD,
    judge: !args.flags.has("no-judge"),
    onProgress: (done, total, caseId) => {
      if (done % 10 === 0 || done === total) {
        console.log(`  ${done}/${total} (${caseId})`);
      }
    },
    onBatchProgress: (stage, status, counts) =>
      console.log(
        `  [${stage}] ${status} - ${Object.entries(counts)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}`,
      ),
  });

  const filePath = saveRun(run);
  const metrics = computeMetrics(run);

  console.log(`\nSaved run ${run.runId}\n  ${filePath}`);
  if (run.config.batchIds?.length) {
    console.log(`  batches: ${run.config.batchIds.join(", ")}`);
  }
  console.log("");
  printMetrics(metrics);
  printGates(evaluateGates(metrics));
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
