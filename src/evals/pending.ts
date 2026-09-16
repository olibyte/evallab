import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { evalCaseSchema } from "@/src/schemas/eval-case";
import { RESULTS_DIR } from "./results";

export const PENDING_DIR = path.join(RESULTS_DIR, "pending");

/** Batch ids per stage of a batch run, recorded the moment each is submitted. */
export const batchStagesSchema = z.object({
  generation: z.string().optional(),
  generationRetry: z.string().optional(),
  judge: z.string().optional(),
});
export type BatchStages = z.infer<typeof batchStagesSchema>;

/**
 * Everything needed to finish a batch run after the submitting process has
 * gone away: the exact cases, the exact prompt text, and the batch ids. The
 * Anthropic API keeps batch results for 29 days, so a run whose poll timed
 * out, or whose process was killed, is collected rather than repeated.
 */
export const pendingRunSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  datasetId: z.string(),
  datasetFiles: z.array(z.string()),
  split: z.string(),
  maxCases: z.number().optional(),
  maxSpendUsd: z.number().optional(),
  judge: z.boolean(),
  promptSource: z.enum(["registry", "candidate"]),
  candidateId: z.string().optional(),
  prompt: z.object({
    id: z.string(),
    version: z.number(),
    description: z.string(),
    createdAt: z.string(),
    systemPrompt: z.string(),
  }),
  judgePromptId: z.string(),
  cases: z.array(evalCaseSchema),
  stages: batchStagesSchema,
});
export type PendingRun = z.infer<typeof pendingRunSchema>;

export interface PendingRunStore {
  save(pending: PendingRun): void;
  load(runId: string): PendingRun | undefined;
  remove(runId: string): void;
  list(): string[];
}

export class FilePendingRunStore implements PendingRunStore {
  constructor(private readonly dir = PENDING_DIR) {}

  private pathFor(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }

  save(pending: PendingRun): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(pending.runId), JSON.stringify(pending, null, 2) + "\n", "utf8");
  }

  load(runId: string): PendingRun | undefined {
    const filePath = this.pathFor(runId);
    if (!existsSync(filePath)) return undefined;
    const parsed = pendingRunSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
    if (!parsed.success) {
      throw new Error(
        `Pending run ${filePath} is not readable: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    return parsed.data;
  }

  remove(runId: string): void {
    rmSync(this.pathFor(runId), { force: true });
  }

  list(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.replace(/\.json$/, ""))
        .sort();
    } catch {
      return [];
    }
  }
}

export class MemoryPendingRunStore implements PendingRunStore {
  readonly saved = new Map<string, PendingRun>();
  save(pending: PendingRun): void {
    this.saved.set(pending.runId, structuredClone(pending));
  }
  load(runId: string): PendingRun | undefined {
    const found = this.saved.get(runId);
    return found ? structuredClone(found) : undefined;
  }
  remove(runId: string): void {
    this.saved.delete(runId);
  }
  list(): string[] {
    return [...this.saved.keys()].sort();
  }
}
