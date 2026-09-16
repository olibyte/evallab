import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { replayFixtureSchema, type ReplayFixture } from "./schema";

const REPLAY_DIR = path.join(process.cwd(), "data", "replays");

let cached: ReplayFixture[] | undefined;

/**
 * Loads replay fixtures from disk. Corrupt fixtures are reported and skipped
 * rather than crashing the application or being silently accepted.
 */
export function loadReplayFixtures(): ReplayFixture[] {
  if (cached) return cached;

  let files: string[];
  try {
    files = readdirSync(REPLAY_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    cached = [];
    return cached;
  }

  const fixtures: ReplayFixture[] = [];
  for (const file of files.sort()) {
    const raw = readFileSync(path.join(REPLAY_DIR, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[evallab] replay fixture is not valid JSON: ${file}`);
      continue;
    }
    const result = replayFixtureSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`[evallab] replay fixture failed validation: ${file}`);
      continue;
    }
    fixtures.push(result.data);
  }

  cached = fixtures;
  return cached;
}

export function findReplayFixture(id: string): ReplayFixture | undefined {
  return loadReplayFixtures().find((fixture) => fixture.id === id);
}

export function resetReplayCache(): void {
  cached = undefined;
}
