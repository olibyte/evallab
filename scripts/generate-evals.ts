import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { createModelClient } from "@/src/ai/client/anthropic";
import { getEnv } from "@/src/config/env";
import { loadDatasetFile, writeDatasetFile } from "@/src/evals/dataset";
import { createBatchModelClient } from "@/src/ai/client/batch";
import {
  generateSyntheticCases,
  generateSyntheticCasesBatch,
  planBatches,
  type BatchKind,
} from "@/src/evals/generate-cases";
import { BATCH_DISCOUNT_MULTIPLIER } from "@/src/evals/pricing";
import {
  assertPaidEvalsAllowed,
  resolveCaseLimit,
  UsageTracker,
} from "@/src/evals/paid-guard";
import { numberArg, parseArgs } from "./lib/args";

const USAGE = `
Usage: pnpm eval:generate [options]

  --ordinary <n>     ordinary cases to target      (default: 200)
  --edge <n>         edge cases to target          (default: 100)
  --adversarial <n>  adversarial cases to target   (default: 100)
  --batch-size <n>   cases requested per model call (default: 8)
  --execution <how>  sequential | batch            (default: sequential)
  --plan             print the batch plan and exit without calling the model
  --help

This is a paid batch operation: it requires ALLOW_PAID_EVALS=true.
Batch execution submits every planned batch as one Message Batches job at
half the cost, queued rather than real-time. EVAL_USE_BATCH_API=true makes
it the default.
Accepted cases are appended to evals/datasets/generated.jsonl; existing
cases are never regenerated or overwritten.
`.trim();

async function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  const targets: Record<BatchKind, number> = {
    ordinary: numberArg(args, "ordinary") ?? 200,
    edge: numberArg(args, "edge") ?? 100,
    adversarial: numberArg(args, "adversarial") ?? 100,
  };
  const specs = planBatches(targets, numberArg(args, "batch-size") ?? 8);

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
    requestedExecution === "batch" ||
    (requestedExecution === undefined && env.EVAL_USE_BATCH_API);

  const existing = loadDatasetFile("generated.jsonl");
  const usage = new UsageTracker(
    env.EVAL_MAX_SPEND_USD,
    useBatch ? BATCH_DISCOUNT_MULTIPLIER : 1,
  );
  const maxCases = resolveCaseLimit();

  console.log(
    `Generating synthetic cases across ${specs.length} batch(es) via ${useBatch ? "the Batch API" : "sequential calls"}. ${existing.length} existing case(s) will be preserved.`,
  );

  const report = useBatch
    ? await generateSyntheticCasesBatch({
        client: createBatchModelClient("generation"),
        specs,
        existing,
        usage,
        maxCases,
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

  console.log(
    [
      "",
      `Batches called   ${report.batches}`,
      `Accepted         ${report.accepted.length}`,
      `Rejected         ${report.rejected}`,
      `Duplicates       ${report.duplicates}`,
      `Corpus size      ${merged.length}`,
      `Tokens in / out  ${usage.inputTokens} / ${usage.outputTokens}`,
      `Estimated cost   ${usage.estimatedCostUsd === undefined ? "unavailable (no pricing configured)" : `$${usage.estimatedCostUsd.toFixed(4)}${useBatch ? " (batch rate)" : ""}`}`,
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
