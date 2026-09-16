import { createHash } from "node:crypto";
import { getEnv } from "@/src/config/env";

/**
 * Irreversible salted client identifier. Raw IP addresses are never stored.
 * Without a configured salt the identifier is not stable across restarts,
 * which is reported so callers can fail safe.
 */
export function clientIdentifier(rawIp: string | null): {
  id: string;
  stable: boolean;
} {
  const salt = getEnv().RATE_LIMIT_SALT;
  const value = rawIp ?? "unknown";
  return {
    id: createHash("sha256").update(`${salt ?? ""}:${value}`).digest("hex"),
    stable: Boolean(salt) && rawIp !== null,
  };
}

type Window = { count: number; resetAt: number };

const HOUR_MS = 60 * 60 * 1000;

/** Process-local sliding hourly window per client identifier. */
export class InMemoryRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly limitPerHour: number) {}

  check(id: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const existing = this.windows.get(id);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(id, { count: 1, resetAt: now + HOUR_MS });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (existing.count >= this.limitPerHour) {
      return { allowed: false, retryAfterMs: existing.resetAt - now };
    }
    existing.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}
