import type { RespondResult } from "@/src/ai/pipeline/types";
import {
  GUARDRAIL_FAILURE_LABEL,
  QUALITY_SCORE_LABEL,
} from "@/src/ai/evaluators/quality-score";

const DIMENSIONS = [
  ["policyCompliance", "Policy compliance"],
  ["groundedness", "Groundedness"],
  ["helpfulness", "Helpfulness"],
  ["tone", "Tone"],
] as const;

function Badge({
  tone,
  children,
}: {
  tone: "neutral" | "good" | "warn" | "bad";
  children: React.ReactNode;
}) {
  const classes = {
    neutral: "bg-gray-800 text-gray-300 ring-gray-700",
    good: "bg-emerald-950 text-emerald-300 ring-emerald-800",
    warn: "bg-amber-950 text-amber-300 ring-amber-800",
    bad: "bg-red-950 text-red-300 ring-red-800",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {children}
    </span>
  );
}

export function ResultView({ result }: { result: RespondResult }) {
  const guardrailFailed = result.guardrails.outputChecks.some(
    (check) => check.passed === false,
  );

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.metadata.source === "live" ? "good" : "neutral"}>
          {result.metadata.source === "live" ? "Live" : "Replay"}
        </Badge>
        {result.response.escalationRequired && <Badge tone="warn">Escalated</Badge>}
        {guardrailFailed && <Badge tone="bad">{GUARDRAIL_FAILURE_LABEL}</Badge>}
      </div>

      <article className="rounded-lg border border-gray-800 bg-gray-950/60 p-5">
        <h2 className="mb-3 text-sm font-medium text-gray-400">
          Assistant response
        </h2>
        <p className="whitespace-pre-wrap text-gray-100">
          {result.response.response}
        </p>
        {result.response.escalationReason && (
          <p className="mt-4 text-sm text-amber-300/90">
            Escalation reason: {result.response.escalationReason}
          </p>
        )}
        {result.response.policyReferences.length > 0 && (
          <p className="mt-3 text-sm text-gray-500">
            Policy referenced: {result.response.policyReferences.join(", ")}
          </p>
        )}
      </article>

      <div className="rounded-lg border border-gray-800 p-5">
        <h2 className="text-sm font-medium text-gray-400">
          {QUALITY_SCORE_LABEL}
        </h2>
        {result.evaluation.available ? (
          <>
            <p className="mt-1 text-3xl font-semibold text-gray-100">
              {result.evaluation.automatedQualityScore.toFixed(1)}%
            </p>
            <p className="mt-1 text-xs text-gray-500">
              A weighted rubric score from an LLM judge. It is an automated
              signal, not objective ground truth.
            </p>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              {DIMENSIONS.map(([key, label]) => {
                const dimension = result.evaluation.available
                  ? result.evaluation.rubric[key]
                  : undefined;
                if (!dimension) return null;
                return (
                  <div key={key} className="rounded border border-gray-800 p-3">
                    <dt className="flex items-baseline justify-between text-sm text-gray-300">
                      <span>{label}</span>
                      <span className="font-mono text-gray-100">
                        {dimension.score}/5
                      </span>
                    </dt>
                    <dd className="mt-1 text-xs text-gray-500">
                      {dimension.rationale}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </>
        ) : (
          <p className="mt-2 text-sm text-gray-400">
            Evaluation unavailable.{" "}
            {result.evaluation.reason ??
              "No judge result is available for this response."}{" "}
            No score is shown rather than an invented one.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-gray-800 p-5">
        <h2 className="text-sm font-medium text-gray-400">Guardrails</h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          <li className="flex flex-wrap items-center gap-2">
            <span className="text-gray-300">Prompt injection</span>
            <Badge
              tone={result.guardrails.injection.detected ? "warn" : "good"}
            >
              {result.guardrails.injection.detected
                ? `detected (${result.guardrails.injection.risk} risk)`
                : "none detected"}
            </Badge>
            {result.guardrails.injection.categories.length > 0 && (
              <span className="text-xs text-gray-500">
                {result.guardrails.injection.categories.join(", ")}
              </span>
            )}
          </li>
          {result.guardrails.outputChecks.map((check) => (
            <li key={check.evaluatorId} className="flex flex-wrap items-center gap-2">
              <span className="text-gray-300">
                {check.evaluatorId === "unauthorized-action-claims"
                  ? "Unauthorized action claim"
                  : "System-prompt leakage"}
              </span>
              <Badge tone={check.passed ? "good" : "bad"}>
                {check.passed ? "pass" : "fail"}
              </Badge>
              {!check.passed && (
                <span className="text-xs text-red-300">{check.rationale}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm text-gray-400 sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt>Prompt version</dt>
          <dd className="font-mono text-gray-300">{result.metadata.promptId}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Generation model</dt>
          <dd className="font-mono text-gray-300">
            {result.metadata.generationModel}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Judge model</dt>
          <dd className="font-mono text-gray-300">
            {result.metadata.judgeModel ?? "not configured"}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Latency</dt>
          <dd className="font-mono text-gray-300">
            {result.metadata.source === "replay"
              ? "n/a (replay)"
              : `${result.metadata.latencyMs}ms`}
          </dd>
        </div>
      </dl>
    </section>
  );
}
