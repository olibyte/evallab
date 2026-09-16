import type {
  ModelCallOptions,
  ModelClient,
  ModelRole,
} from "../../src/ai/client/anthropic";

export type Recorded = ModelCallOptions & { role: ModelRole };

/** A scripted model client so pipeline tests never make a network call. */
export function fakeModelClient(
  role: ModelRole,
  responses: string[],
  recorder?: Recorded[],
): ModelClient {
  const queue = [...responses];
  return {
    role,
    model: `fake-${role}-model`,
    async complete(options) {
      recorder?.push({ ...options, role });
      const text = queue.shift();
      if (text === undefined) {
        throw new Error(`fake ${role} client ran out of scripted responses`);
      }
      return {
        text,
        model: `fake-${role}-model`,
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };
}
