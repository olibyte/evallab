import { computeMetrics, type RunMetrics } from "./metrics";
import type { CaseResult, ExperimentRun } from "./results";

export type CaseVerdict = "pass" | "fail" | "error";

export type CaseChange = {
  caseId: string;
  category: string;
  adversarial: boolean;
  baseline: CaseVerdict;
  candidate: CaseVerdict;
};

export type ComparisonEntry = {
  runId: string;
  promptId: string;
  candidateId?: string;
  datasetId: string;
  datasetSize: number;
  mode: "live" | "offline";
  metrics: RunMetrics;
};

export type Comparison = {
  baseline: ComparisonEntry;
  candidates: ComparisonEntry[];
  /** Non-empty when the runs do not share a dataset; always surfaced. */
  warnings: string[];
  improvements: CaseChange[];
  regressions: CaseChange[];
};

export function caseVerdict(result: CaseResult | undefined): CaseVerdict {
  if (!result || result.error) return "error";
  const verdicts = result.deterministic.filter(
    (r) => typeof r.passed === "boolean",
  );
  return verdicts.every((r) => r.passed) ? "pass" : "fail";
}

function toEntry(run: ExperimentRun): ComparisonEntry {
  return {
    runId: run.runId,
    promptId: run.config.promptId,
    candidateId: run.config.candidateId,
    datasetId: run.config.datasetId,
    datasetSize: run.config.datasetSize,
    mode: run.config.mode,
    metrics: computeMetrics(run),
  };
}

function diffCases(baseline: ExperimentRun, candidate: ExperimentRun) {
  const baselineById = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const improvements: CaseChange[] = [];
  const regressions: CaseChange[] = [];

  for (const candidateCase of candidate.cases) {
    const baselineCase = baselineById.get(candidateCase.caseId);
    if (!baselineCase) continue;
    const before = caseVerdict(baselineCase);
    const after = caseVerdict(candidateCase);
    if (before === after) continue;

    const change: CaseChange = {
      caseId: candidateCase.caseId,
      category: candidateCase.category,
      adversarial: candidateCase.adversarial,
      baseline: before,
      candidate: after,
    };
    if (after === "pass") improvements.push(change);
    else regressions.push(change);
  }
  return { improvements, regressions };
}

/**
 * Compares existing run records. Never reruns models. Dataset and mode
 * differences are reported as warnings rather than silently averaged over.
 */
export function compareRuns(runs: ExperimentRun[]): Comparison {
  if (runs.length < 2) {
    throw new Error("Comparison requires at least two experiment runs.");
  }
  const [baselineRun, ...candidateRuns] = runs as [ExperimentRun, ...ExperimentRun[]];

  const warnings: string[] = [];
  for (const run of candidateRuns) {
    if (run.config.datasetId !== baselineRun.config.datasetId) {
      warnings.push(
        `Run ${run.runId} uses dataset "${run.config.datasetId}" but the baseline uses "${baselineRun.config.datasetId}". Metrics are not directly comparable.`,
      );
    } else if (run.config.datasetSize !== baselineRun.config.datasetSize) {
      warnings.push(
        `Run ${run.runId} covers ${run.config.datasetSize} cases but the baseline covers ${baselineRun.config.datasetSize}.`,
      );
    }
    if (run.config.mode !== baselineRun.config.mode) {
      warnings.push(
        `Run ${run.runId} ran in ${run.config.mode} mode but the baseline ran in ${baselineRun.config.mode} mode.`,
      );
    }
  }

  const diffs = candidateRuns.map((run) => diffCases(baselineRun, run));

  return {
    baseline: toEntry(baselineRun),
    candidates: candidateRuns.map(toEntry),
    warnings,
    improvements: diffs.flatMap((d) => d.improvements),
    regressions: diffs.flatMap((d) => d.regressions),
  };
}
