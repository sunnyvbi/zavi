import { z } from "zod";

export const researchInputSchema = z.object({
  ask: z.string().min(1).max(4000),
  clarification_answers: z.array(z.string().max(2000)).max(4).optional(),
  parent_run_id: z.string().max(100).optional(),
});

export type ResearchInput = z.infer<typeof researchInputSchema>;
