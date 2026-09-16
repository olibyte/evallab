import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3000" },
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://127.0.0.1:3000/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // The E2E suite covers Replay Mode, so it must not depend on whatever
    // happens to be in a developer's .env.
    env: {
      ANTHROPIC_API_KEY: "",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LIVE_DEMO_ENABLED: "false",
      ALLOW_PAID_EVALS: "false",
    },
  },
});
