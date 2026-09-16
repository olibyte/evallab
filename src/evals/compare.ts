import { computeMetrics, evaluateGates, type GateResult, type RunMetrics } from "./metrics";
import type { CaseResult, ExperimentRun } from "./results";

export type CaseVerdict = "pass" | "fail" | "error";

export type CaseChange = {
  caseId: string;
  category: string;
  adversarial: boolean;
  baseline: CaseVerdict;
  candidate: CaseVerdict;
  /** Present for rubric-driven changes. */
  baselineQualityScore?: number;
  candidateQualityScore?: number;
  reason: "deterministic" | "rubric";
};

/**
 * A drop in automated quality score at least this large is a regression even
 * when every deterministic check still passes. 25 points is one full rubric
 * point across every dimension.
 */
export const RUBRIC_REGRESSION_THRESHOLD = 20;

export type ComparisonEntry = {
  runId: string;
  promptId: string;
  promptVersion: number;
  promptHash?: string;
  promptSource: "registry" | "candidate";
  candidateId?: string;
  datasetId: string;
  datasetSize: number;
  split: string;
  datasetHash?: string;
  mode: "live" | "offline";
  execution: "sequential" | "batch";
  generationModel: string;
  judgeModel?: string;
  judgePromptId?: string;
  startedAt: string;
  finishedAt: string;
  usage: ExperimentRun["usage"];
  metrics: RunMetrics;
  gates: GateResult[];
};

export type Comparison = {
  baseline: ComparisonEntry;
  candidates: ComparisonEntry[];
  /** Non-empty when the runs are not like-for-like; always surfaced. */
  warnings: string[];
  /**
   * False when any run differs from the baseline in the cases it covered,
   * its mode, or its generation/judge configuration. Metrics are still
   * reported, but such a comparison must not become a benchmark.
   */
  comparable: boolean;
  improvements: CaseChange[];
  regressions: CaseChange[];
};

export function caseVerdict(result: CaseResult | undefined): CaseVerdict {
  if (!result || result.error || !result.output) return "error";
  const verdicts = result.deterministic.filter(
    (r) => typeof r.passed === "boolean",
  );
  return verdicts.every((r) => r.passed) ? "pass" : "fail";
}

function toEntry(run: ExperimentRun): ComparisonEntry {
  const metrics = computeMetrics(run);
  return {
    runId: run.runId,
    promptId: run.config.promptId,
    promptVersion: run.config.promptVersion,
    promptHash: run.config.promptHash,
    promptSource: run.config.promptSource,
    candidateId: run.config.candidateId,
    datasetId: run.config.datasetId,
    datasetSize: run.config.datasetSize,
    split: run.config.split,
    datasetHash: run.config.datasetHash,
    mode: run.config.mode,
    execution: run.config.execution,
    generationModel: run.config.generationModel,
    judgeModel: run.config.judgeModel,
    judgePromptId: run.config.judgePromptId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    usage: run.usage,
    metrics,
    gates: evaluateGates(metrics),
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

    if (before !== after) {
      const change: CaseChange = {
        caseId: candidateCase.caseId,
        category: candidateCase.category,
        adversarial: candidateCase.adversarial,
        baseline: before,
        candidate: after,
        reason: "deterministic",
      };
      if (after === "pass") improvements.push(change);
      else regressions.push(change);
      continue;
    }

    const beforeScore = baselineCase.automatedQualityScore;
    const afterScore = candidateCase.automatedQualityScore;
    if (beforeScore === undefined || afterScore === undefined) continue;
    const delta = afterScore - beforeScore;
    if (Math.abs(delta) < RUBRIC_REGRESSION_THRESHOLD) continue;

    const change: CaseChange = {
      caseId: candidateCase.caseId,
      category: candidateCase.category,
      adversarial: candidateCase.adversarial,
      baseline: before,
      candidate: after,
      baselineQualityScore: beforeScore,
      candidateQualityScore: afterScore,
      reason: "rubric",
    };
    if (delta > 0) improvements.push(change);
    else regressions.push(change);
  }
  return { improvements, regressions };
}

function caseIdSet(run: ExperimentRun): Set<string> {
  return new Set(run.cases.map((c) => c.caseId));
}

/**
 * Compares existing run records. Never reruns models. Any difference in what
 * was tested or how is reported as a warning and makes the comparison
 * non-comparable; nothing is silently averaged over.
 */
export function compareRuns(runs: ExperimentRun[]): Comparison {
  if (runs.length < 2) {
    throw new Error("Comparison requires at least two experiment runs.");
  }
  const [baselineRun, ...candidateRuns] = runs as [ExperimentRun, ...ExperimentRun[]];

  const warnings: string[] = [];
  let comparable = true;
  const hard = (message: string) => {
    warnings.push(message);
    comparable = false;
  };

  const baselineIds = caseIdSet(baselineRun);
  const b = baselineRun.config;

  for (const run of candidateRuns) {
    const c = run.config;
    const label = `Run ${run.runId}`;

    if (c.datasetId !== b.datasetId) {
      hard(
        `${label} uses dataset "${c.datasetId}" but the baseline uses "${b.datasetId}". Metrics are not directly comparable.`,
      );
    }
    if (c.split !== b.split) {
      hard(`${label} ran on split "${c.split}" but the baseline ran on "${b.split}".`);
    }

    const ids = caseIdSet(run);
    const missing = [...baselineIds].filter((id) => !ids.has(id));
    const extra = [...ids].filter((id) => !baselineIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      hard(
        `${label} does not cover the same cases as the baseline (${missing.length} missing, ${extra.length} extra). Metrics are not directly comparable.`,
      );
    } else if (c.datasetHash && b.datasetHash && c.datasetHash !== b.datasetHash) {
      hard(
        `${label} covers the same case ids as the baseline but the case contents differ (dataset hash mismatch).`,
      );
    }

    if (c.mode !== b.mode) {
      hard(`${label} ran in ${c.mode} mode but the baseline ran in ${b.mode} mode.`);
    }
    if (c.generationModel !== b.generationModel) {
      hard(
        `${label} used generation model "${c.generationModel}" but the baseline used "${b.generationModel}".`,
      );
    }
    if ((c.judgeModel ?? "none") !== (b.judgeModel ?? "none")) {
      hard(
        `${label} used judge model "${c.judgeModel ?? "none"}" but the baseline used "${b.judgeModel ?? "none"}". Rubric scores are not comparable.`,
      );
    }
    if ((c.judgePromptId ?? "none") !== (b.judgePromptId ?? "none")) {
      hard(
        `${label} used judge prompt "${c.judgePromptId ?? "none"}" but the baseline used "${b.judgePromptId ?? "none"}". Rubric scores are not comparable.`,
      );
    }
    if (c.execution !== b.execution) {
      warnings.push(
        `${label} ran via ${c.execution} execution but the baseline ran via ${b.execution}. Results should match; latency and cost will not.`,
      );
    }
    if (
      c.promptSource === b.promptSource &&
      c.promptHash &&
      b.promptHash &&
      c.promptHash === b.promptHash
    ) {
      warnings.push(
        `${label} used exactly the same prompt text as the baseline; any difference is model variance, not the prompt.`,
      );
    }
  }

  const diffs = candidateRuns.map((run) => diffCases(baselineRun, run));

  return {
    baseline: toEntry(baselineRun),
    candidates: candidateRuns.map(toEntry),
    warnings,
    comparable,
    improvements: diffs.flatMap((d) => d.improvements),
    regressions: diffs.flatMap((d) => d.regressions),
  };
}
