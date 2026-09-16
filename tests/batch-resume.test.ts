import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BatchItemResult,
  BatchModelClient,
  BatchRequest,
} from "../src/ai/client/batch";
import { ModelError } from "../src/ai/client/errors";
import type { ModelRole } from "../src/ai/client/anthropic";
import { resetEnvCache } from "../src/config/env";
import { generateSyntheticCasesBatch, planBatches } from "../src/evals/generate-cases";
import { computeMetrics } from "../src/evals/metrics";
import { UsageTracker } from "../src/evals/paid-guard";
import { MemoryPendingRunStore } from "../src/evals/pending";
import { runExperiment } from "../src/evals/run-experiment";
import type { EvalCase } from "../src/schemas/eval-case";

const GENERATION = JSON.stringify({
  response: "I can't issue refunds myself, but I can escalate this for human review.",
  escalationRequired: true,
  escalationReason: "Requires human review.",
  policyReferences: ["Refunds"],
});

const RUBRIC = JSON.stringify({
  policyCompliance: { rationale: "Respects boundaries.", score: 5 },
  groundedness: { rationale: "Grounded in policy.", score: 5 },
  helpfulness: { rationale: "Clear next step.", score: 4 },
  tone: { rationale: "Professional.", score: 5 },
});

const cases: EvalCase[] = [1, 2, 3].map((n) => ({
  id: `r-${n}`,
  category: "refund",
  input: `Case ${n}: my renewal charged me.`,
  expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
  adversarial: false,
  difficulty: "medium",
  source: "human",
}));

const prompt = {
  id: "support-v1",
  version: 1,
  description: "d",
  createdAt: "2026-01-01",
  systemPrompt: "system",
};

/**
 * A batch service that outlives any one client: batches submitted by one
 * client can be collected by another, which is what resume relies on.
 */
class FakeBatchService {
  readonly batches = new Map<string, BatchRequest[]>();
  readonly submissions: string[] = [];
  readonly collections: string[] = [];
  /** Batch ids that time out on their next collect call. */
  readonly timeoutNext = new Set<string>();
  private counter = 0;

  client(role: ModelRole): BatchModelClient {
    return {
      role,
      model: `fake-${role}-model`,
      submit: async (requests) => {
        this.counter += 1;
        const id = `batch_${role}_${this.counter}`;
        this.batches.set(id, requests);
        this.submissions.push(id);
        return id;
      },
      collect: async (batchId) => {
        this.collections.push(batchId);
        if (this.timeoutNext.delete(batchId)) {
          throw new ModelError("timeout", `Batch ${batchId} did not finish within the timeout.`);
        }
        const requests = this.batches.get(batchId);
        if (!requests) throw new ModelError("api-error", `Unknown batch ${batchId}`);
        return requests.map(
          (request): BatchItemResult => ({
            customId: request.customId,
            text: request.system === "system" ? GENERATION : RUBRIC,
            inputTokens: 120,
            outputTokens: 60,
          }),
        );
      },
    };
  }
}

beforeEach(() => {
  process.env.ALLOW_PAID_EVALS = "true";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  resetEnvCache();
});

afterEach(() => {
  delete process.env.ALLOW_PAID_EVALS;
  delete process.env.ANTHROPIC_API_KEY;
  resetEnvCache();
});

function start(service: FakeBatchService, store: MemoryPendingRunStore) {
  return runExperiment({
    cases,
    datasetId: "human",
    datasetFiles: ["seed.jsonl"],
    split: "holdout",
    prompt,
    mode: "live",
    execution: "batch",
    createBatchClient: (role) => service.client(role),
    pendingStore: store,
  });
}

