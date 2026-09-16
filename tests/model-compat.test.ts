import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../src/config/env";
import {
  samplingParamsFor,
  supportsSamplingParams,
} from "../src/ai/client/model-capabilities";

/**
 * Claude 5 rejects the sampling parameters outright:
 * `400 invalid_request_error: temperature is deprecated for this model`.
 * These tests assert on the request payloads that reach the SDK, so a
 * reintroduced `temperature`, `top_p`, `top_k` or `thinking` field fails
 * here rather than on the first paid call.
 */

const messageCreate = vi.fn();
const batchCreate = vi.fn();

class FakeAPIError extends Error {
  status = 400;
}

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: messageCreate,
      batches: { create: batchCreate, retrieve: vi.fn(), results: vi.fn() },
    };
    constructor(_options: unknown) {}
    static APIError = FakeAPIError;
    static APIConnectionTimeoutError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

const reply = {
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 2 },
};

/** Parameters no Claude 5 request may carry. */
const FORBIDDEN = ["temperature", "top_p", "top_k", "thinking"] as const;

async function completeWith(model: string, temperature?: number) {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = model;
  resetEnvCache();
  const { createModelClient } = await import("../src/ai/client/anthropic");
  messageCreate.mockResolvedValue(reply);
  await createModelClient("generation").complete({
    system: "s",
    userContent: "u",
    temperature,
  });
  return messageCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
}

async function submitWith(model: string, temperature?: number) {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = model;
  resetEnvCache();
  const { createBatchModelClient } = await import("../src/ai/client/batch");
  batchCreate.mockResolvedValue({ id: "batch_1" });
  await createBatchModelClient("generation").submit([
    { customId: "c1", system: "s", userContent: "u", temperature },
  ]);
  const body = batchCreate.mock.calls.at(-1)![0] as {
    requests: { params: Record<string, unknown> }[];
  };
  return body.requests[0]!.params;
}

describe("Claude 5 request compatibility", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    messageCreate.mockReset();
    batchCreate.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvCache();
    vi.resetModules();
  });

  for (const model of ["claude-sonnet-5", "claude-opus-5"]) {
    it(`omits deprecated sampling parameters for ${model}`, async () => {
      const params = await completeWith(model, 0);
      for (const field of FORBIDDEN) {
        expect(params).not.toHaveProperty(field);
      }
      expect(params.model).toBe(model);
      expect(params.max_tokens).toBeTypeOf("number");
    });

    it(`omits them from ${model} Batch API payloads`, async () => {
      const params = await submitWith(model, 0);
      for (const field of FORBIDDEN) {
        expect(params).not.toHaveProperty(field);
      }
      expect(params.model).toBe(model);
    });
  }

  it("omits temperature even when a caller asks for a non-zero value", async () => {
    // `prompt:optimize` and `eval:generate` both ask for temperature 1.
    const params = await completeWith("claude-opus-5", 1);
    expect(params).not.toHaveProperty("temperature");
  });

  it("sends nothing when no caller expressed a preference", async () => {
    const params = await completeWith("claude-sonnet-4-6");
    expect(params).not.toHaveProperty("temperature");
  });

  it("still honours temperature on a model that accepts it", async () => {
    const params = await completeWith("claude-sonnet-4-6", 0);
    expect(params.temperature).toBe(0);
    expect(await submitWith("claude-sonnet-4-6", 0)).toHaveProperty(
      "temperature",
      0,
    );
  });
});

describe("response parsing with adaptive thinking", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => messageCreate.mockReset());

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvCache();
    vi.resetModules();
  });

  it("selects text by block type when thinking precedes it", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
    resetEnvCache();
    const { createModelClient } = await import("../src/ai/client/anthropic");
    messageCreate.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "deliberating" },
        { type: "text", text: '{"response":"hi"}' },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    const result = await createModelClient("generation").complete({
      system: "s",
      userContent: "u",
    });
    expect(result.text).toBe('{"response":"hi"}');
  });

  it("selects text by block type in batch results", async () => {
    const { toItemResult } = await import("../src/ai/client/batch");
    const item = toItemResult({
      custom_id: "c1",
      result: {
        type: "succeeded",
        message: {
          content: [
            { type: "thinking", thinking: "deliberating" },
            { type: "text", text: '{"response":"hi"}' },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        } as any,
      },
    });
    expect(item.text).toBe('{"response":"hi"}');
  });
});

describe("supportsSamplingParams", () => {
  it("rejects the Claude 5 family and Opus 4.7/4.8", () => {
    for (const model of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-fable-5-1",
    ]) {
      expect(supportsSamplingParams(model)).toBe(false);
    }
  });

  it("accepts models that still take sampling parameters", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]) {
      expect(supportsSamplingParams(model)).toBe(true);
    }
  });

  it("treats an unrecognised identifier as unsupported", () => {
    // Omitting the field is accepted everywhere; sending it is not.
    expect(supportsSamplingParams("some-future-model")).toBe(false);
    expect(samplingParamsFor("some-future-model", { temperature: 0 })).toEqual(
      {},
    );
  });
});
