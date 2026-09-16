import { describe, expect, it } from "vitest";
import {
  InvalidEvalDataError,
  loadDatasets,
  parseEvalCases,
  serialiseEvalCases,
} from "../src/evals/dataset";

const VALID = JSON.stringify({
  id: "x-1",
  category: "refund",
  input: "Can I get a refund?",
  expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
  adversarial: false,
  difficulty: "easy",
  source: "human",
});

describe("parseEvalCases", () => {
  it("parses valid rows and ignores blank lines", () => {
    expect(parseEvalCases(`${VALID}\n\n`, "t.jsonl")).toHaveLength(1);
  });

  it("fails clearly on malformed JSON, naming the line", () => {
    expect(() => parseEvalCases(`${VALID}\n{ broken`, "t.jsonl")).toThrow(
      /t\.jsonl:2 is not valid JSON/,
    );
  });

  it("fails clearly on an invalid category", () => {
    const bad = VALID.replace('"refund"', '"nonsense"');
    expect(() => parseEvalCases(bad, "t.jsonl")).toThrow(InvalidEvalDataError);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseEvalCases(`${VALID}\n${VALID}`, "t.jsonl")).toThrow(
      /duplicates eval case id/,
    );
  });

  it("round-trips through serialisation", () => {
    const cases = parseEvalCases(VALID, "t.jsonl");
    expect(parseEvalCases(serialiseEvalCases(cases), "t.jsonl")).toEqual(cases);
  });
});

describe("authored datasets", () => {
  const cases = loadDatasets(["seed.jsonl", "adversarial.jsonl"]);

  it("loads without validation errors", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it("is entirely human-authored", () => {
    expect(cases.every((c) => c.source === "human")).toBe(true);
  });

  it("covers every category", () => {
    const categories = new Set(cases.map((c) => c.category));
    for (const category of [
      "refund",
      "duplicate-charge",
      "cancellation",
      "account",
      "ambiguous",
      "out-of-scope",
      "prompt-injection",
    ]) {
      expect(categories).toContain(category);
    }
  });

  it("includes adversarial cases at every difficulty", () => {
    const adversarial = cases.filter((c) => c.adversarial);
    expect(adversarial.length).toBeGreaterThanOrEqual(15);
    expect(new Set(cases.map((c) => c.difficulty))).toEqual(
      new Set(["easy", "medium", "hard"]),
    );
  });
});
