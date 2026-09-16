import type { Observability, Trace, TraceSpan } from "./types";

const noopSpan: TraceSpan = { end() {}, fail() {} };

const noopTrace: Trace = {
  id: undefined,
  span: () => noopSpan,
  update() {},
  end() {},
};

/** Used whenever Langfuse is not configured. */
export const noopObservability: Observability = {
  enabled: false,
  trace: () => noopTrace,
  async flush() {},
};
