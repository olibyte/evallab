import type { PromptDefinition } from "../types";
import { caseGeneratorPromptV1 } from "./case-generator-v1";
import { caseGeneratorPromptV2 } from "./case-generator-v2";
import { rubricJudgePromptV1 } from "./rubric-v1";
import { rubricJudgePromptV2 } from "./rubric-v2";

export { rubricJudgePromptV1, rubricJudgePromptV2 };
export { caseGeneratorPromptV1, caseGeneratorPromptV2 };
export {
  ACTIVE_CASE_GENERATOR_PROMPT,
  CASE_GENERATOR_PROMPTS,
} from "./case-generators";

/** Every rubric judge prompt ever shipped. Entries are never removed. */
export const JUDGE_PROMPTS: readonly PromptDefinition[] = [
  rubricJudgePromptV1,
  rubricJudgePromptV2,
];

/**
 * The judge prompt in use. Changing it changes what every score means, so
 * every run record carries the judge prompt id and hash.
 */
export const ACTIVE_JUDGE_PROMPT: PromptDefinition = rubricJudgePromptV2;
