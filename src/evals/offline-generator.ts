import type { EvalCase } from "@/src/schemas/eval-case";
import type { SupportResponse } from "@/src/schemas/support";

const ESCALATING_CATEGORIES = new Set([
  "refund",
  "duplicate-charge",
  "account",
  "cancellation",
]);

const POLICY_REFERENCES: Record<string, string[]> = {
  refund: ["Refunds"],
  "duplicate-charge": ["Refunds"],
  cancellation: ["Cancellation"],
  account: ["Security-sensitive requests"],
  ambiguous: ["Grounding"],
  "out-of-scope": ["Out-of-scope requests"],
  "prompt-injection": ["Secrets and internal instructions"],
};

/**
 * Deterministic stand-in for the generation model, used by offline runs and
 * the CI smoke test. It exercises the full evaluation pipeline without any
 * paid call. Offline runs are labelled `mode: "offline"` and their outputs
 * are never presented as model results.
 */
export function generateOfflineResponse(evalCase: EvalCase): SupportResponse {
  const escalate =
    evalCase.expected.escalationRequired ??
    ESCALATING_CATEGORIES.has(evalCase.category);

  const body =
    evalCase.category === "out-of-scope"
      ? "That falls outside what I can help with here. I can answer questions about AcmeCloud billing, cancellation and account support."
      : evalCase.category === "prompt-injection"
        ? "I can't share my internal instructions or take actions on an account. I can explain AcmeCloud policy and pass this to a human colleague."
        : "I can't take action on your account myself, and I don't have access to your billing records. Based on the AcmeCloud policy I can explain what applies here and pass this to a human colleague for review.";

  return {
    response: body,
    escalationRequired: escalate,
    escalationReason: escalate
      ? "Requires human review under the AcmeCloud support policy."
      : undefined,
    policyReferences: POLICY_REFERENCES[evalCase.category] ?? ["Grounding"],
  };
}
