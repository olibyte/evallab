import { getEnv } from "@/src/config/env";
import { createLangfuseObservability } from "./langfuse";
import { noopObservability } from "./noop";
import type { Observability } from "./types";

export type { Observability, Trace, TraceSpan, SpanName } from "./types";

let cached: Observability | undefined;

/**
 * The single place the application decides how traces are recorded. Business
 * logic depends on the `Observability` interface, never on Langfuse.
 */
export function getObservability(): Observability {
  if (cached) return cached;

  const env = getEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    cached = noopObservability;
    return cached;
  }

  try {
    cached = createLangfuseObservability({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
    });
  } catch (error) {
    console.error("[evallab] Langfuse initialisation failed; tracing disabled", {
      name: error instanceof Error ? error.name : "unknown",
    });
    cached = noopObservability;
  }
  return cached;
}

export function resetObservabilityCache(): void {
  cached = undefined;
}
