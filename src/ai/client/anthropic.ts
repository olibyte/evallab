import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/src/config/env";
import { ModelError } from "./errors";
import { samplingParamsFor } from "./model-capabilities";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * The sampling setting eval runs ask for, so a rerun of the same cases is as
 * reproducible as the model allows. It reaches the API only on models that
 * still accept `temperature`; Claude 5 removed the parameter and samples at
 * its own default, which is why a run record states what was actually sent.
 */
export const DETERMINISTIC_TEMPERATURE = 0;

export type ModelRole = "generation" | "judge";

export type ModelCallOptions = {
  system: string;
  userContent: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /**
   * Only reaches the API on a model that still accepts sampling parameters;
   * see `samplingParamsFor`. Left unset, nothing is sent and the server
   * default applies.
   */
  temperature?: number;
};

export type ModelCallResult = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export interface ModelClient {
  readonly role: ModelRole;
  readonly model: string;
  complete(options: ModelCallOptions): Promise<ModelCallResult>;
}

function resolveModel(role: ModelRole): string {
  const env = getEnv();
  const model =
    role === "generation" ? env.ANTHROPIC_MODEL : env.ANTHROPIC_JUDGE_MODEL;

  if (!env.ANTHROPIC_API_KEY) {
    throw new ModelError(
      "missing-credentials",
      "ANTHROPIC_API_KEY is not configured.",
    );
  }
  if (!model) {
    throw new ModelError(
      "missing-credentials",
      role === "generation"
        ? "ANTHROPIC_MODEL is not configured."
        : "ANTHROPIC_JUDGE_MODEL is not configured.",
    );
  }
  return model;
}

/**
 * Generation and judge clients are constructed separately so the two model
 * configurations stay independent even when they resolve to the same model.
 */
export function createModelClient(role: ModelRole): ModelClient {
  const model = resolveModel(role);
  const client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });

  return {
    role,
    model,
    async complete(options) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        const message = await client.messages.create(
          {
            model,
            max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            ...samplingParamsFor(model, { temperature: options.temperature }),
            system: options.system,
            messages: [{ role: "user", content: options.userContent }],
          },
          { timeout: timeoutMs },
        );

        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");

        return {
          text,
          model,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        };
      } catch (error) {
        if (error instanceof Anthropic.APIConnectionTimeoutError) {
          throw new ModelError(
            "timeout",
            `Model call timed out after ${timeoutMs}ms.`,
            { cause: error },
          );
        }
        // Surface the provider's own status and message: a bare "Model call
        // failed" leaves an operator with nothing to act on.
        const detail =
          error instanceof Anthropic.APIError
            ? `${error.status ?? "no status"}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
        throw new ModelError(
          "api-error",
          `Model call to "${model}" failed (${detail})`,
          { cause: error },
        );
      }
    },
  };
}
