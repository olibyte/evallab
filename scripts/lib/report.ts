import type { Comparison } from "@/src/evals/compare";
import type { GateResult, RunMetrics } from "@/src/evals/metrics";

function fmt(value: number | undefined, digits = 2): string {
  return value === undefined ? "n/a" : value.toFixed(digits);
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function printMetrics(metrics: RunMetrics, indent = ""): void {
  const lines = [
    `Cases                       ${metrics.cases} (${metrics.errors} without valid output)`,
    `Policy compliance mean      ${fmt(metrics.rubric.policyCompliance)}`,
    `Groundedness mean           ${fmt(metrics.rubric.groundedness)}`,
    `Helpfulness mean            ${fmt(metrics.rubric.helpfulness)}`,
    `Tone mean                   ${fmt(metrics.rubric.tone)}`,
    `Automated quality score     ${fmt(metrics.rubric.automatedQualityScore, 1)}`,
    `Judged cases                ${metrics.rubric.judgedCases} of ${metrics.cases} (${metrics.rubric.unjudgedCases} unjudged with output)`,
    `Deterministic pass (case)   ${pct(metrics.deterministicPassRate)}`,
    `Adversarial pass (case)     ${pct(metrics.adversarialPassRate)} over ${metrics.adversarialCases} case(s)`,
    `Latency mean / median       ${fmt(metrics.latencyMeanMs, 0)}ms / ${fmt(metrics.latencyMedianMs, 0)}ms`,
    `Tokens in / out             ${metrics.inputTokens} / ${metrics.outputTokens}`,
    `Estimated cost              ${metrics.estimatedCostUsd === undefined ? "unavailable (no pricing, or an unpriced model was used)" : `$${metrics.estimatedCostUsd.toFixed(4)}`}`,
  ];
  for (const line of lines) console.log(indent + line);

  console.log(`${indent}Evaluator pass rates`);
  for (const [id, rate] of Object.entries(metrics.evaluatorPassRates)) {
    console.log(`${indent}  ${id.padEnd(30)} ${pct(rate)}`);
  }
}

export function printGates(gates: GateResult[], indent = ""): void {
  console.log(`\n${indent}Promotion gates (configuration, not proof of safety)`);
  for (const gate of gates) {
    const status = gate.passed ? "PASS" : "FAIL";
    const actual = gate.actual === undefined ? "no measurement" : fmt(gate.actual, 3);
    console.log(
      `${indent}  [${status}] ${gate.id.padEnd(32)} ${actual} (>= ${gate.threshold})${gate.note ? ` - ${gate.note}` : ""}`,
    );
  }
}

export function printComparison(comparison: Comparison): void {
  for (const warning of comparison.warnings) {
    console.warn(`WARNING: ${warning}`);
  }
  if (comparison.warnings.length > 0) console.log("");

  if (!comparison.comparable) {
    console.warn("NOT COMPARABLE: the runs differ in what was tested or how. This must not become a benchmark.\n");
  }

  const entries = [comparison.baseline, ...comparison.candidates];
  for (const [index, entry] of entries.entries()) {
    const role = index === 0 ? "BASELINE" : `CANDIDATE ${index}`;
    console.log(
      `${role}: ${entry.candidateId ?? entry.promptId}  run=${entry.runId}  dataset=${entry.datasetId}/${entry.split} (${entry.datasetSize} cases, ${entry.mode}, ${entry.execution})`,
    );
    console.log(
      `  generation=${entry.generationModel}  judge=${entry.judgeModel ?? "none"} (${entry.judgePromptId ?? "no judge prompt"})  prompt-hash=${entry.promptHash?.slice(0, 12) ?? "n/a"}`,
    );
    printMetrics(entry.metrics, "  ");
    console.log("");
  }

  const describe = (change: Comparison["improvements"][number]) =>
    change.reason === "rubric"
      ? `${change.caseId} (${change.category}) quality ${change.baselineQualityScore} -> ${change.candidateQualityScore}`
      : `${change.caseId} (${change.category}) ${change.baseline} -> ${change.candidate}`;

  console.log(`Improved cases: ${comparison.improvements.length}`);
  for (const change of comparison.improvements) console.log(`  + ${describe(change)}`);
  console.log(`Regressed cases: ${comparison.regressions.length}`);
  for (const change of comparison.regressions) console.log(`  - ${describe(change)}`);
}
