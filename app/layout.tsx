import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EvalLab",
  description:
    "An evaluated AI support assistant: guardrails, rubric scoring and prompt experiments.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
