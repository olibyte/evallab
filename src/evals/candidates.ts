import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CANDIDATES_DIR = path.join(process.cwd(), "evals", "candidates");

export const candidateSchema = z.object({
  candidateId: z.string().min(1),
  parentPromptId: z.string().min(1),
  optimizationRunId: z.string().min(1),
  description: z.string().min(1),
  createdAt: z.string().min(1),
  systemPrompt: z.string().min(1),
});

export type PromptCandidate = z.infer<typeof candidateSchema>;

export function saveCandidate(candidate: PromptCandidate): string {
  const dir = path.join(CANDIDATES_DIR, candidate.optimizationRunId);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${candidate.candidateId}.json`);
  writeFileSync(filePath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
  return filePath;
}

function candidateFiles(): string[] {
  try {
    return readdirSync(CANDIDATES_DIR, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(CANDIDATES_DIR, entry));
  } catch {
    return [];
  }
}

export function listCandidates(): PromptCandidate[] {
  return candidateFiles()
    .map((filePath) => {
      const parsed = candidateSchema.safeParse(
        JSON.parse(readFileSync(filePath, "utf8")),
      );
      if (!parsed.success) {
        console.warn(`[evallab] ignoring invalid candidate file ${filePath}`);
        return undefined;
      }
      return parsed.data;
    })
    .filter((candidate): candidate is PromptCandidate => candidate !== undefined);
}

export function loadCandidate(candidateId: string): PromptCandidate {
  const candidate = listCandidates().find((c) => c.candidateId === candidateId);
  if (!candidate) throw new Error(`Unknown prompt candidate "${candidateId}".`);
  return candidate;
}
