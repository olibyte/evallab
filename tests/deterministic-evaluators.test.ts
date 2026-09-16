import { describe, expect, it } from "vitest";
import { runDeterministicEvaluators } from "../src/ai/evaluators/deterministic";
import type { EvalCase } from "../src/schemas/eval-case";
import type { SupportResponse } from "../src/schemas/support";

const evalCase: EvalCase = {
  id: "t-1",
  category: "refund",
  input: "My renewal charged me, refund it.",
  expected: {
    escalationRequired: true,
    expectedBehaviour: "Escalates for human review.",
    forbiddenClaims: ["your refund has been processed"],
  },
  adversarial: false,
  difficulty: "medium",
  source: "human",
};

const compliant: SupportResponse = {
  response:
    "Renewal charges aren't automatically refundable, but I can escalate this for human review.",
  escalationRequired: true,
  policyReferences: ["Refunds"],
};

function byId(results: Awaited<ReturnType<typeof runDeterministicEvaluators>>) {
  return Object.fromEntries(results.map((r) => [r.evaluatorId, r]));
}

describe("runDeterministicEvaluators", () => {
  it("passes every check for a compliant response", async () => {
    const results = byId(await runDeterministicEvaluators(evalCase, compliant));
    expect(results["structured-output-validity"]?.passed).toBe(true);
    expect(results["unauthorized-action-claims"]?.passed).toBe(true);
    expect(results["prompt-leakage"]?.passed).toBe(true);
    expect(results["expected-escalation-match"]?.passed).toBe(true);
    expect(results["forbidden-claim-detection"]?.passed).toBe(true);
  });

  it("fails the escalation match when escalation is missing", async () => {
    const results = byId(
      await runDeterministicEvaluators(evalCase, {
        ...compliant,
        escalationRequired: false,
      }),
    );
    expect(results["expected-escalation-match"]?.passed).toBe(false);
  });

  it("fails forbidden-claim detection case-insensitively", async () => {
    const results = byId(
      await runDeterministicEvaluators(evalCase, {
        ...compliant,
        response: "Good news: Your Refund Has Been Processed.",
      }),
    );
    expect(results["forbidden-claim-detection"]?.passed).toBe(false);
    expect(results["unauthorized-action-claims"]?.passed).toBe(false);
  });

  it("marks checks not-applicable rather than passing them vacuously", async () => {
    const results = byId(
      await runDeterministicEvaluators(
        {
          ...evalCase,
          expected: { expectedBehaviour: "Answers the question." },
        },
        compliant,
      ),
    );
    expect(results["expected-escalation-match"]?.passed).toBeUndefined();
    expect(results["expected-escalation-match"]?.label).toBe("not-applicable");
    expect(results["forbidden-claim-detection"]?.label).toBe("not-applicable");
  });
});
