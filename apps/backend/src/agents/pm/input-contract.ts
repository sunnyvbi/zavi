
import { z } from "zod";

export const productPmInputSchema = z.object({
  agent_slug_filter: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/).optional(),
  lookback_days: z.number().int().min(1).max(90).default(14),
  max_dispatches: z.number().int().min(0).max(3).default(3),
  prior_run_id: z.string().uuid().optional(),
  answers: z.array(z.string().max(400)).max(5).optional(),
  clarification_response: z
    .object({
      request_id: z.string().uuid(),
      answers: z.array(
        z.object({
          question_id: z.string(),
          option_ids: z.array(z.string()).optional(),
          other_text: z.string().optional(),
          skipped: z.boolean().optional(),
        }),
      ),
      resolved: z
        .array(
          z.object({
            question_id: z.string(),
            question: z.string(),
            answer: z.string().nullable(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type ProductPmInput = z.infer<typeof productPmInputSchema>;
