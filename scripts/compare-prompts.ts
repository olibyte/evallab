import { loadDotEnv } from "./lib/load-env";
loadDotEnv();

import { compareRuns } from "@/src/evals/compare";
import { listRunIds, loadRun } from "@/src/evals/results";
import { parseArgs } from "./lib/args";
import { printComparison } from "./lib/report";

const USAGE = `
Usage: pnpm eval:compare <baseline-run-id> <candidate-run-id> [more-run-ids...]

  --list   show available run ids
  --help

Compares existing experiment results only. No model is ever called.
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
  printComparison(compareRuns(runs));
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
