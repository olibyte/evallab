import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../src/config/env";

/**
 * The client's 30 s default is sized for one customer response. The
 * optimizer's proposal call writes several full system prompts and asks for
 * a 300 s ceiling of its own; nothing else may inherit it. These tests read
 * the request options that reach the SDK.
 */

const messageCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: messageCreate };
    constructor(_options: unknown) {}
    static APIError = class extends Error {
      status = 400;
    };
    static APIConnectionTimeoutError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

const reply = {
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 2 },
  stop_reason: "end_turn",
};

describe("model call timeouts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    messageCreate.mockReset();
    messageCreate.mockResolvedValue(reply);
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
    resetEnvCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvCache();
  });

  async function requestOptions(timeoutMs?: number) {
    const { createModelClient } = await import("../src/ai/client/anthropic");
    await createModelClient("generation").complete({ system: "s", userContent: "u", timeoutMs });
    return messageCreate.mock.calls.at(-1)![1] as { timeout: number };
  }

  it("keeps the 30 s default for an ordinary call", async () => {
    const { DEFAULT_TIMEOUT_MS } = await import("../src/ai/client/anthropic");
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect((await requestOptions()).timeout).toBe(30_000);
  });

  it("passes an explicit timeout through to the SDK", async () => {
    expect((await requestOptions(300_000)).timeout).toBe(300_000);
  });

  it("forwards the model's stop reason so callers can detect truncation", async () => {
    messageCreate.mockResolvedValue({ ...reply, stop_reason: "max_tokens" });
    const { createModelClient } = await import("../src/ai/client/anthropic");
    const result = await createModelClient("generation").complete({ system: "s", userContent: "u" });
    expect(result.stopReason).toBe("max_tokens");
  });
});
