export type Args = {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
};

/** Parses `--key value`, `--key=value` and `--flag`. */
export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      i += 1;
    } else {
      flags.add(body);
    }
  }
  return { flags, values, positional };
}

export function numberArg(args: Args, key: string): number | undefined {
  const raw = args.values.get(key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number, received "${raw}".`);
  }
  return parsed;
}

export function listArg(args: Args, key: string): string[] | undefined {
  const raw = args.values.get(key);
  return raw === undefined ? undefined : raw.split(",").map((s) => s.trim());
}
