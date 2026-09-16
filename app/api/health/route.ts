import { NextResponse } from "next/server";
import {
  getEnv,
  getRuntimeMode,
  hasLiveJudgeCredentials,
  isPublicLiveInferenceEnabled,
} from "@/src/config/env";

export const dynamic = "force-dynamic";

/**
 * Service state without any model call.
 */
export function GET() {
  const env = getEnv();

  return NextResponse.json({
    status: "ok",
    mode: getRuntimeMode(env),
    capabilities: {
      liveGeneration: getRuntimeMode(env) === "live",
      liveJudge: hasLiveJudgeCredentials(env),
      publicLiveInference: isPublicLiveInferenceEnabled(env),
      observability: Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY),
    },
    timestamp: new Date().toISOString(),
  });
}
