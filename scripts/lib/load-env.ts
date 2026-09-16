import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader for CLI scripts (Next.js loads .env itself for the
 * app). Existing process environment always wins, and nothing is logged.
 */
export function loadDotEnv(file = ".env"): void {
  const filePath = path.join(process.cwd(), file);
  if (!existsSync(filePath)) return;

  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
