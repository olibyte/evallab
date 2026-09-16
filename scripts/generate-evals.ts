import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createModelClient } from "@/src/ai/client/anthropic";
import { getEnv } from "@/src/config/env";
import { loadDatasetFile, loadDatasets, writeDatasetFile } from "@/src/evals/dataset";
import { DATASET_PRESETS } from "@/src/evals/datasets-config";
import { createBatchModelClient } from "@/src/ai/client/batch";
import {
  generateSyntheticCases,
  generateSyntheticCasesBatch,
  planBatches,
  type BatchKind,
  type BatchSpec,
} from "@/src/evals/generate-cases";
import {
  assertPaidEvalsAllowed,
  resolveCaseLimit,
  UsageTracker,
} from "@/src/evals/paid-guard";
import { PENDING_DIR } from "@/src/evals/pending";
import {
  assignSplits,
  loadSplitManifest,
  saveSplitManifest,
} from "@/src/evals/splits";
import { numberArg, parseArgs } from "./lib/args";

const USAGE = `
Usage: pnpm eval:generate [options]

  --ordinary <n>     ordinary cases to target      (default: 200)
  --edge <n>         edge cases to target          (default: 100)
  --adversarial <n>  adversarial cases to target   (default: 100)
  --batch-size <n>   cases requested per model call (default: 8)
  --execution <how>  sequential | batch            (default: sequential)
  --plan             print the batch plan and exit without calling the model
  --resume <batchId> collect a generation batch whose process exited or timed out
  --help

This is a paid batch operation: it requires ALLOW_PAID_EVALS=true.
Batch execution submits every planned batch as one Message Batches job at
half the cost, queued rather than real-time. EVAL_USE_BATCH_API=true makes
it the default. The batch id and plan are recorded under evals/results/pending/
on submission so the job can be collected later with --resume.
Accepted cases are appended to evals/datasets/generated.jsonl; existing
cases are never regenerated or overwritten. New cases are assigned a split
immediately, so none can sit outside the dev/holdout partition.
`.trim();

const pendingGenerationSchema = z.object({
  batchId: z.string(),
  submittedAt: z.string(),
  specs: z.array(
    z.object({
      kind: z.enum(["ordinary", "edge", "adversarial"]),
      category: z.string(),
      difficulty: z.enum(["easy", "medium", "hard"]),
      angle: z.string(),
      count: z.number(),
    }),
  ),
});

function pendingPath(batchId: string) {
  return path.join(PENDING_DIR, `generate-${batchId}.json`);
}

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  const resumeBatchId = args.values.get("resume");
  let specs: BatchSpec[];

  if (resumeBatchId) {
    const filePath = pendingPath(resumeBatchId);
    if (!existsSync(filePath)) {
      throw new Error(`No pending generation batch "${resumeBatchId}" at ${filePath}.`);
    }
    const pending = pendingGenerationSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
    specs = pending.specs as BatchSpec[];
  } else {
    const targets: Record<BatchKind, number> = {
      ordinary: numberArg(args, "ordinary") ?? 200,
      edge: numberArg(args, "edge") ?? 100,
      adversarial: numberArg(args, "adversarial") ?? 100,
    };
    specs = planBatches(targets, numberArg(args, "batch-size") ?? 8);
  }

  if (args.flags.has("plan")) {
    console.log(`Planned ${specs.length} batch(es):`);
    for (const spec of specs) {
      console.log(
        `  ${spec.kind.padEnd(11)} ${spec.category.padEnd(16)} ${spec.difficulty.padEnd(6)} x${spec.count}  ${spec.angle}`,
      );
    }
    return;
  }

  assertPaidEvalsAllowed("eval:generate");

  const env = getEnv();
  const requestedExecution = args.values.get("execution");
  const useBatch =
    resumeBatchId !== undefined ||
    requestedExecution === "batch" ||
    (requestedExecution === undefined && env.EVAL_USE_BATCH_API);

  const existing = loadDatasetFile("generated.jsonl");
  const usage = new UsageTracker(env.EVAL_MAX_SPEND_USD);
  const maxCases = resolveCaseLimit();

  console.log(
    resumeBatchId
      ? `Collecting generation batch ${resumeBatchId} (${specs.length} planned batch(es)). ${existing.length} existing case(s) will be preserved.`
      : `Generating synthetic cases across ${specs.length} batch(es) via ${useBatch ? "the Batch API" : "sequential calls"}. ${existing.length} existing case(s) will be preserved.`,
  );

  const report = useBatch
    ? await generateSyntheticCasesBatch({
        client: createBatchModelClient("generation"),
        specs,
        existing,
        usage,
        maxCases,
        resumeBatchId,
        onSubmitted: (batchId) => {
          mkdirSync(PENDING_DIR, { recursive: true });
          writeFileSync(
            pendingPath(batchId),
            JSON.stringify(
              { batchId, submittedAt: new Date().toISOString(), specs },
              null,
              2,
            ) + "\n",
            "utf8",
          );
          console.log(`  submitted batch ${batchId}; resumable with --resume ${batchId}`);
        },
        onPoll: (status, counts) =>
          console.log(
            `  [batch] ${status} - ${Object.entries(counts)
              .map(([key, value]) => `${key}=${value}`)
              .join(" ")}`,
          ),
      })
    : await generateSyntheticCases({
        client: createModelClient("generation"),
        specs,
        existing,
        usage,
        maxCases,
        onProgress: (batch, total, accepted) =>
          console.log(`  batch ${batch}/${total} - ${accepted} accepted so far`),
      });

  const merged = [...existing, ...report.accepted];
  writeDatasetFile("generated.jsonl", merged);
  const collectedBatchId = (report as { batchId?: string }).batchId;
  if (collectedBatchId) rmSync(pendingPath(collectedBatchId), { force: true });

  // Assign splits to the new cases straight away; a case with no split can
  // neither be optimized against nor benchmarked.
  const allCases = loadDatasets(DATASET_PRESETS.all!);
  const { manifest, assigned } = assignSplits(allCases, loadSplitManifest());
  if (Object.keys(assigned).length > 0) saveSplitManifest(manifest);

  console.log(
    [
      "",
      `Batches called   ${report.batches}`,
      `Accepted         ${report.accepted.length}`,
      `Rejected         ${report.rejected}`,
      `Duplicates       ${report.duplicates}`,
      `Corpus size      ${merged.length}`,
      `Splits assigned  ${Object.keys(assigned).length}`,
      `Tokens in / out  ${usage.inputTokens} / ${usage.outputTokens}`,
      `Estimated cost   ${usage.estimatedCostUsd === undefined ? `unavailable (unpriced: ${usage.unpricedModels.join(", ") || "no pricing configured"})` : `$${usage.estimatedCostUsd.toFixed(4)}${useBatch ? " (batch rate)" : ""}`}`,
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
