import { describe, expect, it } from "vitest";
import { loadReplayFixtures } from "../src/replay/store";
import { respondFromFixture } from "../src/replay/respond";

describe("replay fixtures", () => {
  const fixtures = loadReplayFixtures();

  it("loads every authored fixture", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
  });

  it("covers the six demo categories", () => {
    expect(new Set(fixtures.map((f) => f.category))).toEqual(
      new Set([
        "refund",
        "duplicate-charge",
        "cancellation",
        "ambiguous",
        "prompt-injection",
        "account",
      ]),
    );
  });

  it("never claims to be a live model call", () => {
    for (const fixture of fixtures) {
      expect(respondFromFixture(fixture).metadata.source).toBe("replay");
    }
  });

  it("passes the deterministic output guardrails", () => {
    for (const fixture of fixtures) {
      const result = respondFromFixture(fixture);
      expect(
        result.guardrails.outputChecks.every((check) => check.passed),
        `${fixture.id} failed an output guardrail`,
      ).toBe(true);
    }
  });

  it("reports evaluation as unavailable when a fixture has no judge result", () => {
    const withoutRubric = fixtures.filter((f) => !f.rubric);
    for (const fixture of withoutRubric) {
      expect(respondFromFixture(fixture).evaluation.available).toBe(false);
    }
  });

  it("flags the prompt-injection fixture as an attempted injection", () => {
    const fixture = fixtures.find((f) => f.category === "prompt-injection")!;
    const result = respondFromFixture(fixture);
    expect(result.guardrails.injection.detected).toBe(true);
    expect(result.guardrails.injection.risk).toBe("high");
  });
});
