import type { PromptDefinition } from "../types";
import { caseGeneratorPromptV1 } from "./case-generator-v1";
import { caseGeneratorPromptV2 } from "./case-generator-v2";

/** Every case-generator prompt ever shipped. Entries are never removed. */
export const CASE_GENERATOR_PROMPTS: readonly PromptDefinition[] = [
  caseGeneratorPromptV1,
  caseGeneratorPromptV2,
];

/**
 * The case-generator prompt in use. Generation runs record its id, so a
 * corpus can always be traced back to the contract that produced it.
 */
export const ACTIVE_CASE_GENERATOR_PROMPT: PromptDefinition =
  caseGeneratorPromptV2;
