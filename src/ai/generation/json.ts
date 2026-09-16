/**
 * Extracts the first JSON object from model text, tolerating code fences and
 * surrounding prose. Returns undefined when nothing parses; callers treat
 * that as a malformed generation rather than guessing at intent.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(
    (value): value is string => typeof value === "string",
  );

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return undefined;
}
