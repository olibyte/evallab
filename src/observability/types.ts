export type SpanName =
  | "input-guardrails"
  | "generate-response"
  | "output-guardrails"
  | "live-evaluation";

export interface TraceSpan {
  end(output?: Record<string, unknown>): void;
  fail(error: unknown): void;
}

export interface Trace {
  readonly id?: string;
  span(name: SpanName, input?: Record<string, unknown>): TraceSpan;
  update(metadata: Record<string, unknown>): void;
  end(output?: Record<string, unknown>): void;
}

export interface Observability {
  readonly enabled: boolean;
  trace(name: string, input?: Record<string, unknown>): Trace;
  flush(): Promise<void>;
}
