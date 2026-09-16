import Link from "next/link";
import { SupportConsole, type ExampleOption } from "./components/support-console";
import { getRuntimeMode, isPublicLiveInferenceEnabled } from "@/src/config/env";
import { respondFromFixture } from "@/src/replay/respond";
import { loadReplayFixtures } from "@/src/replay/store";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const mode = getRuntimeMode();
  const liveEnabled = isPublicLiveInferenceEnabled();

  const examples: ExampleOption[] = loadReplayFixtures().map((fixture) => ({
    id: fixture.id,
    title: fixture.title,
    message: fixture.message,
    result: respondFromFixture(fixture),
  }));

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">EvalLab</h1>
        <p className="text-lg text-gray-300">
          An AI support assistant you can inspect.
        </p>
        <p className="text-gray-400">
          Test the assistant, then see how its quality, safety and behaviour are
          measured.
        </p>
        <p className="text-xs text-gray-500">
          Runtime mode: <span className="font-mono">{mode}</span>
        </p>
      </header>

      <SupportConsole examples={examples} liveEnabled={liveEnabled} />

      <footer className="border-t border-gray-800 pt-6">
        <Link
          href="/engineering"
          className="text-sm text-gray-300 underline underline-offset-4 hover:text-gray-100"
        >
          See engineering details
        </Link>
      </footer>
    </main>
  );
}
