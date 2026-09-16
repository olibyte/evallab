import { describe, expect, it } from "vitest";
import { InvalidEvalDataError, loadDatasets } from "../src/evals/dataset";
import { DATASET_PRESETS } from "../src/evals/datasets-config";
import {
  assignSplits,
  DEV_FRACTION,
  emptyManifest,
  loadSplitManifest,
  selectRepresentative,
  selectSplit,
  summariseSplits,
} from "../src/evals/splits";
import type { EvalCase } from "../src/schemas/eval-case";

const committed = loadDatasets(DATASET_PRESETS.all!);
const manifest = loadSplitManifest();

function makeCase(id: string, adversarial: boolean, category: EvalCase["category"]): EvalCase {
  return {
    id,
    category,
    input: `Message for ${id}`,
    expected: { expectedBehaviour: "Behaves." },
    adversarial,
    difficulty: "medium",
    source: "human",
  };
}

describe("committed split manifest", () => {
  it("assigns every committed case", () => {
    const summary = summariseSplits(committed, manifest);
    expect(summary.unassigned).toBe(0);
  });

  it("is frozen: reassigning the committed corpus moves nothing", () => {
    // Assignments are frozen by design, so a from-scratch rebuild is NOT the
    // invariant: adding cases to a group re-sorts it and would reassign the
    // cases already in it. What must hold is that running `pnpm eval:splits`
    // again is a no-op.
    const { manifest: reassigned, assigned } = assignSplits(committed, manifest);
    expect(assigned).toEqual({});
    expect(reassigned.assignments).toEqual(manifest.assignments);
  });

  it("keeps each (category, adversarial) group near its dev fraction", () => {
    // Guards against hand edits that move a case between splits, which
    // freezing alone cannot catch.
    const groups = new Map<string, EvalCase[]>();
    for (const evalCase of committed) {
      const key = `${evalCase.category}|${evalCase.adversarial}`;
      groups.set(key, [...(groups.get(key) ?? []), evalCase]);
    }
    for (const [key, group] of groups) {
      const target = group[0]!.adversarial
        ? DEV_FRACTION.adversarial
        : DEV_FRACTION.ordinary;
      const dev = group.filter((c) => manifest.assignments[c.id] === "dev").length;
      // One case of slack per assignment pass the group has been through.
      const slack = 2 / group.length;
      expect(Math.abs(dev / group.length - target)).toBeLessThanOrEqual(slack);
    }
  });

  it("keeps adversarial cases out of heldout and ordinary cases out of adversarial-holdout", () => {
    for (const evalCase of committed) {
      const split = manifest.assignments[evalCase.id];
      if (evalCase.adversarial) expect(split).not.toBe("heldout");
      else expect(split).not.toBe("adversarial-holdout");
    }
  });

  it("holds out a meaningful share of both ordinary and adversarial cases", () => {
    const summary = summariseSplits(committed, manifest);
    expect(summary.heldout).toBeGreaterThanOrEqual(10);
    expect(summary["adversarial-holdout"]).toBeGreaterThanOrEqual(8);
    expect(summary.dev).toBeGreaterThanOrEqual(20);
  });

  it("is disjoint: dev and holdout never share a case", () => {
    const dev = new Set(selectSplit(committed, "dev", manifest).map((c) => c.id));
    const holdout = selectSplit(committed, "holdout", manifest);
    expect(holdout.length).toBeGreaterThan(0);
    expect(holdout.some((c) => dev.has(c.id))).toBe(false);
    expect(dev.size + holdout.length).toBe(committed.length);
  });
});

describe("assignSplits", () => {
  it("never changes an existing assignment", () => {
    const fixed = { ...emptyManifest(), assignments: { "x-1": "heldout" as const } };
    const cases = [makeCase("x-1", false, "refund"), makeCase("x-2", false, "refund")];
    const { manifest: updated, assigned } = assignSplits(cases, fixed);
    expect(updated.assignments["x-1"]).toBe("heldout");
    expect(Object.keys(assigned)).toEqual(["x-2"]);
  });

  it("is deterministic and independent of input order", () => {
    const cases = Array.from({ length: 10 }, (_, i) => makeCase(`c-${i}`, i % 3 === 0, "account"));
    const a = assignSplits(cases, emptyManifest()).manifest.assignments;
    const b = assignSplits([...cases].reverse(), emptyManifest()).manifest.assignments;
    expect(a).toEqual(b);
  });

  it("stratifies within a group so small groups land on both sides", () => {
    const cases = Array.from({ length: 5 }, (_, i) => makeCase(`s-${i}`, true, "prompt-injection"));
    const { manifest: updated } = assignSplits(cases, emptyManifest());
    const values = Object.values(updated.assignments);
    expect(values.filter((v) => v === "dev")).toHaveLength(2);
    expect(values.filter((v) => v === "adversarial-holdout")).toHaveLength(3);
  });
});

describe("selectSplit", () => {
  it("fails loudly when a case has no assignment", () => {
    expect(() =>
      selectSplit([makeCase("orphan-1", false, "refund")], "dev", emptyManifest()),
    ).toThrow(InvalidEvalDataError);
    expect(() =>
      selectSplit([makeCase("orphan-1", false, "refund")], "dev", emptyManifest()),
    ).toThrow(/pnpm eval:splits/);
  });

  it("returns everything for the all selector", () => {
    expect(selectSplit(committed, "all", manifest)).toHaveLength(committed.length);
  });
});

describe("selectRepresentative", () => {
  it("covers adversarial and ordinary cases when a mixed split is capped", () => {
    const holdout = selectSplit(committed, "holdout", manifest);
    const capped = selectRepresentative(holdout, 8);
    expect(capped).toHaveLength(8);
    expect(capped.some((c) => c.adversarial)).toBe(true);
    expect(capped.some((c) => !c.adversarial)).toBe(true);
    expect(new Set(capped.map((c) => c.category)).size).toBeGreaterThanOrEqual(5);
  });

  it("is deterministic and returns everything when the cap is not binding", () => {
    expect(selectRepresentative(committed, 8)).toEqual(selectRepresentative([...committed].reverse(), 8));
    expect(selectRepresentative(committed, 500)).toBe(committed);
    expect(selectRepresentative(committed)).toBe(committed);
  });
});
