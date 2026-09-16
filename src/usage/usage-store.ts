export interface UsageStore {
  getDailyUsage(date: string): Promise<number>;
  incrementDailyUsage(date: string): Promise<void>;
}

/**
 * Local/default implementation. Process-local, so it cannot enforce a global
 * limit across serverless instances — see `isGlobalLimitEnforceable`.
 */
export class InMemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, number>();

  async getDailyUsage(date: string): Promise<number> {
    return this.counts.get(date) ?? 0;
  }

  async incrementDailyUsage(date: string): Promise<void> {
    this.counts.set(date, (this.counts.get(date) ?? 0) + 1);
  }
}

export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
