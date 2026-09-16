/**
 * Wraps untrusted text (customer messages, responses under evaluation) in a
 * named delimiter so a prompt can refer to it, and neutralises any attempt by
 * that text to close or reopen the delimiter itself. Without this, a
 * response under test could end its own block early and append text that
 * reads as instructions to the judge.
 */
export function wrapUntrusted(tag: string, content: string): string {
  return [`<${tag}>`, escapeDelimiters(content), `</${tag}>`].join("\n");
}

/**
 * Rewrites anything that looks like a closing or opening tag for the
 * delimiters used in prompts. The replacement is visibly escaped rather
 * than removed so the judge can still see that the attempt was made.
 */
export function escapeDelimiters(content: string): string {
  return content.replace(
    /<(\/?)\s*(customer_message|assistant_response|current_system_prompt|observed_failures|rubric|policy)\b/gi,
    (_match, slash: string, name: string) => `&lt;${slash}${name}`,
  );
}
