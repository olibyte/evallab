export type ModelErrorKind =
  | "missing-credentials"
  | "api-error"
  | "timeout"
  | "malformed-output";

/** Operational error for any model-call failure. Never carries secrets. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;

  constructor(kind: ModelErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelError";
    this.kind = kind;
  }
}
