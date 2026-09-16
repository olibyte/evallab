import { getEnv } from "@/src/config/env";
import { estimateCostUsd, loadPricing } from "./pricing";

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

export type PricingSnapshot = Record<
  string,
  {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    discountMultiplier: number;
  }
>;

/**
 * Tracks actual token usage, and actual spend where pricing is configured.
 *
 * Cost is only reported when every model that was used has a price: a
 * partial total presented as the total would understate spend. A tracker
 * can forward to a parent so a multi-run workflow shares one budget while
 * each run still records its own usage.
 */
export class UsageTracker {
  inputTokens = 0;
  outputTokens = 0;
  private spendUsd = 0;
  private readonly priced = new Set<string>();
  private readonly unpriced = new Set<string>();
  private readonly snapshot: PricingSnapshot = {};

  constructor(
    private readonly maxSpendUsd?: number,
    private readonly parent?: UsageTracker,
  ) {}

  /** `discountMultiplier` is decided where the call is made (batch = 0.5). */
  record(
    model: string,
    inputTokens: number,
    outputTokens: number,
    discountMultiplier = 1,
  ): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    const cost = estimateCostUsd(
      model,
      inputTokens,
      outputTokens,
      undefined,
      discountMultiplier,
    );
    if (cost === undefined) {
      this.unpriced.add(model);
    } else {
      this.priced.add(model);
      this.spendUsd += cost;
      const entry = loadPricing()?.[model];
      if (entry) this.snapshot[model] = { ...entry, discountMultiplier };
    }
    this.parent?.record(model, inputTokens, outputTokens, discountMultiplier);
  }

  /** Throws once tracked spend passes the configured limit, here or above. */
  assertWithinBudget(): void {
    if (
      this.maxSpendUsd !== undefined &&
      this.priced.size > 0 &&
      this.spendUsd >= this.maxSpendUsd
    ) {
      throw new SpendLimitExceededError(this.maxSpendUsd, this.spendUsd);
    }
    this.parent?.assertWithinBudget();
  }

  get unpricedModels(): string[] {
    return [...this.unpriced].sort();
  }

  /** Undefined until something priced was used, and whenever anything was not. */
  get estimatedCostUsd(): number | undefined {
    return this.priced.size > 0 && this.unpriced.size === 0
      ? this.spendUsd
      : undefined;
  }

  /** Spend known so far, even when incomplete; for budget messages only. */
  get trackedSpendUsd(): number {
    return this.spendUsd;
  }

  get pricingSnapshot(): PricingSnapshot | undefined {
    return Object.keys(this.snapshot).length > 0 ? { ...this.snapshot } : undefined;
  }
}
