import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/src/config/env";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ModelRole,
} from "./anthropic";
import { ModelError } from "./errors";
import { samplingParamsFor } from "./model-capabilities";

/** Anthropic caps a single batch at 100,000 requests. */
export const MAX_BATCH_REQUESTS = 100_000;

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type BatchRequest = {
  /** Stable key used to match a result back to its eval case. */
  customId: string;
  system: string;
  userContent: string;
  maxOutputTokens?: number;
  /** Dropped for models that have removed sampling parameters. */
  temperature?: number;
};

export type BatchItemResult = {
  customId: string;
  text?: string;
  /** Set when this single request failed; the rest of the batch still counts. */
  error?: string;
  inputTokens: number;
  outputTokens: number;
};

export interface BatchModelClient {
  readonly role: ModelRole;
  readonly model: string;
  /** Submits a batch and returns its id. */
  submit(requests: BatchRequest[]): Promise<string>;
  /** Polls until the batch ends, then returns one result per request. */
  collect(batchId: string, options?: PollOptions): Promise<BatchItemResult[]>;
}

export type PollOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPoll?: (status: string, counts: Record<string, number>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function resolveModel(role: ModelRole): { model: string; apiKey: string } {
  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY) {
    throw new ModelError(
      "missing-credentials",
      "ANTHROPIC_API_KEY is not configured.",
    );
  }
  const model =
    role === "generation" ? env.ANTHROPIC_MODEL : env.ANTHROPIC_JUDGE_MODEL;
  if (!model) {
    throw new ModelError(
      "missing-credentials",
      `No model configured for the ${role} role.`,
    );
  }
  return { model, apiKey: env.ANTHROPIC_API_KEY };
}

/**
 * Message Batches client for large offline eval runs. Batches bill at half
 * the standard rate but are not real-time, so this is never used on the
 * request path — only by `eval:run`, `eval:generate` and `prompt:optimize`.
 */
export function createBatchModelClient(role: ModelRole): BatchModelClient {
  const { model, apiKey } = resolveModel(role);
  const client = new Anthropic({ apiKey });

  return {
    role,
    model,

    async submit(requests) {
      if (requests.length === 0) {
        throw new ModelError("api-error", "Cannot submit an empty batch.");
      }
      if (requests.length > MAX_BATCH_REQUESTS) {
        throw new ModelError(
          "api-error",
          `Batch of ${requests.length} exceeds the ${MAX_BATCH_REQUESTS} request limit; split it into chunks.`,
        );
      }

      try {
        const batch = await client.messages.batches.create({
          requests: requests.map((request) => ({
            custom_id: request.customId,
            params: {
              model,
              max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              ...samplingParamsFor(model, { temperature: request.temperature }),
              system: request.system,
              messages: [{ role: "user", content: request.userContent }],
            },
          })),
        });
        return batch.id;
      } catch (error) {
        throw new ModelError(
          "api-error",
          `Batch submission to "${model}" failed (${describe(error)})`,
          { cause: error },
        );
      }
    },

    async collect(batchId, options = {}) {
      const sleep = options.sleep ?? wait;
      const now = options.now ?? (() => Date.now());
      const deadline = now() + (options.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS);
      const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

      for (;;) {
        let batch;
        try {
          batch = await client.messages.batches.retrieve(batchId);
        } catch (error) {
          throw new ModelError(
            "api-error",
            `Could not retrieve batch ${batchId} (${describe(error)})`,
            { cause: error },
          );
        }

        options.onPoll?.(batch.processing_status, {
          succeeded: batch.request_counts.succeeded,
          errored: batch.request_counts.errored,
          processing: batch.request_counts.processing,
          canceled: batch.request_counts.canceled,
          expired: batch.request_counts.expired,
        });

        if (batch.processing_status === "ended") break;

        if (now() >= deadline) {
          throw new ModelError(
            "timeout",
            `Batch ${batchId} did not finish within the timeout. It is still running on the Anthropic side; collect it later with the --resume flag of the command that submitted it.`,
          );
        }
        await sleep(interval);
      }

      const results: BatchItemResult[] = [];
      try {
        for await (const entry of await client.messages.batches.results(batchId)) {
          results.push(toItemResult(entry));
        }
      } catch (error) {
        throw new ModelError(
          "api-error",
          `Could not read results for batch ${batchId} (${describe(error)})`,
          { cause: error },
        );
      }
      return results;
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    return `${error.status ?? "no status"}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

type BatchEntry = {
  custom_id: string;
  result:
    | { type: "succeeded"; message: Anthropic.Messages.Message }
    | { type: "errored"; error: unknown }
    | { type: "canceled" }
    | { type: "expired" };
};

/** Normalises one batch entry; a per-request failure is data, not a throw. */
export function toItemResult(entry: BatchEntry): BatchItemResult {
  if (entry.result.type !== "succeeded") {
    return {
      customId: entry.custom_id,
      error: `Batch request ${entry.result.type}.`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const message = entry.result.message;
  return {
    customId: entry.custom_id,
    text: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
