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

/**
 * Optional, operator-supplied model pricing. Absent by default: cost is
 * reported as unavailable rather than estimated from invented prices.
 */
export function loadPricing(): Pricing | undefined {
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

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing = loadPricing(),
): number | undefined {
  const entry = pricing?.[model];
  if (!entry) return undefined;
  return (
    (inputTokens / 1_000_000) * entry.inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * entry.outputUsdPerMillionTokens
  );
}
