import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `support-policy.md` is the authoritative source for support behaviour, so
 * it is read rather than duplicated in TypeScript. Next.js is told to trace
 * the file into the server bundle in `next.config.ts`.
 */
const POLICY_PATH = path.join(
  process.cwd(),
  "src",
  "domain",
  "support-policy.md",
);

let cached: string | undefined;

export function getSupportPolicy(): string {
  cached ??= readFileSync(POLICY_PATH, "utf8");
  return cached;
}
