import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelClient } from "@/src/ai/client/anthropic";
import { isTruncated } from "@/src/ai/evaluators/rubric-judge";
import { ModelError } from "@/src/ai/client/errors";
import { extractJsonObject } from "@/src/ai/generation/json";
import { promptOptimizerPromptV1 } from "@/src/ai/prompts/judges/prompt-optimizer-v1";
import type { PromptDefinition } from "@/src/ai/prompts/types";
import { escapeDelimiters } from "@/src/ai/prompts/untrusted";
import type { EvalCase } from "@/src/schemas/eval-case";
import { caseVerdict } from "./compare";
import type { PromptCandidate } from "./candidates";
import { evaluateGates, type RunMetrics } from "./metrics";
import { RESULTS_DIR, type ExperimentRun } from "./results";
import type { UsageTracker } from "./paid-guard";

/** The only split prompt optimization is allowed to read. */
export const OPTIMIZATION_SPLIT = "dev";

/**
 * Output ceiling for the one proposal call. Several full system prompts plus,
 * on Claude 5 models, the adaptive thinking that precedes them: thinking
 * tokens count against `max_tokens`. The second live `prompt:optimize`
 * (2026-09-17) got an unparseable proposal at 8000, so the ceiling is now
 * 16000 and a reply that stops on `max_tokens` is reported as truncation
 * rather than as a malformed proposal.
 */
export const OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS = 16_000;

/**
 * The proposal call writes several complete system prompts in one reply and
 * cannot finish inside the client's 30 s default, which is sized for one
 * customer response. The first live `prompt:optimize` (2026-09-17) died here
 * with "Model call timed out after 30000ms". This ceiling applies to the
 * proposal call only; application inference keeps the default.
 */
export const OPTIMIZER_PROPOSAL_TIMEOUT_MS = 600_000;

export const PROPOSAL_TRUNCATED_MESSAGE =
  "Prompt optimizer reply was truncated at the output ceiling (stop_reason=max_tokens); no candidates were read from it.";

/**
 * The raw proposal reply, saved under evals/results/proposals whether or not it parsed:
 * it is paid work and the only evidence when the proposer fails.
 */
export type ProposalRecord = {
  optimizationRunId: string;
  baselineRunId: string;
  createdAt: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
  maxOutputTokens: number;
  text: string;
  /** Set when the reply could not be used. */
  failure?: string;
};

/** Kept apart from the runs so a run listing never offers a proposal as a run. */
export const PROPOSALS_DIR = path.join(RESULTS_DIR, "proposals");

export function proposalRecordPath(optimizationRunId: string): string {
  return path.join(PROPOSALS_DIR, `${optimizationRunId}.json`);
}

function saveProposalRecord(record: ProposalRecord): string {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const filePath = proposalRecordPath(record.optimizationRunId);
  writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return filePath;
}

const proposalSchema = z.object({
  candidates: z
    .array(
      z.object({
        description: z.string().min(1),
        systemPrompt: z.string().min(200),
      }),
    )
    .min(1),
});

/**
 * Failed cases from a baseline run, most informative first. Rubric-only
 * failures (deterministic pass, low judge score) are included after
 * deterministic ones so the proposer also sees quality problems.
 */
