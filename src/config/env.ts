import { z } from "zod";

/**
 * Environment validation.
 *
 * Nothing here is required: the application must start and stay useful in
 * Replay Mode with no credentials at all. Validation therefore normalises
 * values and derives the runtime mode rather than throwing on absence.
 */

const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined);

const booleanFlag = z
  .enum(["true", "false"])
  .optional()
  .catch(undefined)
  .transform((value) => value === "true");

const positiveInt = (fallback: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .catch(undefined)
    .transform((value) => value ?? fallback);

const optionalPositiveNumber = z.coerce
  .number()
  .positive()
  .optional()
  .catch(undefined);

/**
 * Model defaults live here and nowhere else, so no model identifier is
 * hard-coded across the codebase. Both are overridable by environment.
 *
 * The judge is deliberately a more capable model than the generator: a judge
 * scoring its own family is prone to self-preference bias.
 */
export const DEFAULT_GENERATION_MODEL = "claude-sonnet-5";
export const DEFAULT_JUDGE_MODEL = "claude-opus-5";

const modelId = (fallback: string) =>
  z
    .string()
    .trim()
    .min(1)
    .optional()
    .catch(undefined)
    .transform((value) => value ?? fallback);

const envSchema = z.object({
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: modelId(DEFAULT_GENERATION_MODEL),
  ANTHROPIC_JUDGE_MODEL: modelId(DEFAULT_JUDGE_MODEL),

  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  LANGFUSE_BASE_URL: optionalString,

  DATABASE_URL: optionalString,

  LIVE_DEMO_ENABLED: booleanFlag,
  LIVE_DEMO_REQUESTS_PER_HOUR: positiveInt(5),
  LIVE_DEMO_GLOBAL_DAILY_LIMIT: positiveInt(100),
  RATE_LIMIT_SALT: optionalString,

  ENABLE_LLM_INJECTION_CLASSIFIER: booleanFlag,

  ALLOW_PAID_EVALS: booleanFlag,
  EVAL_MAX_CASES: z.coerce.number().int().positive().optional().catch(undefined),
  EVAL_MAX_SPEND_USD: optionalPositiveNumber,
  EVAL_USE_BATCH_API: booleanFlag,

  ALLOW_DEPLOY: booleanFlag,
});

export type Env = z.infer<typeof envSchema>;

export type RuntimeMode = "live" | "replay-only";

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}

/** Test seam: clears the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Both model roles resolve to a default, so live mode turns on the moment a
 * key exists. The two remain independent at the configuration boundary.
 */
export function hasLiveGenerationCredentials(env: Env = getEnv()): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL);
}

export function hasLiveJudgeCredentials(env: Env = getEnv()): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_JUDGE_MODEL);
}

export function getRuntimeMode(env: Env = getEnv()): RuntimeMode {
  return hasLiveGenerationCredentials(env) ? "live" : "replay-only";
}

/**
 * Public live inference additionally requires the demo to be deliberately
 * enabled. Without it the public surface falls back to Replay Mode.
 */
export function isPublicLiveInferenceEnabled(env: Env = getEnv()): boolean {
  return env.LIVE_DEMO_ENABLED && hasLiveGenerationCredentials(env);
}
