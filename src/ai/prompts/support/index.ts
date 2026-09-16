import type { PromptDefinition } from "../types";
import { supportPromptV1 } from "./v1";

export { supportPromptV1 };

/** Every support prompt version ever shipped. Entries are never removed. */
export const SUPPORT_PROMPTS: readonly PromptDefinition[] = [supportPromptV1];

/**
 * The production prompt. Promotion is always an explicit source change here.
 */
export const ACTIVE_SUPPORT_PROMPT: PromptDefinition = supportPromptV1;

export function getSupportPromptById(id: string): PromptDefinition | undefined {
  return SUPPORT_PROMPTS.find((prompt) => prompt.id === id);
}
