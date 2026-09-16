const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?:\+\d[\d\s().-]{7,}\d)|\b\d{3}[\s.-]\d{3,4}[\s.-]\d{4}\b/g;

/**
 * Redacts common PII for logging hygiene only. The generation model still
 * receives the original input, and PII never causes a request to be rejected.
 */
export function redactSensitiveText(input: string): string {
  return input
    .replace(EMAIL, "[redacted-email]")
    .replace(CARD, (match) =>
      match.replace(/\D/g, "").length >= 13 ? "[redacted-card]" : match,
    )
    .replace(PHONE, "[redacted-phone]");
}
