import { afterEach, describe, expect, it } from "vitest";
import { InMemoryRateLimiter, clientIdentifier } from "../src/usage/rate-limit";
import { InMemoryUsageStore, utcDateKey } from "../src/usage/usage-store";
import { resetEnvCache } from "../src/config/env";

afterEach(() => {
  delete process.env.RATE_LIMIT_SALT;
  resetEnvCache();
});

describe("clientIdentifier", () => {
  it("never returns the raw address", () => {
    process.env.RATE_LIMIT_SALT = "salt";
    resetEnvCache();
    const { id, stable } = clientIdentifier("203.0.113.9");
    expect(id).not.toContain("203.0.113.9");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(stable).toBe(true);
  });

  it("is deterministic for the same address and salt", () => {
    process.env.RATE_LIMIT_SALT = "salt";
    resetEnvCache();
    expect(clientIdentifier("203.0.113.9").id).toBe(
      clientIdentifier("203.0.113.9").id,
    );
  });

  it("reports an unstable identifier when no salt or address is available", () => {
    resetEnvCache();
    expect(clientIdentifier("203.0.113.9").stable).toBe(false);
    process.env.RATE_LIMIT_SALT = "salt";
    resetEnvCache();
    expect(clientIdentifier(null).stable).toBe(false);
  });
});

describe("InMemoryRateLimiter", () => {
  it("allows up to the limit then blocks", () => {
    const limiter = new InMemoryRateLimiter(3);
    const now = 1_000_000;
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("a", now).allowed).toBe(true);
    const blocked = limiter.check("a", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks clients independently", () => {
    const limiter = new InMemoryRateLimiter(1);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("resets after the window expires", () => {
    const limiter = new InMemoryRateLimiter(1);
    const now = 1_000_000;
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("a", now + 60 * 60 * 1000 + 1).allowed).toBe(true);
  });
});

describe("InMemoryUsageStore", () => {
  it("counts usage per UTC day", async () => {
    const store = new InMemoryUsageStore();
    const today = utcDateKey(new Date("2026-09-16T23:59:00Z"));
    expect(today).toBe("2026-09-16");
    expect(await store.getDailyUsage(today)).toBe(0);
    await store.incrementDailyUsage(today);
    await store.incrementDailyUsage(today);
    expect(await store.getDailyUsage(today)).toBe(2);
    expect(await store.getDailyUsage("2026-09-17")).toBe(0);
  });
});
