/**
 * Per-model API capabilities.
 *
 * Claude 5 (and Opus 4.7/4.8) removed the sampling parameters: sending
 * `temperature`, `top_p` or `top_k` to `claude-sonnet-5` or `claude-opus-5`
 * is rejected with `400 invalid_request_error: temperature is deprecated for
 * this model`. The same generation replaced manual thinking configuration
 * (`thinking: { type: "enabled", budget_tokens: N }`) with adaptive thinking,
 * which is on by default and needs no request field at all.
 *
 * Model identifiers are environment-overridable, so this cannot be a switch
 * over the two defaults in `src/config/env.ts`.
 */

/**
 * Models that still accept sampling parameters. This is an allow-list rather
 * than a deny-list of Claude 5 models on purpose: omitting `temperature`
 * leaves the server default in place and is accepted by every model, while
 * sending it to a model that has removed it fails the whole request. An
 * unrecognised identifier therefore has to be treated as a model that does
 * not take it.
 */
const SAMPLING_SUPPORTED = [
  /^claude-opus-4-[0-6](\b|-)/,
  /^claude-sonnet-4-[0-6](\b|-)/,
  /^claude-haiku-4(\b|-)/,
  /^claude-3(\b|-)/,
];

/**
 * True when `model` accepts `temperature` / `top_p` / `top_k`.
 *
 * False for the Claude 5 family, for Opus 4.7 and 4.8, and for any
 * identifier this does not recognise.
 */
export function supportsSamplingParams(model: string): boolean {
  const id = model.trim().toLowerCase();
  return SAMPLING_SUPPORTED.some((pattern) => pattern.test(id));
}

/**
 * The sampling fields to spread into a request payload. Empty for a model
 * that has removed them, and empty when the caller expressed no preference:
 * a default sent explicitly is indistinguishable, to the API, from one the
 * caller chose, and only the explicit form can fail.
 */
export function samplingParamsFor(
  model: string,
  options: { temperature?: number } = {},
): { temperature?: number } {
  if (options.temperature === undefined) return {};
  if (!supportsSamplingParams(model)) return {};
  return { temperature: options.temperature };
}
