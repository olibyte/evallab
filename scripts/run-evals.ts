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
import { FilePendingRunStore } from "@/src/evals/pending";
import { saveRun } from "@/src/evals/results";
import { runExperiment } from "@/src/evals/run-experiment";
import {
  isSplitSelector,
  selectRepresentative,
  selectSplit,
  SPLIT_SELECTORS,
} from "@/src/evals/splits";
import { numberArg, parseArgs } from "./lib/args";
import { printGates, printMetrics } from "./lib/report";

const USAGE = `
Usage: pnpm eval:run [options]

  --dataset <name>     seed | adversarial | human | generated | all  (default: human)
  --split <name>       ${SPLIT_SELECTORS.join(" | ")}
                       (default: holdout)
  --prompt <id>        support prompt id from the registry (default: active prompt)
  --candidate <id>     evaluate a stored candidate prompt instead
  --mode <mode>        offline | live                                (default: offline)
  --execution <how>    sequential | batch                            (default: sequential)
  --max-cases <n>      cap the number of cases
  --no-judge           skip rubric evaluation in live mode
  --resume <runId>     finish a batch run whose process exited or timed out
  --pending            list batch runs that can be resumed
  --help

Live mode makes paid Anthropic calls and requires ALLOW_PAID_EVALS=true.
Batch execution routes the run through the Message Batches API: half the
cost, but it is queued rather than real-time. EVAL_USE_BATCH_API=true makes
it the default for live runs. Every batch id is recorded under
evals/results/pending/ the moment it is submitted, so a run can always be
collected later with --resume.

The default split is "holdout" (heldout + adversarial-holdout): the cases
prompt optimization has never seen. Use --split dev only for development.
`.trim();

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  const pendingStore = new FilePendingRunStore();

  if (args.flags.has("pending")) {
    const ids = pendingStore.list();
    console.log(
      ids.length === 0
        ? "No pending batch runs."
        : `Pending batch runs (finish with --resume <runId>):\n${ids.join("\n")}`,
    );
    return;
  }

  const resumeId = args.values.get("resume");
  if (resumeId) {
    const pending = pendingStore.load(resumeId);
    if (!pending) throw new Error(`No pending run "${resumeId}" under evals/results/pending/.`);
    console.log(
      `Resuming batch run ${pending.runId}: ${pending.cases.length} case(s), stages ${JSON.stringify(pending.stages)}.`,
    );
    const run = await runExperiment({
      cases: pending.cases,
      datasetId: pending.datasetId,
      datasetFiles: pending.datasetFiles,
      split: pending.split,
      prompt: pending.prompt,
      promptSource: pending.promptSource,
      candidateId: pending.candidateId,
      mode: "live",
      execution: "batch",
      maxSpendUsd: pending.maxSpendUsd,
      judge: pending.judge,
      pendingStore,
      resume: pending,
      onBatchProgress: logBatchProgress,
    });
    report(run);
    return;
  }

  const datasetName = args.values.get("dataset") ?? "human";
  const { datasetId, files } = resolveDataset(datasetName);
  const splitName = args.values.get("split") ?? "holdout";
  if (!isSplitSelector(splitName)) {
    throw new Error(`Unknown split "${splitName}". Available: ${SPLIT_SELECTORS.join(", ")}.`);
  }
  const splitCases = selectSplit(loadDatasets(files), splitName);
  if (splitCases.length === 0) {
    throw new Error(`Dataset "${datasetId}" has no cases in split "${splitName}".`);
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
  // A capped run takes a stratified subset, not a file-ordered prefix.
  const cases = selectRepresentative(splitCases, maxCases);

  const requestedExecution = args.values.get("execution");
  const execution: "sequential" | "batch" =
    requestedExecution === "batch" ||
    (requestedExecution === undefined && getEnv().EVAL_USE_BATCH_API)
      ? "batch"
      : "sequential";

  console.log(
    `Running ${cases.length} of ${splitCases.length} case(s) from "${datasetId}" split "${splitName}" against ${candidateId ?? prompt.id} in ${mode} mode (${execution}).`,
  );

  const run = await runExperiment({
    cases,
    datasetId,
    datasetFiles: files,
    split: splitName,
    prompt,
    promptSource,
    candidateId,
    mode,
    execution,
    maxCases,
    maxSpendUsd: getEnv().EVAL_MAX_SPEND_USD,
    judge: !args.flags.has("no-judge"),
    pendingStore,
    onProgress: (done, total, caseId) => {
      if (done % 10 === 0 || done === total) {
        console.log(`  ${done}/${total} (${caseId})`);
      }
    },
    onBatchProgress: logBatchProgress,
  });
  report(run);
}

function logBatchProgress(stage: string, status: string, counts: Record<string, number>) {
  console.log(
    `  [${stage}] ${status} - ${Object.entries(counts)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}`,
  );
}

function report(run: Awaited<ReturnType<typeof runExperiment>>) {
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
