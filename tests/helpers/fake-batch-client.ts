import type {
  BatchItemResult,
  BatchModelClient,
  BatchRequest,
  PollOptions,
} from "../../src/ai/client/batch";
import type { ModelRole } from "../../src/ai/client/anthropic";

export type SubmittedBatch = { batchId: string; requests: BatchRequest[] };

/**
 * Scripted Batch API client. `respond` maps one request to its raw model
 * text, or to an error for a per-request failure.
 */
export function fakeBatchClient(
  role: ModelRole,
  respond: (
    request: BatchRequest,
    attempt: number,
  ) => { text?: string; error?: string; stopReason?: string },
  submitted: SubmittedBatch[] = [],
): BatchModelClient & { submitted: SubmittedBatch[] } {
  const pending = new Map<string, BatchRequest[]>();
  let counter = 0;
  const attempts = new Map<string, number>();

  return {
    role,
    model: `fake-${role}-model`,
    submitted,

    async submit(requests) {
      counter += 1;
      const batchId = `batch_${role}_${counter}`;
      pending.set(batchId, requests);
      submitted.push({ batchId, requests });
      return batchId;
    },

    async collect(batchId, options: PollOptions = {}) {
      const requests = pending.get(batchId) ?? [];
      options.onPoll?.("ended", { succeeded: requests.length, errored: 0 });

      return requests.map((request): BatchItemResult => {
        const attempt = (attempts.get(request.customId) ?? 0) + 1;
        attempts.set(request.customId, attempt);
        const outcome = respond(request, attempt);
        return {
          customId: request.customId,
          text: outcome.text,
          error: outcome.error,
          stopReason: outcome.stopReason,
          inputTokens: outcome.text ? 120 : 0,
          outputTokens: outcome.text ? 60 : 0,
        };
      });
    },
  };
}
