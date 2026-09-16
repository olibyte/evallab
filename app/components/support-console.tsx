"use client";

import { useState } from "react";
import type { RespondResult } from "@/src/ai/pipeline/types";
import { ResultView } from "./result-view";

export type ExampleOption = {
  id: string;
  title: string;
  message: string;
  result: RespondResult;
};

type Props = {
  examples: ExampleOption[];
  liveEnabled: boolean;
};

export function SupportConsole({ examples, liveEnabled }: Props) {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<RespondResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function showExample(example: ExampleOption) {
    setMessage(example.message);
    setResult(example.result);
    setNotice(
      "This is a stored replay of an authored example, not a live model call.",
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (message.trim() === "" || pending) return;

    setPending(true);
    setNotice(null);
    setResult(null);
    try {
      const response = await fetch("/api/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setNotice(
          payload?.error?.message ??
            "The request could not be completed. Try a replay example instead.",
        );
        return;
      }
      setResult(payload as RespondResult);
    } catch {
      setNotice("The request could not be completed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="message" className="sr-only">
          Ask a support question
        </label>
        <textarea
          id="message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Ask a support question..."
          className="w-full resize-y rounded-lg border border-gray-800 bg-gray-950 p-3 text-gray-100 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || message.trim() === ""}
            className="rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Sending..." : "Send"}
          </button>
          {!liveEnabled && (
            <p className="text-xs text-gray-500">
              Live inference is currently disabled. The examples below are
              stored replays and work without an API key.
            </p>
          )}
        </div>
      </form>

      <div>
        <h2 className="mb-3 text-sm font-medium text-gray-400">
          Example prompts
        </h2>
        <div className="flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example.id}
              type="button"
              onClick={() => showExample(example)}
              className="rounded-full border border-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-600 hover:text-gray-100"
            >
              {example.title}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <p className="rounded-md border border-gray-800 bg-gray-950 p-3 text-sm text-gray-400">
          {notice}
        </p>
      )}

      {result && <ResultView result={result} />}
    </div>
  );
}