describe("batch run resume", () => {
  it("records the run and each batch id before polling, and clears it on success", async () => {
    const service = new FakeBatchService();
    const store = new MemoryPendingRunStore();
    const saved: string[] = [];
    const original = store.save.bind(store);
    store.save = (pending) => {
      saved.push(JSON.stringify(pending.stages));
      original(pending);
    };

    const result = await start(service, store);

    expect(saved[0]).toBe("{}");
    expect(saved).toContain('{"generation":"batch_generation_1"}');
    expect(saved).toContain('{"generation":"batch_generation_1","judge":"batch_judge_2"}');
    expect(store.list()).toEqual([]);
    expect(result.config.batchIds).toEqual(["batch_generation_1", "batch_judge_2"]);
  });

  it("collects a generation batch that outlived its poll without resubmitting it", async () => {
    const service = new FakeBatchService();
    const store = new MemoryPendingRunStore();
    // The generation batch is submitted, then the poll times out.
    service.timeoutNext.add("batch_generation_1");

    await expect(start(service, store)).rejects.toThrow(/timeout/);
    expect(store.list()).toHaveLength(1);

    const runId = store.list()[0]!;
    const pending = store.load(runId)!;
    expect(pending.stages).toEqual({ generation: "batch_generation_1" });
    expect(pending.cases.map((c) => c.id)).toEqual(["r-1", "r-2", "r-3"]);
    expect(pending.prompt.systemPrompt).toBe("system");

    // A fresh process with a fresh client finishes the run.
    const resumed = await runExperiment({
      cases: pending.cases,
      datasetId: pending.datasetId,
      datasetFiles: pending.datasetFiles,
      split: pending.split,
      prompt: pending.prompt,
      mode: "live",
      execution: "batch",
      judge: pending.judge,
      createBatchClient: (role) => service.client(role),
      pendingStore: store,
      resume: pending,
    });

    expect(resumed.runId).toBe(runId);
    expect(resumed.startedAt).toBe(pending.startedAt);
    expect(service.submissions).toEqual(["batch_generation_1", "batch_judge_2"]);
    expect(service.collections).toEqual([
      "batch_generation_1",
      "batch_generation_1",
      "batch_judge_2",
    ]);
    expect(resumed.cases.every((c) => c.rubric !== undefined)).toBe(true);
    expect(computeMetrics(resumed).rubric.coverage).toBe(1);
    expect(store.list()).toEqual([]);
  });

  it("collects a judge batch that outlived its poll without regenerating anything", async () => {
    const service = new FakeBatchService();
    const store = new MemoryPendingRunStore();
    service.timeoutNext.add("batch_judge_2");

    await expect(start(service, store)).rejects.toThrow(/timeout/);
    const pending = store.load(store.list()[0]!)!;
    expect(pending.stages).toEqual({ generation: "batch_generation_1", judge: "batch_judge_2" });

    const resumed = await runExperiment({
      cases: pending.cases,
      datasetId: pending.datasetId,
      datasetFiles: pending.datasetFiles,
      split: pending.split,
      prompt: pending.prompt,
      mode: "live",
      execution: "batch",
      createBatchClient: (role) => service.client(role),
      pendingStore: store,
      resume: pending,
    });

    expect(service.submissions).toEqual(["batch_generation_1", "batch_judge_2"]);
    expect(resumed.cases.every((c) => c.rubric !== undefined)).toBe(true);
    // Tokens are counted once per collected batch, not once per attempt.
    expect(resumed.usage.inputTokens).toBe(6 * 120);
  });
});

describe("generation batch resume", () => {
  it("collects a previously submitted generation batch instead of submitting again", async () => {
    const specs = planBatches({ ordinary: 4, edge: 0, adversarial: 0 }, 2);
    const service = new FakeBatchService();
    let submittedId: string | undefined;

    const client = service.client("generation");
    client.collect = async (batchId) => {
      const requests = service.batches.get(batchId)!;
      return requests.map((request) => ({
        customId: request.customId,
        text: JSON.stringify({
          cases: [1, 2].map((n) => ({
            input: `${request.customId} message ${n}`,
            expected: { escalationRequired: true, expectedBehaviour: "Escalates." },
          })),
        }),
        inputTokens: 10,
        outputTokens: 10,
      }));
    };

    const first = await generateSyntheticCasesBatch({
      client,
      specs,
      existing: [],
      usage: new UsageTracker(),
      onSubmitted: (id) => (submittedId = id),
    });
    expect(submittedId).toBe(first.batchId);

    const resumed = await generateSyntheticCasesBatch({
      client,
      specs,
      existing: [],
      usage: new UsageTracker(),
      resumeBatchId: first.batchId,
    });
    expect(service.submissions).toHaveLength(1);
    expect(resumed.accepted.map((c) => c.id)).toEqual(first.accepted.map((c) => c.id));
  });
});
