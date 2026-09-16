export const DATASET_PRESETS: Record<string, string[]> = {
  seed: ["seed.jsonl"],
  adversarial: ["adversarial.jsonl"],
  generated: ["generated.jsonl"],
  human: ["seed.jsonl", "adversarial.jsonl"],
  all: ["seed.jsonl", "adversarial.jsonl", "generated.jsonl"],
};

export function resolveDataset(
  name: string,
): { datasetId: string; files: string[] } {
  const files = DATASET_PRESETS[name];
  if (!files) {
    throw new Error(
      `Unknown dataset "${name}". Available: ${Object.keys(DATASET_PRESETS).join(", ")}.`,
    );
  }
  return { datasetId: name, files };
}
