import { z } from "zod";

/** Structured output contract for the generation model. */
export const supportResponseSchema = z.object({
  response: z.string().min(1),
  escalationRequired: z.boolean(),
  escalationReason: z.string().min(1).optional(),
  policyReferences: z.array(z.string().min(1)),
});

export type SupportResponse = z.infer<typeof supportResponseSchema>;

export const MAX_MESSAGE_LENGTH = 2000;

/** Public API request contract. */
export const respondRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

export type RespondRequest = z.infer<typeof respondRequestSchema>;
