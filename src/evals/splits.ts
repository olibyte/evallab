import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { EvalCase } from "@/src/schemas/eval-case";
import { DATASET_DIR, InvalidEvalDataError } from "./dataset";
import { hashText } from "./provenance";

/**
 * Dataset splits.
 *
 *   dev                  the only cases prompt optimization may ever see
 *   heldout              ordinary cases reserved for the final benchmark
 *   adversarial-holdout  adversarial cases reserved for the final benchmark
 *
 * Assignments live in evals/datasets/splits.json and are frozen: a case is
 * assigned once, deterministically, and never moves. New cases are assigned
 * by `pnpm eval:splits`, which stratifies within (category, adversarial)
 * groups in sha256(id) order so the choice is reproducible and not tied to
 * authoring order.
 */
export const SPLITS = ["dev", "heldout", "adversarial-holdout"] as const;
export type Split = (typeof SPLITS)[number];

/** Selectors accepted by --split. "holdout" is everything optimization never saw. */
export const SPLIT_SELECTORS = [
  "dev",
  "heldout",
  "adversarial-holdout",
  "holdout",
  "all",
] as const;
export type SplitSelector = (typeof SPLIT_SELECTORS)[number];

export const SPLITS_PATH = path.join(DATASET_DIR, "splits.json");

/** Share of each group that goes to dev; the remainder is held out. */
export const DEV_FRACTION = { ordinary: 0.6, adversarial: 0.5 } as const;

export const splitManifestSchema = z.object({
  version: z.literal(1),
  method: z.string(),
  assignments: z.record(z.string(), z.enum(SPLITS)),
});

export type SplitManifest = z.infer<typeof splitManifestSchema>;

export function emptyManifest(): SplitManifest {
  return {
    version: 1,
    method:
      "Frozen once assigned. New cases: within each (category, adversarial) group, order by sha256(id); the first 60% (ordinary) or 50% (adversarial) go to dev, the rest to heldout or adversarial-holdout.",
    assignments: {},
  };
}

export function loadSplitManifest(filePath = SPLITS_PATH): SplitManifest {
  if (!existsSync(filePath)) return emptyManifest();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new InvalidEvalDataError(`${filePath} is not valid JSON.`);
  }
  const parsed = splitManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidEvalDataError(
      `${filePath} failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

export function saveSplitManifest(
  manifest: SplitManifest,
  filePath = SPLITS_PATH,
): void {
  const sorted: SplitManifest = {
    ...manifest,
    assignments: Object.fromEntries(
      Object.entries(manifest.assignments).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  writeFileSync(filePath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

/**
 * Assigns every case that has no split yet. Existing assignments are never
 * changed. Returns the new manifest and the ids that were assigned.
 */
export function assignSplits(
  cases: EvalCase[],
  manifest: SplitManifest,
): { manifest: SplitManifest; assigned: Record<string, Split> } {
  const assignments = { ...manifest.assignments };
  const assigned: Record<string, Split> = {};

  const groups = new Map<string, EvalCase[]>();
  for (const evalCase of cases) {
    if (assignments[evalCase.id]) continue;
    const key = `${evalCase.category}|${evalCase.adversarial}`;
    const group = groups.get(key) ?? [];
    group.push(evalCase);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) =>
      hashText(a.id).localeCompare(hashText(b.id)),
    );
    const adversarial = ordered[0]!.adversarial;
    const fraction = adversarial ? DEV_FRACTION.adversarial : DEV_FRACTION.ordinary;
    const holdout: Split = adversarial ? "adversarial-holdout" : "heldout";

    ordered.forEach((evalCase, index) => {
      // Interleave so small groups still land on both sides.
      const devSoFar = Math.floor((index + 1) * fraction);
      const devBefore = Math.floor(index * fraction);
      const split: Split = devSoFar > devBefore ? "dev" : holdout;
      assignments[evalCase.id] = split;
      assigned[evalCase.id] = split;
    });
  }

  return { manifest: { ...manifest, assignments }, assigned };
}

export function isSplitSelector(value: string): value is SplitSelector {
  return (SPLIT_SELECTORS as readonly string[]).includes(value);
}

export function splitsFor(selector: SplitSelector): readonly Split[] {
  switch (selector) {
    case "all":
      return SPLITS;
    case "holdout":
      return ["heldout", "adversarial-holdout"];
    default:
      return [selector];
  }
}

/**
 * Filters cases to a split. Every case must have an assignment: an
 * unassigned case would otherwise silently fall out of every split, or
 * silently land in one the optimizer is allowed to see.
 */
export function selectSplit(
  cases: EvalCase[],
  selector: SplitSelector,
  manifest: SplitManifest = loadSplitManifest(),
): EvalCase[] {
  const missing = cases.filter((c) => !manifest.assignments[c.id]).map((c) => c.id);
  if (missing.length > 0) {
    throw new InvalidEvalDataError(
      `${missing.length} eval case(s) have no split assignment (first: ${missing.slice(0, 3).join(", ")}). Run \`pnpm eval:splits\` to assign them.`,
    );
  }
  const wanted = new Set(splitsFor(selector));
  return cases.filter((c) => wanted.has(manifest.assignments[c.id]!));
}

export function splitOf(caseId: string, manifest: SplitManifest): Split | undefined {
  return manifest.assignments[caseId];
}

export function summariseSplits(
  cases: EvalCase[],
  manifest: SplitManifest,
): Record<Split | "unassigned", number> {
  const summary: Record<Split | "unassigned", number> = {
    dev: 0,
    heldout: 0,
    "adversarial-holdout": 0,
    unassigned: 0,
  };
  for (const evalCase of cases) {
    summary[manifest.assignments[evalCase.id] ?? "unassigned"] += 1;
  }
  return summary;
}

/**
 * Deterministic, stratified subset for capped runs. Round-robins across
 * (category, adversarial) groups in id order, so `--max-cases 8` on a mixed
 * split still covers ordinary and adversarial cases rather than whichever
 * file happened to be loaded first.
 */
export function selectRepresentative(cases: EvalCase[], limit?: number): EvalCase[] {
  if (limit === undefined || limit >= cases.length) return cases;
  const groups = new Map<string, EvalCase[]>();
  for (const evalCase of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${evalCase.adversarial}|${evalCase.category}`;
    const group = groups.get(key) ?? [];
    group.push(evalCase);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  const selected: EvalCase[] = [];
  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;
    for (const key of keys) {
      const candidate = groups.get(key)?.[round];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}
