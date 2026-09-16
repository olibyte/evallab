import { NextResponse } from "next/server";
import { ModelError } from "@/src/ai/client/errors";
import { handleSupportRequest } from "@/src/ai/pipeline/handle-support-request";
import { getEnv, isPublicLiveInferenceEnabled } from "@/src/config/env";
import { redactSensitiveText } from "@/src/ai/guardrails/redact";
import { respondRequestSchema } from "@/src/schemas/support";
import {
  InMemoryRateLimiter,
  clientIdentifier,
} from "@/src/usage/rate-limit";
import {
  InMemoryUsageStore,
  utcDateKey,
  type UsageStore,
} from "@/src/usage/usage-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const env = getEnv();
const rateLimiter = new InMemoryRateLimiter(env.LIVE_DEMO_REQUESTS_PER_HOUR);
const usageStore: UsageStore = new InMemoryUsageStore();

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
}

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = respondRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(
      400,
      "invalid_request",
      "Provide a non-empty message of at most 2000 characters.",
    );
  }

  if (!isPublicLiveInferenceEnabled(env)) {
    return error(
      503,
      "live_inference_unavailable",
      "Live inference is disabled. Browse the stored replay examples instead.",
    );
  }

  const client = clientIdentifier(clientIp(request));
  const limit = rateLimiter.check(client.id);
  if (!limit.allowed) {
    return error(
      429,
      "rate_limited",
      "Hourly request limit reached. Try again later or use a replay example.",
    );
  }

  // The in-memory store cannot guarantee a global cap across instances, so
  // fail safe rather than claim a limit that is not enforced.
  const today = utcDateKey();
  const used = await usageStore.getDailyUsage(today);
  if (used >= env.LIVE_DEMO_GLOBAL_DAILY_LIMIT) {
    return error(
      429,
      "daily_limit_reached",
      "The daily live-inference budget for this demo is exhausted.",
    );
  }
  await usageStore.incrementDailyUsage(today);

  try {
    const result = await handleSupportRequest({ message: parsed.data.message });
    return NextResponse.json(result);
  } catch (caught) {
    const kind = caught instanceof ModelError ? caught.kind : "unknown";
    console.error("[evallab] respond failed", {
      kind,
      message: redactSensitiveText(parsed.data.message),
    });

    if (kind === "missing-credentials") {
      return error(
        503,
        "live_inference_unavailable",
        "Live inference is not configured.",
      );
    }
    if (kind === "timeout") {
      return error(504, "model_timeout", "The model did not respond in time.");
    }
    return error(
      502,
      "generation_failed",
      "The assistant could not produce a valid response. Please try again.",
    );
  }
}
