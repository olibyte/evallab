import type {
  ModelCallOptions,
  ModelClient,
  ModelRole,
} from "../../src/ai/client/anthropic";

export type Recorded = ModelCallOptions & { role: ModelRole };

/** A scripted reply: plain text, or text with the stop reason the API gave. */
export type ScriptedReply = string | { text: string; stopReason?: string };

/** A scripted model client so pipeline tests never make a network call. */
export function fakeModelClient(
  role: ModelRole,
  responses: ScriptedReply[],
  recorder?: Recorded[],
): ModelClient {
  const queue = [...responses];
  return {
    role,
    model: `fake-${role}-model`,
    async complete(options) {
      recorder?.push({ ...options, role });
      const reply = queue.shift();
      if (reply === undefined) {
        throw new Error(`fake ${role} client ran out of scripted responses`);
      }
      const { text, stopReason } =
        typeof reply === "string" ? { text: reply, stopReason: undefined } : reply;
      return {
        text,
        model: `fake-${role}-model`,
        inputTokens: 100,
        outputTokens: 50,
        stopReason,
      };
    },
  };
}
