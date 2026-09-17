/** The stop reason the API reports when a reply hit its `max_tokens` ceiling. */
export const TRUNCATED_STOP_REASON = "max_tokens";

/**
 * True when the model stopped because it ran out of output budget. On the
 * Claude 5 models adaptive thinking shares that budget, so a reply can be
 * cut off with almost no visible text. Every consumer treats this as a hard
 * failure of the call: nothing that survived the cut is parsed.
 */
export function isTruncated(stopReason: string | undefined): boolean {
  return stopReason === TRUNCATED_STOP_REASON;
}
