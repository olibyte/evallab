import { loadDatasets } from "@/src/evals/dataset";
import { DATASET_PRESETS } from "@/src/evals/datasets-config";
import {
  assignSplits,
  loadSplitManifest,
  saveSplitManifest,
  SPLITS_PATH,
  summariseSplits,
} from "@/src/evals/splits";
import { parseArgs } from "./lib/args";

const USAGE = `
Usage: pnpm eval:splits [--check]

Assigns a split (dev | heldout | adversarial-holdout) to every eval case
that does not have one yet and writes evals/datasets/splits.json.
Existing assignments are never changed.

  --check   exit non-zero if any case is unassigned; write nothing
  --help

No model is called. Prompt optimization may only read the dev split;
benchmarks are expected to run on the holdout splits.
`.trim();

function main() {
  const args = parseArgs();
  if (args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  const cases = loadDatasets(DATASET_PRESETS.all!);
  const manifest = loadSplitManifest();
  const before = summariseSplits(cases, manifest);

  if (args.flags.has("check")) {
    if (before.unassigned > 0) {
      console.error(
        `${before.unassigned} case(s) have no split assignment. Run \`pnpm eval:splits\`.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`All ${cases.length} cases are assigned.`);
    printSummary(before);
    return;
  }

  const { manifest: updated, assigned } = assignSplits(cases, manifest);
  const newlyAssigned = Object.keys(assigned).length;
  if (newlyAssigned > 0) saveSplitManifest(updated);

  console.log(
    newlyAssigned === 0
      ? `No unassigned cases; ${SPLITS_PATH} unchanged.`
      : `Assigned ${newlyAssigned} new case(s); wrote ${SPLITS_PATH}.`,
  );
  printSummary(summariseSplits(cases, updated));
}

function printSummary(summary: ReturnType<typeof summariseSplits>) {
  for (const [split, count] of Object.entries(summary)) {
    console.log(`  ${split.padEnd(22)} ${count}`);
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
