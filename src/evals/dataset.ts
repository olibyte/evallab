import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evalCaseSchema, type EvalCase } from "@/src/schemas/eval-case";

export const DATASET_DIR = path.join(process.cwd(), "evals", "datasets");

export class InvalidEvalDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvalDataError";
  }
}

/**
 * Parses JSONL eval cases. Invalid rows fail loudly with their line number:
 * a silently dropped case would quietly change every downstream metric.
 */
export function parseEvalCases(contents: string, label: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();

  contents.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    const lineNumber = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new InvalidEvalDataError(`${label}:${lineNumber} is not valid JSON.`);
    }

    const parsed = evalCaseSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new InvalidEvalDataError(
        `${label}:${lineNumber} failed validation: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim(),
      );
    }
    if (seen.has(parsed.data.id)) {
      throw new InvalidEvalDataError(
        `${label}:${lineNumber} duplicates eval case id "${parsed.data.id}".`,
      );
    }
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  });

  return cases;
}

export function loadDatasetFile(fileName: string): EvalCase[] {
  const filePath = path.join(DATASET_DIR, fileName);
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return parseEvalCases(contents, fileName);
}

/** Loads the named datasets and rejects ids that collide across files. */
export function loadDatasets(fileNames: string[]): EvalCase[] {
  const all: EvalCase[] = [];
  const seen = new Map<string, string>();

  for (const fileName of fileNames) {
    for (const evalCase of loadDatasetFile(fileName)) {
      const existing = seen.get(evalCase.id);
      if (existing) {
        throw new InvalidEvalDataError(
          `Eval case id "${evalCase.id}" appears in both ${existing} and ${fileName}.`,
        );
      }
      seen.set(evalCase.id, fileName);
      all.push(evalCase);
    }
  }
  return all;
}

export function serialiseEvalCases(cases: EvalCase[]): string {
  return cases.map((evalCase) => JSON.stringify(evalCase)).join("\n") + "\n";
}

export function writeDatasetFile(fileName: string, cases: EvalCase[]): void {
  writeFileSync(
    path.join(DATASET_DIR, fileName),
    serialiseEvalCases(cases),
    "utf8",
  );
}
