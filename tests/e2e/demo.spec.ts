import { expect, test } from "@playwright/test";

test("health endpoint reports replay-only mode without credentials", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.mode).toBe("replay-only");
  expect(payload.capabilities.publicLiveInference).toBe(false);
});

test("homepage offers the six example prompts", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "EvalLab", level: 1 }),
  ).toBeVisible();
  for (const name of [
    "Ordinary refund request",
    "Possible duplicate charge",
    "Cancellation question",
    "Ambiguous request",
    "Prompt injection attempt",
    "Request beyond assistant authority",
  ]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
});

test("a normal support request replays and is labelled Replay", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ordinary refund request" }).click();

  await expect(page.getByText("Replay", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assistant response" })).toBeVisible();
  await expect(page.getByText("14 days").first()).toBeVisible();
  await expect(page.getByText("Automated quality score")).toBeVisible();
  await expect(page.getByText(/Evaluation unavailable/)).toBeVisible();
});

test("a prompt-injection request is flagged but still answered", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Prompt injection attempt" }).click();

  await expect(page.getByText(/detected \(high risk\)/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assistant response" })).toBeVisible();
  await expect(page.getByText("Unauthorized action claim")).toBeVisible();
});

test("replay mode reports that live inference is unavailable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Live inference is currently disabled/)).toBeVisible();

  await page.getByLabel("Ask a support question").fill("Can I get a refund?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Live inference is disabled/)).toBeVisible();
});

test("engineering view renders without a paid model call", async ({ page }) => {
  await page.goto("/engineering");
  for (const heading of [
    "Overview",
    "Evals",
    "Experiments",
    "Failures",
    "Prompts",
    "Guardrails",
    "Observability",
  ]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(page.getByText("support-v1")).toBeVisible();
  await expect(page.getByText(/No benchmark snapshot has been produced yet/)).toBeVisible();
});
