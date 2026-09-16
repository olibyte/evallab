import { Langfuse } from "langfuse";
import type { Observability, Trace, TraceSpan } from "./types";

type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
};

/**
 * Langfuse-backed implementation. Every call is wrapped so that an
 * observability failure can never fail the user's request.
 */
export function createLangfuseObservability(
  config: LangfuseConfig,
): Observability {
  const client = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  const safe = (action: () => void) => {
    try {
      action();
    } catch (error) {
      console.error("[evallab] observability call failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  return {
    enabled: true,
    trace(name, input) {
      let handle: ReturnType<Langfuse["trace"]> | undefined;
      safe(() => {
        handle = client.trace({ name, input });
      });

      const trace: Trace = {
        id: handle?.id,
        span(spanName, spanInput) {
          let spanHandle: ReturnType<NonNullable<typeof handle>["span"]> | undefined;
          safe(() => {
            spanHandle = handle?.span({ name: spanName, input: spanInput });
          });
          const span: TraceSpan = {
            end(output) {
              safe(() => spanHandle?.end({ output }));
            },
            fail(error) {
              safe(() =>
                spanHandle?.end({
                  level: "ERROR",
                  statusMessage:
                    error instanceof Error ? error.message : "unknown error",
                }),
              );
            },
          };
          return span;
        },
        update(metadata) {
          safe(() => handle?.update({ metadata }));
        },
        end(output) {
          safe(() => handle?.update({ output }));
        },
      };
      return trace;
    },
    async flush() {
      try {
        await client.flushAsync();
      } catch {
        // Never surface observability failures to the caller.
      }
    },
  };
}
