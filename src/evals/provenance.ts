import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { EvalCase } from "@/src/schemas/eval-case";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Fingerprint of the exact cases a run covered: ids, inputs and expectations
 * in id order. Two runs with the same fingerprint saw the same test, whatever
 * the dataset was called at the time.
 */
export function datasetFingerprint(cases: EvalCase[]): string {
  const canonical = [...cases]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) =>
      JSON.stringify({
        id: c.id,
        input: c.input,
        expected: c.expected,
        adversarial: c.adversarial,
        category: c.category,
      }),
    )
    .join("\n");
  return hashText(canonical);
}

/** Current commit, when the run happens inside a git checkout. */
export function currentGitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}
