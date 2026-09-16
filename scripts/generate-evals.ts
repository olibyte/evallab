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
  outputTokenBudget,
  planBatches,
  plannedCaseCount,
  trimPlanToCaseLimit,
  type BatchKind,
  type BatchSpec,
  type GenerationDiagnostics,
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
EVAL_MAX_CASES caps the plan before submission, so a capped run does not pay
for cases it would discard.

Accepted cases are appended to evals/datasets/generated.jsonl; existing
cases are never regenerated or overwritten. New cases are assigned a split
immediately, so none can sit outside the dev/holdout partition.
Every run writes a rejection breakdown to evals/results/<stamp>-generate.json:
request outcomes in requests, case rejections in candidates, and the planned
cases that never came back.
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
        `  ${spec.kind.padEnd(11)} ${spec.category.padEnd(16)} ${spec.difficulty.padEnd(6)} x${spec.count}  <=${outputTokenBudget(spec)} out tok  ${spec.angle}`,
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

  // Trim before submitting, not while ingesting. Capping at ingest time bills
  // for the whole plan and throws the overflow away.
  if (!resumeBatchId && maxCases !== undefined) {
    const planned = plannedCaseCount(specs);
    if (planned > maxCases) {
      const before = specs.length;
      specs = trimPlanToCaseLimit(specs, maxCases);
      console.log(
        `EVAL_MAX_CASES=${maxCases} caps this plan: asking for ${plannedCaseCount(specs)} case(s) across ${specs.length} batch(es) instead of ${planned} across ${before}. Raise or unset EVAL_MAX_CASES to generate the full corpus.`,
      );
    }
  }

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

  const diagnostics = report.diagnostics;
  const diagnosticsPath = writeDiagnostics(diagnostics, {
    execution: useBatch ? "batch" : "sequential",
    batchId: collectedBatchId,
    accepted: report.accepted.length,
    corpusSize: merged.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    unpricedModels: usage.unpricedModels,
  });

  console.log(
    [
      "",
      `Prompt           ${diagnostics.promptId}`,
      `Batches called   ${report.batches}`,
      `Planned cases    ${diagnostics.plannedCases}`,
      `Cases returned   ${diagnostics.casesReturned}`,
      `Never returned   ${diagnostics.casesNeverReturned}`,
      `Accepted         ${report.accepted.length}`,
      `Rejected         ${report.rejected}`,
      `Duplicates       ${report.duplicates}`,
      "",
      "Request outcomes (counted in requests):",
      ...formatTally(diagnostics.requestOutcomes),
      "",
      "Case rejections (counted in returned candidates):",
      ...formatTally(diagnostics.caseRejections),
      ...(Object.keys(diagnostics.schemaIssues).length > 0
        ? ["", "Schema failures by field:", ...formatTally(diagnostics.schemaIssues)]
        : []),
      "",
      `Corpus size      ${merged.length}`,
      `Splits assigned  ${Object.keys(assigned).length}`,
      `Tokens in / out  ${usage.inputTokens} / ${usage.outputTokens}`,
      `Estimated cost   ${usage.estimatedCostUsd === undefined ? `unavailable (unpriced: ${usage.unpricedModels.join(", ") || "no pricing configured"})` : `$${usage.estimatedCostUsd.toFixed(4)}${useBatch ? " (batch rate)" : ""}`}`,
      `Diagnostics      ${diagnosticsPath}`,
    ].join("\n"),
  );

  const lost =
    diagnostics.requestOutcomes["truncated-salvaged"] +
    diagnostics.requestOutcomes["truncated-empty"];
  if (lost > 0) {
    console.log(
      `\n${lost} reply/replies hit the output ceiling. Complete cases were salvaged; lower --batch-size or raise OUTPUT_TOKENS_PER_CASE if this persists.`,
    );
  }
  if (diagnostics.caseRejections["case-cap-reached"] > 0) {
    console.log(
      `\n${diagnostics.caseRejections["case-cap-reached"]} valid case(s) were discarded by EVAL_MAX_CASES after being paid for. Trim the plan instead.`,
    );
  }
}

function formatTally(tally: Record<string, number>): string[] {
  const entries = Object.entries(tally).filter(([, count]) => count > 0);
  if (entries.length === 0) return ["  (none)"];
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `  ${key.padEnd(width)}  ${count}`);
}

/**
 * Persists the rejection breakdown next to the run records. Without this the
 * only trace of why a paid generation run yielded what it did is the console
 * scrollback of the process that ran it.
 */
function writeDiagnostics(
  diagnostics: GenerationDiagnostics,
  extra: Record<string, unknown>,
): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dir = path.join(process.cwd(), "evals", "results");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${stamp}-generate.json`);
  writeFileSync(
    filePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), ...extra, diagnostics }, null, 2) + "\n",
    "utf8",
  );
  return path.relative(process.cwd(), filePath);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
