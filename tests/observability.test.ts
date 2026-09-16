import { afterEach, describe, expect, it } from "vitest";
import { getObservability, resetObservabilityCache } from "../src/observability";
import { resetEnvCache } from "../src/config/env";

afterEach(() => {
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  resetEnvCache();
  resetObservabilityCache();
});

describe("observability", () => {
  it("falls back to a no-op implementation when Langfuse is unconfigured", () => {
    resetEnvCache();
    resetObservabilityCache();
    const observability = getObservability();
    expect(observability.enabled).toBe(false);

    const trace = observability.trace("support-request");
    expect(trace.id).toBeUndefined();
    expect(() => {
      const span = trace.span("input-guardrails");
      span.end({ ok: true });
      span.fail(new Error("boom"));
      trace.update({ latencyMs: 1 });
      trace.end();
    }).not.toThrow();
  });

  it("enables tracing only when both keys are present", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    resetEnvCache();
    resetObservabilityCache();
    expect(getObservability().enabled).toBe(false);

    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    resetEnvCache();
    resetObservabilityCache();
    expect(getObservability().enabled).toBe(true);
  });
});
