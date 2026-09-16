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

export type ArraySalvage = {
  /** Complete elements recovered from the array, in order. */
  items: unknown[];
  /** True when the array never closed, i.e. the reply stopped mid-value. */
  truncated: boolean;
  /** True when the named array was not found at all. */
  missing: boolean;
};

/**
 * Recovers the complete elements of a named JSON array from text that may
 * have been cut off mid-value, as a reply stopped by `max_tokens` is.
 *
 * This exists because a single unterminated element otherwise destroys every
 * complete element beside it: `extractJsonObject` parses all-or-nothing. It
 * is deliberately *not* used on the support-response path, where a partial
 * object is a partial answer and must stay a hard failure. It is correct only
 * where the array holds independent items, each validated on its own
 * afterwards — salvaging recovers text, it never bypasses schema validation.
 */
export function salvageJsonArrayItems(text: string, key: string): ArraySalvage {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex === -1) return { items: [], truncated: false, missing: true };
  const open = text.indexOf("[", keyIndex);
  if (open === -1) return { items: [], truncated: false, missing: true };

  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          items.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A balanced but unparseable element is dropped, not guessed at.
        }
        start = -1;
      }
      continue;
    }
    // A `]` outside any element closes the array: the reply was complete.
    if (char === "]" && depth === 0) {
      return { items, truncated: false, missing: false };
    }
  }

  return { items, truncated: true, missing: false };
}