export function selectFailures(run: ExperimentRun, limit = 12) {
  const rank = (c: ExperimentRun["cases"][number]) => {
    const verdict = caseVerdict(c);
    if (verdict === "error") return 0;
    if (verdict === "fail") return c.adversarial ? 1 : 2;
    if ((c.automatedQualityScore ?? 100) < 60) return 3;
    return 4;
  };
  return run.cases
    .filter((c) => rank(c) < 4)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

export function buildOptimizerUserContent(
  prompt: PromptDefinition,
  failures: ReturnType<typeof selectFailures>,
  candidateCount: number,
): string {
  const failureText = failures
    .map((failure, index) => {
      const checks = failure.deterministic
        .filter((r) => r.passed === false)
        .map((r) => `${r.evaluatorId} - ${r.rationale ?? ""}`);
      const rubric = failure.rubric
        ? Object.entries(failure.rubric)
            .filter(([, dimension]) => dimension.score <= 3)
            .map(([name, dimension]) => `${name} ${dimension.score}/5 - ${dimension.rationale}`)
        : [];
      return [
        `Failure ${index + 1} (${failure.category}, adversarial=${failure.adversarial})`,
        `  customer message: ${escapeDelimiters(failure.input)}`,
        `  assistant response: ${escapeDelimiters(failure.output?.response ?? "(generation failed)")}`,
        `  failed checks: ${[...checks, ...rubric].join("; ") || failure.error || "unknown"}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "<current_system_prompt>",
    prompt.systemPrompt,
    "</current_system_prompt>",
    "",
    "<observed_failures>",
    failureText || "(no failures were recorded in this run)",
    "</observed_failures>",
    "",
    `Propose exactly ${candidateCount} candidates.`,
    "Reply with a single JSON object and nothing else:",
    '{ "candidates": [ { "description": string, "systemPrompt": string } ] }',
  ].join("\n");
}

/** Verbatim overlap at least this long means the prompt copied a test case. */
export const LEAKAGE_WINDOW_CHARS = 40;

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export type LeakageHit = { caseId: string; fragment: string };

/**
 * Detects a candidate prompt that quotes eval-case inputs. Any window of
 * LEAKAGE_WINDOW_CHARS normalised characters from a case input appearing in
 * the prompt is memorisation, not generalisation.
 */
export function detectCaseLeakage(
  systemPrompt: string,
  cases: EvalCase[],
  window = LEAKAGE_WINDOW_CHARS,
): LeakageHit[] {
  const haystack = normalise(systemPrompt);
  const hits: LeakageHit[] = [];
  for (const evalCase of cases) {
    const needle = normalise(evalCase.input);
    if (needle.length < window) {
      if (needle.length >= 20 && haystack.includes(needle)) {
        hits.push({ caseId: evalCase.id, fragment: needle });
      }
      continue;
    }
    for (let start = 0; start + window <= needle.length; start += 1) {
      const fragment = needle.slice(start, start + window);
      if (haystack.includes(fragment)) {
        hits.push({ caseId: evalCase.id, fragment });
        break;
      }
    }
  }
  return hits;
}

/**
 * A baseline run reused for optimization must have covered exactly the dev
 * cases about to be used, with the same prompt. Anything else either leaks
 * held-out cases into the proposer or compares candidates against a
 * different test.
 */
export function assertBaselineUsable(
  baseline: ExperimentRun,
  prompt: PromptDefinition,
  devCases: EvalCase[],
): void {
  const problems: string[] = [];
  if (baseline.config.split !== OPTIMIZATION_SPLIT) {
    problems.push(
      `it ran on split "${baseline.config.split}", and optimization may only read "${OPTIMIZATION_SPLIT}"`,
    );
  }
  if (baseline.config.promptSource !== "registry" || baseline.config.promptId !== prompt.id) {
    problems.push(
      `it evaluated ${baseline.config.candidateId ?? baseline.config.promptId}, not ${prompt.id}`,
    );
  }
  if (baseline.config.mode !== "live") {
    problems.push("it is an offline run and carries no model output");
  }
  const expected = new Set(devCases.map((c) => c.id));
  const actual = new Set(baseline.cases.map((c) => c.caseId));
  const missing = [...expected].filter((id) => !actual.has(id)).length;
  const extra = [...actual].filter((id) => !expected.has(id)).length;
  if (missing > 0 || extra > 0) {
    problems.push(
      `it covers a different case set (${missing} missing, ${extra} extra) from the ${devCases.length} dev case(s) selected`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Baseline run ${baseline.runId} cannot be reused for optimization: ${problems.join("; ")}.`,
    );
  }
}

export type ProposeOptions = {
  client: ModelClient;
  prompt: PromptDefinition;
  baseline: ExperimentRun;
  /** The dev cases; used to reject candidates that quote them. */
  cases: EvalCase[];
  optimizationRunId: string;
  candidateCount: number;
  usage: UsageTracker;
  /** Persist the raw reply under evals/results (default true; tests opt out). */
  save?: boolean;
};

export type ProposalResult = {
  candidates: PromptCandidate[];
  /** Proposals discarded for quoting eval cases, with what they quoted. */
  rejected: { description: string; hits: LeakageHit[] }[];
};

/** Proposes candidates. Never touches ACTIVE_SUPPORT_PROMPT. */
export async function proposeCandidates(
  options: ProposeOptions,
): Promise<ProposalResult> {
  const failures = selectFailures(options.baseline);
  const result = await options.client.complete({
    system: promptOptimizerPromptV1.systemPrompt,
    userContent: buildOptimizerUserContent(
      options.prompt,
      failures,
      options.candidateCount,
    ),
    maxOutputTokens: OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS,
    timeoutMs: OPTIMIZER_PROPOSAL_TIMEOUT_MS,
    // Diverse proposals, not a reproducible one. Dropped by the client on
    // models that have removed sampling parameters.
    temperature: 1,
  });
  options.usage.record(result.model, result.inputTokens, result.outputTokens);

  const createdAt = new Date().toISOString();
  const record: ProposalRecord = {
    optimizationRunId: options.optimizationRunId,
    baselineRunId: options.baseline.runId,
    createdAt,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    stopReason: result.stopReason,
    maxOutputTokens: OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS,
    text: result.text,
  };

  if (isTruncated(result.stopReason)) {
    record.failure = PROPOSAL_TRUNCATED_MESSAGE;
    const saved = options.save === false ? undefined : saveProposalRecord(record);
    throw new ModelError(
      "malformed-output",
      `${PROPOSAL_TRUNCATED_MESSAGE} The reply used ${result.outputTokens} output tokens against a ceiling of ${OPTIMIZER_PROPOSAL_MAX_OUTPUT_TOKENS}.${saved ? ` Raw reply saved to ${saved}.` : ""}`,
    );
  }

  const parsed = proposalSchema.safeParse(extractJsonObject(result.text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    record.failure = `Prompt optimizer did not return valid candidate proposals: ${issues}`;
    const saved = options.save === false ? undefined : saveProposalRecord(record);
    throw new ModelError(
      "malformed-output",
      `${record.failure} (stop_reason=${result.stopReason ?? "unknown"}, ${result.outputTokens} output tokens).${saved ? ` Raw reply saved to ${saved}.` : ""}`,
      { cause: parsed.error },
    );
  }
  if (options.save !== false) saveProposalRecord(record);

  const rejected: ProposalResult["rejected"] = [];
  const candidates: PromptCandidate[] = [];

  for (const proposal of parsed.data.candidates.slice(0, options.candidateCount)) {
    const hits = detectCaseLeakage(proposal.systemPrompt, options.cases);
    if (hits.length > 0) {
      rejected.push({ description: proposal.description, hits });
      continue;
    }
    candidates.push({
      candidateId: `${options.optimizationRunId}-c${candidates.length + 1}`,
      parentPromptId: options.prompt.id,
      optimizationRunId: options.optimizationRunId,
      description: proposal.description,
      createdAt,
      systemPrompt: proposal.systemPrompt,
    });
  }

  return { candidates, rejected };
}

export type Recommendation = {
  candidateId?: string;
  promote: false;
  summary: string;
  detail: string[];
};

/**
 * Produces a recommendation, never an automatic promotion. The metrics here
 * come from the dev split: they chose the candidate, so they cannot also be
 * the evidence for promoting it. The held-out benchmark is a separate step.
 */
export function buildRecommendation(
  baseline: { metrics: RunMetrics },
  candidates: { candidateId: string; metrics: RunMetrics }[],
): Recommendation {
  const detail: string[] = [];

  const eligible = candidates.filter((candidate) => {
    const gates = evaluateGates(candidate.metrics);
    const failed = gates.filter((gate) => !gate.passed);
    if (failed.length > 0) {
      detail.push(
        `${candidate.candidateId}: blocked by ${failed.map((g) => g.id).join(", ")}.`,
      );
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return {
      promote: false,
      summary: "No candidate passed every hard gate on the dev split. Keep the current prompt.",
      detail,
    };
  }

  const scored = eligible
    .map((candidate) => ({
      candidate,
      score: candidate.metrics.rubric.automatedQualityScore ?? -1,
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const baselineScore = baseline.metrics.rubric.automatedQualityScore;

  if (baselineScore !== undefined && best.score <= baselineScore) {
    detail.push(
      `Best candidate scored ${best.score.toFixed(1)} against a baseline of ${baselineScore.toFixed(1)} on the dev split.`,
    );
    return {
      promote: false,
      summary: "No candidate beat the baseline on the dev split. Keep the current prompt.",
      detail,
    };
  }

  detail.push(
    `${best.candidate.candidateId} passed all gates on the dev split with an automated quality score of ${best.score.toFixed(1)} (baseline ${baselineScore === undefined ? "n/a" : baselineScore.toFixed(1)}).`,
  );
  return {
    candidateId: best.candidate.candidateId,
    promote: false,
    summary: `${best.candidate.candidateId} is recommended for a held-out evaluation. Dev-split scores selected it and are not evidence for promotion: run \`pnpm eval:run --candidate ${best.candidate.candidateId} --split holdout --mode live\` alongside the baseline on the same split, compare with \`pnpm eval:compare\`, and only then decide. Promotion is a manual source change.`,
    detail,
  };
}
