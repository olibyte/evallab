import { getEnv } from "@/src/config/env";
import { estimateCostUsd } from "./pricing";

export class PaidEvalsDisabledError extends Error {
  constructor(operation: string) {
    super(
      `${operation} makes paid Anthropic calls and is disabled. Set ALLOW_PAID_EVALS=true to enable it.`,
    );
    this.name = "PaidEvalsDisabledError";
  }
}

export class SpendLimitExceededError extends Error {
  constructor(limitUsd: number, spentUsd: number) {
    super(
      `Spend limit reached: EVAL_MAX_SPEND_USD=${limitUsd}, tracked spend $${spentUsd.toFixed(4)}.`,
    );
    this.name = "SpendLimitExceededError";
  }
}

/**
 * Paid batch operations refuse to start unless deliberately enabled.
 */
export function assertPaidEvalsAllowed(operation: string): void {
  if (!getEnv().ALLOW_PAID_EVALS) throw new PaidEvalsDisabledError(operation);
}

/** Applies EVAL_MAX_CASES on top of any caller-supplied limit. */
export function resolveCaseLimit(requested?: number): number | undefined {
  const configured = getEnv().EVAL_MAX_CASES;
  const limits = [requested, configured].filter(
    (value): value is number => typeof value === "number",
  );
  return limits.length === 0 ? undefined : Math.min(...limits);
}

/**
 * Tracks actual token usage during a run, and actual spend where pricing is
 * configured. Without pricing, cost is reported as unavailable and the run is
 * bounded by case and token limits instead of an invented estimate.
 */
export class UsageTracker {
  inputTokens = 0;
  outputTokens = 0;
  private spendUsd = 0;
  private pricingAvailable = false;

  constructor(private readonly maxSpendUsd?: number) {}

  record(model: string, inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    const cost = estimateCostUsd(model, inputTokens, outputTokens);
    if (cost !== undefined) {
      this.pricingAvailable = true;
      this.spendUsd += cost;
    }
  }

  /** Throws once tracked spend passes the configured limit. */
  assertWithinBudget(): void {
    if (
      this.maxSpendUsd !== undefined &&
      this.pricingAvailable &&
      this.spendUsd >= this.maxSpendUsd
    ) {
      throw new SpendLimitExceededError(this.maxSpendUsd, this.spendUsd);
    }
  }

  get estimatedCostUsd(): number | undefined {
    return this.pricingAvailable ? this.spendUsd : undefined;
  }
}
