import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const pricingSchema = z.record(
  z.string(),
  z.object({
    inputUsdPerMillionTokens: z.number().nonnegative(),
    outputUsdPerMillionTokens: z.number().nonnegative(),
  }),
);

export type Pricing = z.infer<typeof pricingSchema>;

const PRICING_PATH = path.join(process.cwd(), "evals", "pricing.json");

let cached: { value: Pricing | undefined } | undefined;

/**
 * Optional, operator-supplied model pricing. Absent by default: cost is
 * reported as unavailable rather than estimated from invented prices.
 */
export function loadPricing(): Pricing | undefined {
  if (cached) return cached.value;
  cached = { value: readPricing() };
  return cached.value;
}

export function resetPricingCache(): void {
  cached = undefined;
}

function readPricing(): Pricing | undefined {
  if (!existsSync(PRICING_PATH)) return undefined;
  const parsed = pricingSchema.safeParse(
    JSON.parse(readFileSync(PRICING_PATH, "utf8")),
  );
  if (!parsed.success) {
    console.warn("[evallab] evals/pricing.json is invalid; ignoring it.");
    return undefined;
  }
  return parsed.data;
}

/** The Batch API bills at half the standard rate. */
export const BATCH_DISCOUNT_MULTIPLIER = 0.5;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing = loadPricing(),
  discountMultiplier = 1,
): number | undefined {
  const entry = pricing?.[model];
  if (!entry) return undefined;
  return (
    ((inputTokens / 1_000_000) * entry.inputUsdPerMillionTokens +
      (outputTokens / 1_000_000) * entry.outputUsdPerMillionTokens) *
    discountMultiplier
  );
}
