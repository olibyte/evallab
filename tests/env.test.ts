import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATION_MODEL,
  DEFAULT_JUDGE_MODEL,
  getEnv,
  getRuntimeMode,
  hasLiveJudgeCredentials,
  isPublicLiveInferenceEnabled,
  resetEnvCache,
} from "../src/config/env";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_JUDGE_MODEL",
  "LIVE_DEMO_ENABLED",
] as const;

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  resetEnvCache();
}

afterEach(() => setEnv({}));

describe("runtime mode", () => {
  it("is replay-only with no credentials", () => {
    setEnv({});
    expect(getRuntimeMode()).toBe("replay-only");
  });

  it("is live on a key alone, because both models default", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(getRuntimeMode()).toBe("live");
    expect(getEnv().ANTHROPIC_MODEL).toBe(DEFAULT_GENERATION_MODEL);
    expect(getEnv().ANTHROPIC_JUDGE_MODEL).toBe(DEFAULT_JUDGE_MODEL);
  });

  it("is live when a key and generation model are configured", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-test" });
    expect(getRuntimeMode()).toBe("live");
  });
});

describe("judge configuration", () => {
  it("defaults to a more capable model than the generator", () => {
    setEnv({});
    expect(DEFAULT_JUDGE_MODEL).not.toBe(DEFAULT_GENERATION_MODEL);
  });

  it("is overridable independently of the generation model", () => {
    setEnv({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_JUDGE_MODEL: "claude-judge-override",
    });
    expect(getEnv().ANTHROPIC_MODEL).toBe(DEFAULT_GENERATION_MODEL);
    expect(getEnv().ANTHROPIC_JUDGE_MODEL).toBe("claude-judge-override");
    expect(hasLiveJudgeCredentials()).toBe(true);
  });

  it("needs a key, not just a model", () => {
    setEnv({ ANTHROPIC_JUDGE_MODEL: "claude-judge" });
    expect(hasLiveJudgeCredentials()).toBe(false);
  });
});

describe("public live inference", () => {
  it("defaults to disabled even with credentials", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-test" });
    expect(isPublicLiveInferenceEnabled()).toBe(false);
  });

  it("requires credentials even when deliberately enabled", () => {
    setEnv({ LIVE_DEMO_ENABLED: "true" });
    expect(isPublicLiveInferenceEnabled()).toBe(false);
  });

  it("is enabled when both are present", () => {
    setEnv({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_MODEL: "claude-test",
      LIVE_DEMO_ENABLED: "true",
    });
    expect(isPublicLiveInferenceEnabled()).toBe(true);
  });
});
