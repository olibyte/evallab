import { getRuntimeMode } from "@/src/config/env";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const mode = getRuntimeMode();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">EvalLab</h1>
      <p className="text-gray-400">
        A support assistant built with guardrails, structured output and
        rubric-based evaluation.
      </p>
      <p className="text-sm text-gray-500">
        Runtime mode: <span className="font-mono">{mode}</span>
      </p>
    </main>
  );
}
